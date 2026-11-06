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
function createEmbeddedHost({ controller, token, version, endpoint, createServer = net.createServer, onIdle, idleTimeoutMs = 1000 }) {
  let active = null, closing = false, idleTimer = null, disposal = null;
  const sockets = new Set();
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!onIdle || closing || active || sockets.size) return;
    idleTimer = setTimeout(async () => {
      idleTimer = null;
      if (closing || active || sockets.size) return;
      // A startup-resumed daemon has device authority, but deliberately no
      // foreground account. Its public status remains private/disconnected.
      // Recheck after daemon exit so revoked credentials do not leave an idle
      // host behind. This timer never restarts a stopped runtime.
      if (controller.backgroundActive?.()) { scheduleIdle(); return; }
      let status;
      try { status = await controller.status(); } catch { return; }
      if (closing || active || sockets.size || !["disconnected", "paused"].includes(status?.state)) return;
      // Match macOS's idle-host retirement. This does not change saved consent;
      // the registered scheduler entry can start a new controller on demand.
      let error;
      try { await dispose(); } catch (failure) { error = failure; }
      try { await onIdle(error); } catch { /* caller owns exit reporting */ }
    }, idleTimeoutMs);
  }
  const server = createServer((socket) => {
    if (closing || sockets.size >= 4) { socket.destroy(); return; }
    clearTimeout(idleTimer);
    sockets.add(socket); socket.on("error", () => {});
    let bytes = Buffer.alloc(0), authenticated = false, protocol, nonce, challenge;
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.once("close", () => { clearTimeout(timer); sockets.delete(socket); scheduleIdle(); });
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
      protocol = serveEmbeddedProtocol({ input: socket, output: socket, controller: facade,
        onClose: () => { if (active === socket) active = null; socket.destroy(); scheduleIdle(); } });
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
    await controller.resumeSavedConnection?.();
    scheduleIdle();
  }
  function dispose() {
    if (disposal) return disposal;
    closing = true; clearTimeout(idleTimer);
    for (const socket of sockets) socket.destroy();
    disposal = (async () => {
      const stopped = await Promise.allSettled([Promise.resolve().then(() => controller.dispose()), new Promise((resolve) => server.close(resolve))]);
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return disposal;
  }
  return { start, dispose, server };
}

module.exports = { createEmbeddedHost, hostConfiguration };
