"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDesktopController } = require("../src/desktop");

function fixture(overrides = {}) {
  const state = {}, events = [], calls = [];
  const config = { api: "https://api.shapes.inc", device_id: "device", device_token: "secret", name: "Test Mac" };
  const options = {
    read: (key) => state[key], write: (key, value) => { state[key] = value; }, remove: (key) => { delete state[key]; },
    pair: async ({ onCode }) => { onCode({ user_code: "ABCD", device_code: "never-output", verification_uri_complete: "https://talk.shapes.inc/connect-computer?code=ABCD" }); return config; },
    install: () => { calls.push("install"); }, start: () => { calls.push("start"); },
    stop: () => { calls.push("stop"); delete state.status; }, request: async () => {},
    isRunning: () => true, publish: (value) => events.push(value), ...overrides,
  };
  return { state, events, calls, config, controller: createDesktopController(options) };
}

test("first connection composes pairing, bundled installation and start without granting a chat or OS permission", async () => {
  const f = fixture();
  await f.controller.connect();
  assert.deepEqual(f.calls, ["install", "start"]);
  assert.equal(f.state.config.device_token, "secret");
  assert.equal(f.state["permission-request"], undefined);
  assert.equal(JSON.stringify(f.events).includes("secret"), false);
  assert.equal(JSON.stringify(f.events).includes("never-output"), false);
  assert.equal(f.controller.status().connection, "starting"); // no invented Connected before heartbeat
  await f.controller.connect();
  assert.deepEqual(f.calls, ["install", "start"]); // no restart during initial daemon startup
});

test("same primitives resume a paused device without pairing or changing identity and pause remains durable", async () => {
  const f = fixture({ pair: async () => { throw new Error("must not pair"); } });
  f.state.config = { ...f.config, paused: true, keep_awake: false };
  await f.controller.connect();
  assert.equal(f.state.config.device_id, "device");
  assert.equal(f.state.config.keep_awake, false);
  await f.controller.pause();
  assert.equal(f.state.config.paused, true);
  assert.equal(f.controller.status().connection, "paused");
});

test("same primitives re-pair a revoked device and ignore stale or another device's heartbeat", async () => {
  const f = fixture();
  f.state.config = { ...f.config, revoked: true };
  f.state.status = { device_id: "old-device", pid: 123, connection: "connected", updated_at: new Date().toISOString() };
  assert.equal(f.controller.status().connection, "revoked");
  await f.controller.connect();
  assert.equal(f.state.config.revoked, false);
  assert.equal(f.state.status, undefined);
});

test("pause followed by immediate resume cannot erase the new daemon's endpoint", async () => {
  let endpoint = "old", finishOffline;
  const f = fixture({
    // Simulate a delayed account endpoint write. An unscoped controller request
    // used to arrive after the resumed daemon's first successful heartbeat.
    request: async (_api, route, body) => {
      assert.equal(route, "/devices/offline");
      await new Promise((resolve) => { finishOffline = resolve; });
      if (!body.bridge_url || body.bridge_url === endpoint) endpoint = null;
    },
    start: () => { endpoint = "resumed"; },
  });
  f.state.config = f.config;
  f.state.status = { pid: 123, device_id: "device", connection: "connected", updated_at: new Date().toISOString() };
  const stopping = f.controller.pause();
  await f.controller.connect();
  finishOffline?.();
  await stopping;
  assert.equal(endpoint, "resumed");
  assert.equal(f.state.config.paused, false);
  assert.deepEqual(f.calls, ["stop", "install"]);
});

test("cancelled repeated connect is one approval and cannot install after a delayed result", async () => {
  let complete, count = 0;
  const f = fixture({ pair: () => { count++; return new Promise((resolve) => { complete = resolve; }); } });
  const pending = f.controller.connect();
  await f.controller.connect();
  await f.controller.pause();
  complete(f.config);
  await pending;
  assert.equal(count, 1);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.config, undefined);
});

test("failure is retryable; failed disconnect does not report a stopped live daemon", async () => {
  let attempts = 0;
  const f = fixture({ install: () => { if (++attempts === 1) throw new Error("Missing signed helper"); }, stop: () => { throw new Error("Stop failed"); } });
  await f.controller.connect();
  assert.equal(f.controller.status().error, "Missing signed helper");
  await f.controller.connect();
  f.state.status = { pid: 123, device_id: "device", connection: "connected", updated_at: new Date().toISOString() };
  await f.controller.pause();
  assert.equal(f.state.config.paused, true);
  assert.equal(f.controller.status().connection, "disconnect_failed");
  assert.equal(f.controller.status().error, "Stop failed");
});

test("permissions require an active connection; status never treats a dead process as connected", () => {
  const f = fixture({ isRunning: () => false });
  f.state.config = f.config;
  f.state.status = { pid: 123, device_id: "device", connection: "connected", updated_at: new Date().toISOString() };
  assert.equal(f.controller.status().connection, "offline");
  assert.throws(() => f.controller.permissions());
});

test("connect is idempotent at the primitive boundary for every live connection state", async () => {
  for (const connection of ["starting", "connecting", "connected", "reconnecting"]) {
    const f = fixture();
    f.state.config = f.config;
    f.state.status = { pid: 123, device_id: "device", connection, updated_at: new Date().toISOString() };
    assert.equal((await f.controller.connect()).connection, connection);
    assert.deepEqual(f.calls, []);
  }
});

test("a stale heartbeat is not proof that a paused but live daemon stopped", () => {
  const f = fixture();
  f.state.config = { ...f.config, paused: true };
  f.state.status = { pid: 123, device_id: "device", connection: "connected", updated_at: "2000-01-01T00:00:00Z" };
  assert.equal(f.controller.status().connection, "disconnect_failed");
});

test("a cancelled old approval cannot clear a newer connection's startup protection", async () => {
  let complete;
  const f = fixture({ pair: () => new Promise((resolve) => { complete = resolve; }) });
  const old = f.controller.connect();
  await f.controller.pause();
  f.state.config = f.config;
  await f.controller.connect();
  complete(f.config);
  await old;
  assert.equal(f.controller.status().connection, "starting");
  await f.controller.connect();
  assert.deepEqual(f.calls, ["install", "start"]);
});

test("actual stdio controller reads private persisted state without leaking credentials or exposing commands", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-desktop-contract-"));
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ paused: true, device_token: "never-output", name: "Contract Mac" }));
  const child = spawn(process.execPath, [path.join(__dirname, "../bin/desktop.js")], { env: { ...process.env, SHAPES_BRIDGE_HOME: directory }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end("status\nconstructor\nrun rm -rf anything\n");
  try {
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 0, stderr);
    const messages = output.trim().split("\n").map(JSON.parse);
    assert.ok(messages.length >= 2);
    assert.equal(messages[0].status.connection, "paused");
    assert.equal(output.includes("never-output"), false);
  } finally { if (child.exitCode === null) child.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
});
