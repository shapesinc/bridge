"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { runDaemon } = require("../src/runtime");
const { readState, writeState } = require("../src/state");

async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-daemon-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  const abort = new AbortController();
  writeState("config", { device_id: "computer", device_token: "saved-identity", name: "My computer", api: "https://api.shapes.inc", keep_awake: true });
  try { await run(abort); }
  finally {
    abort.abort();
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function dependencies() {
  const tunnels = [];
  let closed = false, awakeStopped = false;
  return {
    tunnels,
    closed: () => closed,
    awakeStopped: () => awakeStopped,
    options: {
      heartbeatMs: 10, retryMs: 1,
      serve: async () => ({ address: () => ({ port: 8078 }), close: () => { closed = true; }, closeAllConnections() {} }),
      tunnelFactory: async () => {
        const child = new EventEmitter(); child.exitCode = null;
        child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
        const value = { child, url: `https://tunnel-${tunnels.length}.trycloudflare.com` }; tunnels.push(value); return value;
      },
      permissions: async () => ({ accessibility: "granted" }),
      requestNativePermissions: async () => {},
      awakeFactory: () => ({ status: () => "enabled", stop: () => { awakeStopped = true; } }),
    },
  };
}

test("tunnel restart updates endpoint without pairing again or changing account identity", async () => fixture(async (abort) => {
  const mock = dependencies(), heartbeats = [], offline = [];
  await runDaemon({ ...mock.options, signal: abort.signal, request: async (_api, route, body, token) => {
    if (route === "/devices/offline") { offline.push(body); return {}; }
    heartbeats.push({ body, token });
    if (heartbeats.length === 1) mock.tunnels[0].child.kill(); else abort.abort();
    return { heartbeat_interval: 30 };
  } });
  assert.equal(heartbeats.length, 2);
  assert.notEqual(heartbeats[0].body.bridge_url, heartbeats[1].body.bridge_url);
  assert.equal(heartbeats[0].token, "saved-identity");
  assert.equal(heartbeats[1].token, "saved-identity");
  assert.equal(heartbeats[0].body.token, heartbeats[1].body.token);
  assert.equal(heartbeats[0].body.permissions.background_service, "enabled");
  assert.deepEqual(offline, [{ bridge_url: heartbeats[1].body.bridge_url, token: heartbeats[1].body.token }]);
  assert.equal(mock.closed(), true);
  assert.equal(mock.awakeStopped(), true);
}));

test("revocation closes the public door, releases awake assertion and prevents reconnect", async () => fixture(async (abort) => {
  const mock = dependencies();
  let calls = 0;
  const running = runDaemon({ ...mock.options, signal: abort.signal, request: async () => { calls++; const error = new Error("revoked"); error.status = 401; throw error; } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readState("config").revoked, true);
  assert.equal(readState("status").connection, "revoked");
  assert.equal(mock.closed(), true);
  assert.equal(mock.awakeStopped(), true);
  assert.equal(calls, 1);
  abort.abort(); await running;
}));

test("permission request is executed by daemon and never adds remote permissions endpoints", async () => fixture(async (abort) => {
  const mock = dependencies(); let requested;
  writeState("permission-request", { permission: "screen_recording" });
  await runDaemon({ ...mock.options, signal: abort.signal,
    requestNativePermissions: async (value) => { requested = value; },
    request: async () => { abort.abort(); return {}; },
  });
  assert.deepEqual(requested, { permission: "screen_recording" });
  assert.equal(readState("permission-request"), null);
}));
