"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");
const { once } = require("node:events");
const { createHmac, randomBytes } = require("node:crypto");
const { listenPrivateChannel, connectPrivateChannel, supportsPrivateChannel } = require("../src/private-channel");
const { runtimeCapabilities } = require("../src/runtime-capabilities");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-channel-test-")), prior = process.env.SHAPES_BRIDGE_HOME;
test.before(() => { process.env.SHAPES_BRIDGE_HOME = state; });
test.after(() => { if (prior === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = prior; fs.rmSync(state, { recursive: true, force: true }); });
const connect = (channel, options = {}) => connectPrivateChannel({ endpoint: channel.endpoint, credentialFile: channel.credentialFile, scope: "test-scope", ...options });
async function line(socket) {
  const [chunk] = await once(socket, "data");
  return JSON.parse(chunk.toString("utf8").trim());
}
async function closed(socket) { if (!socket.closed) await once(socket, "close"); }

test("desktop discovery has identical available-runtime contracts, with Linux preserved and no grant implied", () => {
  const expected = { bundled_sessions: true, session_input: true, native_tool_proxy: true };
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(supportsPrivateChannel(platform), true);
    assert.deepEqual(runtimeCapabilities({ platform, available: true }), expected);
    assert.deepEqual(runtimeCapabilities({ platform, available: false }), { bundled_sessions: false, session_input: false, native_tool_proxy: false });
  }
  assert.equal(runtimeCapabilities({ platform: "freebsd", available: true }).native_tool_proxy, false);
});

test("actual private channel authenticates both peers before carrying application bytes and closes independently", { timeout: 10000 }, async t => {
  let accepted = 0;
  const channel = await listenPrivateChannel({ scope: "test-scope", onConnection(socket) { accepted++; socket.on("data", bytes => socket.write(bytes)); } });
  t.after(() => channel.close());
  const unrelated = await listenPrivateChannel({ scope: "other", onConnection(socket) { socket.on("data", bytes => socket.write(bytes)); } });
  t.after(() => unrelated.close());
  const socket = await connect(channel); t.after(() => socket.destroy());
  const reply = once(socket, "data"); socket.resume(); socket.write("private echo");
  assert.equal((await reply)[0].toString(), "private echo"); assert.equal(accepted, 1);
  assert.equal(fs.readFileSync(channel.credentialFile, "utf8").length, 64);
  if (process.platform === "win32") assert.match(channel.endpoint, /^\\\\\.\\pipe\\/);
  else { assert.equal(fs.statSync(channel.directory).mode & 0o777, 0o700); assert.equal(fs.statSync(channel.credentialFile).mode & 0o777, 0o600); }
  const stopped = closed(socket); await channel.close(); await stopped;
  assert.equal(fs.existsSync(channel.directory), false);
  const live = await connect(unrelated, { scope: "other" }); t.after(() => live.destroy());
  const response = once(live, "data"); live.resume(); live.write("unrelated survives"); assert.equal((await response)[0].toString(), "unrelated survives");
});

test("wrong credential or run scope never reaches the broker", { timeout: 10000 }, async t => {
  let accepted = 0;
  const channel = await listenPrivateChannel({ scope: "test-scope", onConnection() { accepted++; } }); t.after(() => channel.close());
  const wrong = path.join(state, "wrong.key"); fs.writeFileSync(wrong, randomBytes(32).toString("hex"), { mode: 0o600 });
  await assert.rejects(connect(channel, { credentialFile: wrong }), /authenticate/);
  await assert.rejects(connect(channel, { scope: "other-run" }), /authenticate/);
  await assert.rejects(connect(channel, { scope: "" }), /authenticate/);
  assert.equal(accepted, 0);
});

test("saturated pending authentication cannot prevent owned disposal", { timeout: 10000 }, async t => {
  const channel = await listenPrivateChannel({ scope: "test-scope", onConnection() { assert.fail("No unauthenticated admission"); } });
  t.after(() => channel.close());
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  for (let index = 0; index < 4; index++) {
    const socket = net.createConnection(channel.endpoint); socket.on("error", () => {}); sockets.push(socket); await once(socket, "connect");
  }
  const extra = net.createConnection(channel.endpoint); extra.on("error", () => {}); sockets.push(extra);
  await closed(extra);
  const stopped = sockets.slice(0, 4).map(closed);
  await channel.close(); await Promise.all(stopped);
  assert.equal(fs.existsSync(channel.directory), false);
});

test("captured client proof cannot be replayed against a fresh challenge", { timeout: 10000 }, async t => {
  let accepted = 0;
  const channel = await listenPrivateChannel({ scope: "test-scope", onConnection(socket) { accepted++; socket.end(); } }); t.after(() => channel.close());
  const secret = fs.readFileSync(channel.credentialFile, "utf8"), nonce = randomBytes(32).toString("hex");
  const first = net.createConnection(channel.endpoint); first.on("error", () => {}); t.after(() => first.destroy());
  const challenge = line(first); first.write(JSON.stringify({ version: 1, nonce }) + "\n"); const received = await challenge;
  const proof = createHmac("sha256", secret).update(JSON.stringify(["shapes-private-channel", 1, "test-scope", "client", nonce, received.challenge])).digest("hex");
  const ready = line(first); first.write(JSON.stringify({ version: 1, proof }) + "\n"); assert.equal((await ready).ready, true);
  const second = net.createConnection(channel.endpoint); second.on("error", () => {}); t.after(() => second.destroy());
  const fresh = line(second); second.write(JSON.stringify({ version: 1, nonce }) + "\n"); assert.notEqual((await fresh).challenge, received.challenge);
  const stopped = closed(second); second.write(JSON.stringify({ version: 1, proof }) + "\n"); await stopped; assert.equal(accepted, 1);
});

test("partial, oversized and unauthenticated traffic is bounded; disposal closes pending authentication", { timeout: 10000 }, async t => {
  let accepted = 0;
  const channel = await listenPrivateChannel({ scope: "test-scope", timeoutMs: 100, onConnection() { accepted++; } }); t.after(() => channel.close());
  for (const bytes of ["{", "a".repeat(513), JSON.stringify({ method: "call", params: {} }) + "\n"]) {
    const socket = net.createConnection(channel.endpoint); socket.on("error", () => {}); const done = closed(socket);
    socket.write(bytes); await done;
  }
  const pending = net.createConnection(channel.endpoint); pending.on("error", () => {}); await once(pending, "connect");
  const done = closed(pending); await channel.close(); await done; assert.equal(accepted, 0);
});

test("client refuses a rogue server without sending its proof or application data", { timeout: 10000 }, async t => {
  const owner = await listenPrivateChannel({ scope: "test-scope", onConnection(socket) { socket.destroy(); } });
  const endpoint = owner.endpoint, credentialFile = path.join(state, "retained.key"); fs.copyFileSync(owner.credentialFile, credentialFile); fs.chmodSync(credentialFile, 0o600); await owner.close();
  const seen = [], sockets = new Set();
  const rogue = net.createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("data", bytes => { seen.push(bytes.toString()); socket.write(JSON.stringify({ version: 1, challenge: "a".repeat(64), proof: "b".repeat(64) }) + "\n"); }); });
  // Recreate only the owned Unix directory removed with the original listener.
  if (process.platform !== "win32") fs.mkdirSync(owner.directory, { mode: 0o700 });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => rogue.close(resolve)); fs.rmSync(owner.directory, { recursive: true, force: true }); });
  await new Promise(resolve => rogue.listen(endpoint, resolve));
  await assert.rejects(connectPrivateChannel({ endpoint, credentialFile, scope: "test-scope" }), /authenticate/);
  assert.equal(seen.length, 1); assert.deepEqual(Object.keys(JSON.parse(seen[0])).sort(), ["nonce", "version"]);
});
