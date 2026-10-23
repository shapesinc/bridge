"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { once, EventEmitter } = require("node:events");
const { Mux, WINDOW } = require("../src/browser-route/mux");
const { connectWebSocket, relayUrl } = require("../src/browser-route/ws-client");
const { startDevice, publicLookup } = require("../src/browser-route/device");
const { isPublicAddress } = require("../src/browser-route/addresses");
const { startBrowserRoute } = require("../src/browser-route");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; };
const collect = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.on("end", () => resolve(Buffer.concat(chunks)));
  stream.on("error", reject);
});
async function until(check, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await tick(5);
  }
}

// --- The server side of RFC 6455, written here so the client is checked against an independent peer. ---

function serverFrame(opcode, payload = Buffer.alloc(0), { fin = true, length = payload.length } = {}) {
  const header = length > 0xffff ? 10 : length > 125 ? 4 : 2;
  const bytes = Buffer.alloc(header + payload.length);
  bytes[0] = (fin ? 0x80 : 0) | opcode;
  if (header === 10) { bytes[1] = 127; bytes.writeUInt32BE(Math.floor(length / 2 ** 32), 2); bytes.writeUInt32BE(length >>> 0, 6); }
  else if (header === 4) { bytes[1] = 126; bytes.writeUInt16BE(length, 2); }
  else bytes[1] = length;
  payload.copy(bytes, header);
  return bytes;
}

/** One client connection, server side: reads masked frames ("frame" events), writes unmasked ones. */
class Peer extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.authorization = req.headers.authorization;
    this.unmasked = 0;
    let buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = buffer.readUInt32BE(6); offset = 10; }
        const masked = (buffer[1] & 0x80) !== 0;
        if (!masked) this.unmasked++;
        const start = offset + (masked ? 4 : 0);
        if (buffer.length < start + length) return;
        const payload = Buffer.from(buffer.subarray(start, start + length));
        if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[offset + (i & 3)];
        const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f;
        buffer = buffer.subarray(start + length);
        this.emit("frame", { fin, opcode, payload });
        // Like a real server: the client's close frame ends the TCP connection.
        if (opcode === 0x8) this.socket.end();
      }
    });
  }
  send(opcode, payload, options) { this.socket.write(serverFrame(opcode, payload, options)); }
  close(code, reason = "") {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.send(0x8, payload);
  }
}

/** A tiny WebSocket server. `answer(req, socket)` may refuse the upgrade by writing its own response. */
async function wsServer({ onConnection = () => {}, answer, accept = (key) => crypto.createHash("sha1").update(key + GUID).digest("base64") } = {}) {
  const server = http.createServer();
  const peers = [], attempts = [];
  server.on("upgrade", (req, socket) => {
    attempts.push(req.headers.authorization);
    if (answer?.(req, socket)) return;
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(req.headers["sec-websocket-key"])}\r\n\r\n`);
    const peer = new Peer(socket, req);
    peers.push(peer);
    onConnection(peer, peers.length);
  });
  const port = await listen(server);
  return {
    url: `ws://127.0.0.1:${port}/device`, peers, attempts,
    close() { for (const peer of peers) peer.socket.destroy(); server.closeAllConnections?.(); server.close(); },
  };
}

/** A stand-in for the relay: each device connection gets a relay-side Mux, as the real relay does. */
function relayMux(peer) {
  const mux = new Mux((bytes) => peer.send(0x2, bytes));
  peer.on("frame", (frame) => frame.opcode === 0x2 && mux.receive(frame.payload));
  peer.socket.on("close", () => mux.close());
  peer.mux = mux;
  return mux;
}

// --- mux ---

test("mux streams carry bytes both ways past the credit window, half-close, and reset", async () => {
  const deviceStreams = [];
  let echo = false;
  // Two ends of one WebSocket, frames delivered in order on later ticks, as over a network.
  let relay, device;
  relay = new Mux((bytes) => setImmediate(() => device.receive(bytes)));
  device = new Mux((bytes) => setImmediate(() => relay.receive(bytes)), {
    onOpen: (id) => {
      const stream = device.accept(id);
      deviceStreams.push(stream);
      device.opened(id);
      if (echo) stream.pipe(stream);
      else stream.resume();
    },
  });

  // A reader that doesn't read holds the sender to one window: nothing more is sent until it consumes.
  const download = crypto.randomBytes(1024 * 1024);
  const slow = await relay.open("example.com", 443);
  deviceStreams[0].end(download);
  await tick(50);
  assert.equal(deviceStreams[0].bytesOut, WINDOW);
  assert.equal(slow.bytesIn, WINDOW);
  slow.end();
  assert.equal(sha(await collect(slow)), sha(download));
  assert.equal(deviceStreams[0].bytesOut, download.length);

  // 3 MiB up and echoed back down (12 windows each way), then both sides half-close.
  echo = true;
  const upload = crypto.randomBytes(3 * 1024 * 1024);
  const both = await relay.open("example.com", 443);
  const echoed = collect(both);
  both.end(upload);
  assert.equal(sha(await echoed), sha(upload));
  await tick();
  assert.equal(relay.streams.size, 0);
  assert.equal(device.streams.size, 0);

  // A reset on one end aborts the other end's stream.
  echo = false;
  const aborted = await relay.open("example.com", 443);
  const far = deviceStreams[2];
  let failure;
  far.on("error", (error) => { failure = error; });
  const closed = new Promise((resolve) => far.on("close", resolve));
  aborted.destroy();
  await closed;
  assert.equal(failure?.message, "reset");
  assert.equal(device.streams.size, 0);
});

// --- WebSocket client ---

test("the WebSocket client authenticates, masks its frames, and reads extended, fragmented and control frames", async (t) => {
  const pong = crypto.randomBytes(8);
  const big = crypto.randomBytes(70_000);
  const medium = crypto.randomBytes(300);
  let peer;
  const frames = [];
  const server = await wsServer({ onConnection: (connected) => {
    peer = connected;
    peer.on("frame", (frame) => frames.push(frame));
    peer.send(0x2, medium); // 16-bit length
    peer.send(0x2, big); // 64-bit length
    peer.send(0x2, Buffer.from("abc"), { fin: false }); // a fragmented message with a ping in the middle
    peer.send(0x9, pong);
    peer.send(0x0, Buffer.from("def"));
    peer.send(0x1, Buffer.from("text"));
  } });
  t.after(() => server.close());

  const client = connectWebSocket(server.url, { headers: { Authorization: "Bearer relay-token" } });
  const messages = [];
  client.on("message", (data, binary) => messages.push({ data: Buffer.from(data), binary }));
  await once(client, "open");
  await until(() => messages.length === 4, "four messages");
  assert.equal(peer.authorization, "Bearer relay-token");
  assert.equal(sha(messages[0].data), sha(medium));
  assert.equal(sha(messages[1].data), sha(big));
  assert.deepEqual([messages[2].data.toString(), messages[2].binary], ["abcdef", true]);
  assert.deepEqual([messages[3].data.toString(), messages[3].binary], ["text", false]);

  const upload = crypto.randomBytes(70_000);
  client.send(upload);
  await until(() => frames.some((frame) => frame.opcode === 0x2), "the client's message");
  assert.deepEqual(frames.find((frame) => frame.opcode === 0xa)?.payload, pong);
  assert.equal(sha(frames.find((frame) => frame.opcode === 0x2).payload), sha(upload));
  assert.equal(peer.unmasked, 0);

  // The relay's close code reaches the device (4401 asks for a new token), and the client echoes it.
  const closed = once(client, "close");
  peer.close(4401, "expired");
  assert.deepEqual(await closed, [4401, "expired"]);
  assert.equal(frames.find((frame) => frame.opcode === 0x8)?.payload.readUInt16BE(0), 4401);
});

test("the WebSocket client refuses a bad handshake, an HTTP refusal, an oversized frame, and plain ws:// off this computer", async (t) => {
  const forged = await wsServer({ accept: () => "not-the-right-accept-value=" });
  const refused = await wsServer({ answer: (_req, socket) => { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return true; } });
  let peer;
  const oversized = await wsServer({ onConnection: (connected) => {
    peer = connected;
    // A header announcing 1 MiB + 1: refused before any of it arrives.
    peer.send(0x2, Buffer.alloc(0), { length: 1024 * 1024 + 1 });
  } });
  t.after(() => { forged.close(); refused.close(); oversized.close(); });

  for (const [server, status] of [[forged, undefined], [refused, 401]]) {
    const client = connectWebSocket(server.url);
    let opened = false, failure;
    client.on("open", () => { opened = true; });
    client.on("error", (error) => { failure = error; });
    const code = await new Promise((resolve) => client.on("close", resolve));
    assert.equal(opened, false);
    assert.equal(code, 1006);
    assert.ok(failure);
    assert.equal(client.handshakeStatus, status);
  }

  const frames = [];
  const client = connectWebSocket(oversized.url);
  let failure;
  client.on("error", (error) => { failure = error; });
  const messages = [];
  client.on("message", (data) => messages.push(data));
  client.on("open", () => peer.on("frame", (frame) => frames.push(frame)));
  await new Promise((resolve) => client.on("close", resolve));
  assert.match(failure.message, /too big/);
  assert.equal(messages.length, 0);
  assert.equal(frames.find((frame) => frame.opcode === 0x8)?.payload.readUInt16BE(0), 1009);

  assert.equal(relayUrl("wss://device-relay.shapes.inc/device").host, "device-relay.shapes.inc");
  assert.equal(relayUrl("ws://127.0.0.1:8080/device").port, "8080");
  for (const url of ["ws://device-relay.shapes.inc/device", "wss://user:secret@device-relay.shapes.inc/device", "https://device-relay.shapes.inc/device", "ws://192.168.1.10/device"]) {
    assert.throws(() => relayUrl(url), undefined, url);
  }
});

// --- device ---

test("a site's bytes go through this computer's connection to the relay, past the flow-control window", async (t) => {
  const site = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
  });
  const sitePort = await listen(site);
  let relay;
  const server = await wsServer({ onConnection: (peer) => { relay = relayMux(peer); } });
  const device = startDevice({ url: server.url, token: "relay-token", ports: new Set([sitePort]), allowPrivate: true, reconnect: false });
  t.after(() => { device.stop(); server.close(); site.close(); });
  await until(() => device.connected && relay, "the device to connect");

  const stream = await relay.open("127.0.0.1", sitePort);
  assert.equal(device.open, 1);
  const payload = crypto.randomBytes(2 * 1024 * 1024);
  const echoed = collect(stream);
  stream.end(payload);
  assert.equal(sha(await echoed), sha(payload));
  await until(() => device.open === 0, "the site connection to close");
  assert.equal(device.usage.bytes, payload.length * 2);
});

test("this computer refuses its own network, rebinding hostnames and non-web ports before connecting", async (t) => {
  const looked = [];
  // A rebinding-style answer: a public-looking name that resolves to the home router.
  const lookup = (host, options, callback) => { looked.push(host); callback(null, [{ address: "192.168.1.1", family: 4 }]); };
  let relay;
  const server = await wsServer({ onConnection: (peer) => { relay = relayMux(peer); } });
  const device = startDevice({ url: server.url, token: "relay-token", lookup, reconnect: false });
  t.after(() => { device.stop(); server.close(); });
  await until(() => device.connected && relay, "the device to connect");

  for (const [host, port, reason] of [
    ["127.0.0.1", 443, "private_address"], ["::1", 443, "private_address"], ["169.254.169.254", 80, "private_address"],
    ["::ffff:192.168.0.1", 443, "private_address"], ["rebind.example.com", 443, "private_address"],
    ["example.com", 22, "port"], ["example.com", 8443, "port"], ["not a host", 443, "bad_host"],
  ]) {
    await assert.rejects(relay.open(host, port), { message: reason }, `${host}:${port}`);
  }
  // Only the hostname on a web port was looked up; nothing was connected to.
  assert.deepEqual(looked, ["rebind.example.com"]);
  assert.equal(device.open, 0);
});

test("publicLookup hands Node only the public addresses of a mixed answer", async () => {
  const lookup = publicLookup((host, options, callback) => callback(null, [
    { address: "10.0.0.7", family: 4 }, { address: "93.184.216.34", family: 4 }, { address: "fe80::1", family: 6 }, { address: "2606:2800:220:1::1", family: 6 }]));
  const all = await new Promise((resolve, reject) => lookup("mixed.example.com", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all.map((entry) => entry.address), ["93.184.216.34", "2606:2800:220:1::1"]);
  for (const address of ["100.64.1.1", "169.254.169.254", "172.20.0.1", "::ffff:192.168.0.1", "fd00::1", "2002:c0a8:101::1", "224.0.0.251", "0.0.0.0"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  // Mapped public IPv4 stays public: guards the BlockList rule that would otherwise block all of IPv4.
  for (const address of ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
});

test("a 4401 from the relay waits for a fresh token instead of reconnecting with the old one", async (t) => {
  const server = await wsServer({ onConnection: (peer, n) => { if (n === 1) peer.close(4401, "expired"); } });
  let refusals = 0;
  const device = startDevice({ url: server.url, token: "old", retryMs: 1, onTokenRefused: () => { refusals++; } });
  t.after(() => { device.stop(); server.close(); });

  await until(() => refusals === 1, "the token refusal");
  await tick(100);
  assert.deepEqual(server.attempts, ["Bearer old"]);

  device.update({ token: "new" });
  await until(() => device.connected, "the reconnect");
  assert.deepEqual(server.attempts, ["Bearer old", "Bearer new"]);

  // A dropped connection (not a token refusal) comes back by itself, with the current token.
  server.peers[1].socket.destroy();
  await until(() => server.attempts.length === 3 && device.connected, "the automatic reconnect");
  assert.equal(server.attempts[2], "Bearer new");
  assert.equal(refusals, 1);
});

// --- the route inside the daemon ---

test("the route asks shapes.inc for a new token whenever the relay refuses one", async (t) => {
  // Connection 1: HTTP 401 at the handshake. Connection 2: accepted, then closed with 4401. Connection 3 stays.
  const server = await wsServer({
    answer: (req, socket) => {
      if (req.headers.authorization !== "Bearer token-1") return false;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return true;
    },
    onConnection: (peer, n) => { if (n === 1) setTimeout(() => peer.close(4401, "expired"), 10); },
  });
  const calls = [];
  const route = startBrowserRoute({
    config: { api: "https://api.shapes.inc", device_token: "saved-identity" },
    request: async (api, path, body, token) => {
      calls.push({ api, path, body, token });
      return { success: true, enabled: true, relay_url: server.url, relay_token: `token-${calls.length}`, expires_in: 43200 };
    },
    retryMs: 1,
  });
  t.after(() => { route.stop(); server.close(); });

  await until(() => server.attempts.length === 3 && route.status().state === "on", "the third connection");
  assert.deepEqual(server.attempts, ["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call, { api: "https://api.shapes.inc", path: "/devices/browser-route", body: { enabled: true }, token: "saved-identity" });
  }
});

test("the early refresh hands the relay its fresh token on the open connection, and a reconnect uses it", async (t) => {
  const texts = [];
  const server = await wsServer({ onConnection: (peer) => {
    peer.on("frame", (frame) => { if (frame.opcode === 0x1) texts.push(JSON.parse(frame.payload)); });
  } });
  let calls = 0;
  const route = startBrowserRoute({
    config: { api: "https://api.shapes.inc", device_token: "saved-identity" },
    // The first token is short-lived so its 80% refresh lands inside the test; the next one lasts.
    request: async () => {
      calls++;
      return { success: true, enabled: true, relay_url: server.url, relay_token: `token-${calls}`, expires_in: calls === 1 ? 0.1 : 43200 };
    },
    deviceFactory: (options) => startDevice({ ...options, retryMs: 1 }),
    minRefreshMs: 0,
  });
  t.after(() => { route.stop(); server.close(); });

  await until(() => texts.length === 1, "the in-band token");
  assert.deepEqual(texts, [{ type: "token", token: "token-2" }]);
  // No reconnect: the same connection carries on with the new token.
  assert.deepEqual(server.attempts, ["Bearer token-1"]);
  assert.equal(route.status().state, "on");

  server.peers[0].socket.destroy();
  await until(() => server.attempts.length === 2 && route.status().state === "on", "the reconnect");
  assert.equal(server.attempts[1], "Bearer token-2");
  assert.equal(calls, 2);
});

test("the route stays off when shapes.inc doesn't offer it, and hands a 401 to revocation", async () => {
  const config = { api: "https://api.shapes.inc", device_token: "saved-identity" };
  let devices = 0;
  const deviceFactory = () => { devices++; return { stop() {}, update() {}, usage: { day: "", bytes: 0 } }; };

  const unavailable = startBrowserRoute({ config, deviceFactory, request: async () => {
    throw Object.assign(new Error("HTTP 403"), { status: 403, body: { success: false, code: "not_available", error: "Not yet." } });
  } });
  await until(() => unavailable.status().state === "not_available", "not_available");
  unavailable.stop();

  let revoked = 0;
  const removed = startBrowserRoute({ config, deviceFactory, onRevoked: () => { revoked++; }, request: async () => {
    throw Object.assign(new Error("HTTP 401"), { status: 401 });
  } });
  await until(() => revoked === 1, "the revocation hand-off");
  assert.equal(removed.status().state, "off");
  assert.equal(devices, 0);
});
