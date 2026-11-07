"use strict";

const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { randomBytes, createHmac, timingSafeEqual } = require("node:crypto");
const { ensureStateDir } = require("./state");

const SUPPORTED_PLATFORMS = Object.freeze(["darwin", "linux", "win32"]);
const supportsPrivateChannel = platform => SUPPORTED_PLATFORMS.includes(platform);
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const failure = () => new Error("The private local channel could not authenticate.");
function proof(secret, scope, role, nonce, challenge) {
  return createHmac("sha256", secret).update(JSON.stringify(["shapes-private-channel", 1, scope, role, nonce, challenge])).digest("hex");
}
function equal(actual, expected) { return hex(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }

// A fresh nonce/challenge binds both peers and the independently supplied scope.
// No credential is sent across the pipe. Windows pipe names alone are not ACLs.
// The caller receives a paused authenticated socket and installs its own framing.
function authenticate(socket, { secret, scope, client = false, timeoutMs = 2000 }) {
  if (!hex(secret) || typeof scope !== "string" || !scope || scope.length > 256) { socket.destroy(); return Promise.reject(failure()); }
  return new Promise((resolve, reject) => {
    let buffer = "", nonce = client ? randomBytes(32).toString("hex") : null, challenge, phase = 0, settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(ok) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.pause();
      socket.removeListener("data", data); socket.removeListener("error", failed); socket.removeListener("close", failed);
      socket.removeListener("connect", connected);
      if (ok) resolve(socket);
      else { socket.destroy(); reject(failure()); }
    }
    function failed() { finish(false); }
    function write(value) { socket.write(JSON.stringify({ version: 1, ...value }) + "\n"); }
    function connected() { write({ nonce }); }
    function data(chunk) {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 512) return finish(false);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      // Neither peer may pipeline application bytes before mutual readiness.
      if (newline !== buffer.length - 1) return finish(false);
      let message;
      try { message = JSON.parse(buffer.slice(0, newline)); } catch { return finish(false); }
      buffer = "";
      if (!message || message.version !== 1) return finish(false);
      if (client && phase === 0) {
        if (Object.keys(message).length !== 3 || !hex(message.challenge)
            || !equal(message.proof, proof(secret, scope, "server", nonce, message.challenge))) return finish(false);
        challenge = message.challenge; phase = 1;
        write({ proof: proof(secret, scope, "client", nonce, challenge) });
      } else if (client) {
        if (Object.keys(message).length !== 2 || message.ready !== true) return finish(false);
        finish(true);
      } else if (phase === 0) {
        if (Object.keys(message).length !== 2 || !hex(message.nonce)) return finish(false);
        nonce = message.nonce; challenge = randomBytes(32).toString("hex"); phase = 1;
        write({ challenge, proof: proof(secret, scope, "server", nonce, challenge) });
      } else {
        if (Object.keys(message).length !== 2 || !equal(message.proof, proof(secret, scope, "client", nonce, challenge))) return finish(false);
        write({ ready: true }); finish(true);
      }
    }
    socket.on("data", data); socket.once("error", failed); socket.once("close", failed);
    if (client) { if (socket.connecting) socket.once("connect", connected); else connected(); }
    socket.resume();
  });
}

function readCredential(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64
      || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw failure();
  const descriptor = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(65), count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const secret = bytes.subarray(0, count).toString("utf8");
    if (!hex(secret)) throw failure();
    return secret;
  } finally { fs.closeSync(descriptor); }
}

async function connectPrivateChannel({ endpoint, credentialFile, scope, timeoutMs }) {
  if (typeof scope !== "string" || !scope || scope.length > 256) throw failure();
  const secret = readCredential(credentialFile);
  const socket = net.createConnection(endpoint);
  return authenticate(socket, { secret, scope, client: true, timeoutMs });
}

async function listenPrivateChannel({ scope, onConnection, platform = process.platform, timeoutMs = 2000 }) {
  if (!supportsPrivateChannel(platform) || typeof onConnection !== "function"
      || typeof scope !== "string" || !scope || scope.length > 256) throw failure();
  // Unix paths must stay below sockaddr limits. Windows credentials inherit the
  // existing account/SYSTEM-only state directory ACL, never a public temp ACL.
  const directory = fs.mkdtempSync(platform === "win32"
    ? path.join(ensureStateDir(), "private-channel-") : "/tmp/shapes-native-tools-");
  const endpoint = platform === "win32" ? `\\\\.\\pipe\\shapes-inc-private-${randomBytes(24).toString("hex")}` : path.join(directory, "broker.sock");
  const credentialFile = path.join(directory, "channel.key"), secret = randomBytes(32).toString("hex");
  const sockets = new Set();
  let closing = false, disposal;
  const server = net.createServer(socket => {
    if (closing || sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    void authenticate(socket, { secret, scope, timeoutMs }).then(() => {
      if (closing) { socket.destroy(); return; }
      try { onConnection(socket); socket.resume(); } catch { socket.destroy(); }
    }).catch(() => socket.destroy());
  });
  try {
    if (platform !== "win32") fs.chmodSync(directory, 0o700);
    fs.writeFileSync(credentialFile, secret, { flag: "wx", mode: 0o600 });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    if (platform !== "win32") fs.chmodSync(endpoint, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    server.close(); fs.rmSync(directory, { recursive: true, force: true }); throw error;
  }
  return {
    directory, endpoint, credentialFile,
    close() {
      if (!disposal) {
        closing = true;
        disposal = (async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise(resolve => server.close(resolve));
          fs.rmSync(directory, { recursive: true, force: true });
        })();
      }
      return disposal;
    },
  };
}

module.exports = { SUPPORTED_PLATFORMS, supportsPrivateChannel, listenPrivateChannel, connectPrivateChannel, authenticate };
