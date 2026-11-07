"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { createEmbeddedHost } = require("../src/embedded-host");

function client(endpoint) {
  const socket = net.createConnection(endpoint); const lines = [], waiting = [];
  let buffer = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const next = waiting.shift(); if (next) next(value); else lines.push(value);
    }
  });
  return { socket, send: (value) => socket.write(JSON.stringify(value) + "\n"), next: () => lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiting.push(resolve)) };
}
async function authenticate(peer, token) {
  const nonce = crypto.randomBytes(32).toString("hex"); peer.send({ version: 1, nonce });
  const challenge = await peer.next();
  const proof = crypto.createHmac("sha256", token).update(`client\n${nonce}\n${challenge.challenge}\n${challenge.hostVersion}`).digest("hex");
  peer.send({ version: 1, proof }); return peer.next();
}
test("durable private host authenticates, detaches established access, and preserves explicit pause", { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-host-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\bridge-test-${crypto.randomUUID()}` : path.join(dir, "control.sock");
  const token = crypto.randomBytes(32).toString("hex");
  let state = "connected", detached = 0, disposed = 0, calls = 0;
  const host = createEmbeddedHost({ token, version: "test-1", endpoint, controller: {
    status: async () => { calls++; return { state }; }, disconnect: async () => { state = "paused"; return { state }; },
    detach: async () => { detached++; return { state }; }, dispose: async () => { disposed++; },
  } });
  const sockets = [];
  try {
    await host.start();
    const forged = client(endpoint); sockets.push(forged.socket);
    forged.send({ version: 1, token: "0".repeat(64) });
    await once(forged.socket, "close"); assert.equal(calls, 0); assert.equal(detached, 0);
    const first = client(endpoint); sockets.push(first.socket);
    assert.deepEqual(await authenticate(first, token), { version: 1, ready: true, hostVersion: "test-1" });
    first.send({ version: 1, id: "one", operation: "status", params: {} });
    assert.equal((await first.next()).result.state, "connected");
    const busy = client(endpoint); sockets.push(busy.socket);
    assert.equal((await authenticate(busy, token)).error.code, "busy"); busy.socket.destroy();
    first.socket.end(); await once(first.socket, "close");
    while (!detached) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state, "connected"); assert.equal(disposed, 0);
    const second = client(endpoint); sockets.push(second.socket);
    assert.equal((await authenticate(second, token)).ready, true);
    second.send({ version: 1, id: "two", operation: "disconnect", params: {} });
    assert.equal((await second.next()).result.state, "paused");
    second.socket.destroy(); await once(second.socket, "close");
    await host.dispose(); assert.equal(disposed, 1); assert.equal(state, "paused");
  } finally { for (const socket of sockets) socket.destroy(); await host.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("idle host retires disconnected or paused controllers only after the foreground detaches", { timeout: 10000 }, async () => {
  for (const state of ["disconnected", "paused", "connected"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-idle-"));
    const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\bridge-idle-${crypto.randomUUID()}` : path.join(dir, "idle.sock");
    const token = crypto.randomBytes(32).toString("hex");
    let disposed = 0, idle = 0, error;
    const host = createEmbeddedHost({ token, version: "test-1", endpoint, idleTimeoutMs: 100,
      onIdle: (failure) => { idle++; error = failure; }, controller: {
        status: async () => ({ state }), detach: async () => ({ state }), dispose: async () => { disposed++; },
      } });
    let peer;
    try {
      await host.start(); peer = client(endpoint); assert.equal((await authenticate(peer, token)).ready, true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(idle, 0, "an attached controller remains available");
      peer.socket.end(); await once(peer.socket, "close");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(idle, state === "connected" ? 0 : 1); assert.equal(error, undefined);
      assert.equal(disposed, state === "connected" ? 0 : 1);
    } finally { peer?.socket.destroy(); await host.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("a never-attached idle host exits without starting computer access", { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-unused-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\bridge-unused-${crypto.randomUUID()}` : path.join(dir, "unused.sock");
  let stopped = 0, finish;
  const retired = new Promise((resolve) => { finish = resolve; });
  const host = createEmbeddedHost({ token: crypto.randomBytes(32).toString("hex"), version: "test-1", endpoint,
    idleTimeoutMs: 5, onIdle: finish, controller: {
      status: () => ({ state: "disconnected" }), dispose: async () => { stopped++; },
    } });
  try { await host.start(); assert.equal(await retired, undefined); assert.equal(stopped, 1); assert.equal(host.server.listening, false); }
  finally { await host.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
