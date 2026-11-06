"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { serveEmbeddedProtocol } = require("./embedded-protocol");

function hostConfiguration(directory) {
  const identity = crypto.createHash("sha256").update(path.resolve(directory).toLowerCase()).digest("hex").slice(0, 32);
  const file = path.join(directory, "embedded-host-auth.json");
  try { fs.writeFileSync(file, JSON.stringify({ token: crypto.randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) throw new Error("Invalid host configuration");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(saved.token)) throw new Error("Invalid host configuration");
  return { token: saved.token, endpoint: `\\\\.\\pipe\\shapes-inc-computer-${identity}` };
}

// One durable controller, one foreground attachment. A disconnected document
// detaches; only explicit host disposal stops an established connection.
function createEmbeddedHost({ controller, token, version, endpoint, createServer = net.createServer }) {
  let active = null, closing = false;
  const sockets = new Set();
  const server = createServer((socket) => {
    if (closing || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket); socket.on("error", () => {});
    let bytes = Buffer.alloc(0), authenticated = false, protocol, nonce, challenge;
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); });
    function authenticate(chunk) {
      if (authenticated) return;
      if (bytes.length + chunk.length > 512) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      let hello;
      try { hello = JSON.parse(bytes.subarray(0, newline).toString("utf8")); } catch { socket.destroy(); return; }
      if (!nonce) {
        if (hello?.version !== 1 || typeof hello.nonce !== "string" || !/^[a-f0-9]{64}$/.test(hello.nonce) || Object.keys(hello).length !== 2) { socket.destroy(); return; }
        nonce = hello.nonce; challenge = crypto.randomBytes(32).toString("hex");
        const proof = crypto.createHmac("sha256", token).update(`server\n${nonce}\n${challenge}\n${version}`).digest("hex");
        bytes = bytes.subarray(newline + 1);
        socket.write(JSON.stringify({ version: 1, challenge, proof, hostVersion: version }) + "\n");
        // The peer must wait for this server proof before sending its own.
        if (bytes.length) socket.destroy();
        return;
      }
      const expected = crypto.createHmac("sha256", token).update(`client\n${nonce}\n${challenge}\n${version}`).digest("hex");
      if (hello?.version !== 1 || typeof hello.proof !== "string" || !/^[a-f0-9]{64}$/.test(hello.proof)
          || Object.keys(hello).length !== 2 || !crypto.timingSafeEqual(Buffer.from(hello.proof), Buffer.from(expected))) { socket.destroy(); return; }
      if (active) { socket.end(JSON.stringify({ version: 1, error: { code: "busy" } }) + "\n"); return; }
      authenticated = true; clearTimeout(timer); socket.removeListener("data", authenticate);
      active = socket;
      const facade = Object.fromEntries(Object.entries(controller).map(([key, method]) => [key, typeof method === "function" ? method.bind(controller) : method]));
      facade.dispose = () => controller.detach();
      protocol = serveEmbeddedProtocol({ input: socket, output: socket, controller: facade, onClose: () => { if (active === socket) active = null; socket.destroy(); } });
      socket.once("close", () => { void protocol.close(); });
      socket.write(JSON.stringify({ version: 1, ready: true, hostVersion: version }) + "\n");
      const remainder = bytes.subarray(newline + 1); bytes = Buffer.alloc(0);
      if (remainder.length) socket.emit("data", remainder);
    }
    socket.on("data", authenticate);
  });
  async function start() {
    await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen(endpoint, () => { server.removeListener("error", reject); resolve(); });
    });
  }
  async function dispose() {
    if (closing) return;
    closing = true;
    for (const socket of sockets) socket.destroy();
    await controller.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
  return { start, dispose, server };
}

module.exports = { createEmbeddedHost, hostConfiguration };
