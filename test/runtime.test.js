"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
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

// Advance daemon waits without replacing its retry policy or waiting thirty
// seconds per heartbeat. setImmediate still lets pending promise work settle.
function clock(t) {
  const pending = [];
  t.mock.method(global, "setTimeout", (callback, delay) => {
    const timer = { callback, delay }; pending.push(timer); return timer;
  });
  t.mock.method(global, "clearTimeout", (timer) => { if (timer) timer.canceled = true; });
  return {
    settle: () => new Promise(setImmediate),
    next() {
      const timer = pending.find((entry) => !entry.canceled && !entry.fired);
      assert.ok(timer, "daemon should be waiting for its next attempt");
      timer.fired = true;
      timer.callback();
      return timer.delay;
    },
  };
}

test("endpoint warmup retries promptly, then successful heartbeats keep their normal cadence", async (t) => fixture(async (abort) => {
  const timer = clock(t), mock = dependencies(), heartbeats = [];
  const running = runDaemon({ ...mock.options, heartbeatMs: 30000, retryMs: 1000, signal: abort.signal,
    request: async (_api, route, body, token) => {
      if (route !== "/devices/heartbeat") return {};
      heartbeats.push({ body, token });
      if (heartbeats.length === 1) throw Object.assign(new Error("endpoint not reachable yet"), { status: 409 });
      return {};
    },
  });
  try {
    await timer.settle();
    assert.equal(readState("status").connection, "reconnecting");
    assert.equal(timer.next(), 1000);
    await timer.settle();
    assert.equal(heartbeats.length, 2);
    assert.equal(readState("status").connection, "connected");
    assert.deepEqual(heartbeats[1], heartbeats[0]);
    assert.equal(timer.next(), 30000);
    await timer.settle();
    assert.equal(heartbeats.length, 3);
    assert.equal(mock.tunnels.length, 1);
  } finally { abort.abort(); await running; }
}));

test("recovery backoff is bounded, resets after success, and starts fresh for a replacement tunnel", async (t) => fixture(async (abort) => {
  const timer = clock(t), mock = dependencies();
  let fail = false, calls = 0;
  const running = runDaemon({ ...mock.options, heartbeatMs: 30000, retryMs: 1000, signal: abort.signal,
    request: async (_api, route) => {
      if (route !== "/devices/heartbeat") return {};
      calls++;
      if (fail) throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
      return {};
    },
  });
  try {
    await timer.settle();
    assert.equal(readState("status").connection, "connected");
    fail = true;
    assert.equal(timer.next(), 30000);
    await timer.settle();
    for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      assert.equal(timer.next(), expected);
      await timer.settle();
    }
    fail = false;
    assert.equal(timer.next(), 30000);
    await timer.settle();
    assert.equal(readState("status").connection, "connected");
    fail = true;
    assert.equal(timer.next(), 30000);
    await timer.settle();
    assert.equal(timer.next(), 1000);
    await timer.settle();
    mock.tunnels[0].child.kill();
    await timer.settle();
    const tunnelRetry = timer.next();
    assert.ok(tunnelRetry >= 1000 && tunnelRetry < 2000);
    await timer.settle();
    assert.equal(mock.tunnels.length, 2);
    assert.equal(timer.next(), 1000);
    await timer.settle();
    const beforeCancel = calls;
    abort.abort();
    await running;
    assert.equal(calls, beforeCancel);
    assert.equal(readState("status").connection, "offline");
    assert.equal(mock.closed(), true);
    assert.equal(mock.awakeStopped(), true);
    assert.ok(mock.tunnels.every(({ child }) => child.exitCode === 0));
  } finally { abort.abort(); await running; }
}));

test("localhost heartbeat warmup and cancellation use the real HTTP transport", async () => fixture(async (abort) => {
  const mock = dependencies(), heartbeats = [], offline = [];
  let observedPending, pendingResponse;
  const pending = new Promise((resolve) => { observedPending = resolve; });
  const api = http.createServer(async (request, response) => {
    let json = "";
    for await (const chunk of request) json += chunk;
    const value = { body: JSON.parse(json), authorization: request.headers.authorization };
    if (request.url === "/bridge/devices/offline") {
      offline.push(value);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    assert.equal(request.url, "/bridge/devices/heartbeat");
    heartbeats.push(value);
    if (heartbeats.length === 3) {
      // Preserve cleanup even if the server accepts a heartbeat but the
      // person's disconnect arrives before its response reaches the daemon.
      pendingResponse = response;
      observedPending();
      return;
    }
    response.writeHead(heartbeats.length === 1 ? 409 : 200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  writeState("config", { ...readState("config"), api: `http://127.0.0.1:${api.address().port}` });
  const running = runDaemon({ ...mock.options, heartbeatMs: 80, retryMs: 1, signal: abort.signal });
  let deadline;
  try {
    await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("heartbeat did not recover")), 2000); })]);
    clearTimeout(deadline);
    assert.equal(readState("status").connection, "connected");
    assert.equal(heartbeats.length, 3);
    assert.deepEqual(heartbeats[1], heartbeats[0]);
    assert.equal(heartbeats[0].authorization, "Bearer saved-identity");
    const stopped = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("disconnect did not finish after heartbeat receipt")), 1000); });
    abort.abort();
    assert.equal(mock.closed(), true);
    assert.equal(mock.awakeStopped(), true);
    pendingResponse.writeHead(200, { "content-type": "application/json" }).end("{}");
    await Promise.race([running, stopped]);
    assert.equal(heartbeats.length, 3);
    assert.equal(offline.length, 1);
    assert.deepEqual(offline[0].body, { bridge_url: heartbeats[1].body.bridge_url, token: heartbeats[1].body.token });
    assert.equal(readState("status").connection, "offline");
    assert.equal(mock.closed(), true);
    assert.equal(mock.awakeStopped(), true);
  } finally {
    clearTimeout(deadline);
    abort.abort();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
    await running;
  }
}));

test("cancel during the first accepted heartbeat still unregisters its endpoint after receipt", async () => fixture(async (abort) => {
  const mock = dependencies(), offline = [];
  let accepted, responsePending, heartbeat;
  const pending = new Promise((resolve) => { accepted = resolve; });
  const api = http.createServer(async (request, response) => {
    let json = "";
    for await (const chunk of request) json += chunk;
    const body = JSON.parse(json);
    if (request.url === "/bridge/devices/offline") {
      offline.push(body);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } else {
      assert.equal(request.url, "/bridge/devices/heartbeat");
      assert.equal(heartbeat, undefined, "cancellation must prevent any second heartbeat");
      heartbeat = body;
      responsePending = response;
      accepted();
    }
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  writeState("config", { ...readState("config"), api: `http://127.0.0.1:${api.address().port}` });
  const running = runDaemon({ ...mock.options, signal: abort.signal });
  let deadline;
  try {
    await Promise.race([pending, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("first heartbeat did not arrive")), 2000); })]);
    clearTimeout(deadline);
    abort.abort();
    assert.equal(mock.closed(), true);
    assert.equal(mock.awakeStopped(), true);
    responsePending.writeHead(200, { "content-type": "application/json" }).end("{}");
    await running;
    assert.deepEqual(offline, [{ bridge_url: heartbeat.bridge_url, token: heartbeat.token }]);
    assert.equal(readState("status").connection, "offline");
  } finally {
    clearTimeout(deadline);
    abort.abort();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
    await running;
  }
}));

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
  let calls = 0, startupDisabled = 0;
  const running = runDaemon({ ...mock.options, signal: abort.signal, disableStartup: () => { startupDisabled++; }, request: async () => { calls++; const error = new Error("revoked"); error.status = 401; throw error; } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readState("config").revoked, true);
  // The daemon exits instead of idling, and stops relaunching at sign-in.
  assert.equal(startupDisabled, 1);
  assert.equal(readState("status").connection, "revoked");
  assert.equal(mock.closed(), true);
  assert.equal(mock.awakeStopped(), true);
  assert.equal(calls, 1);
  abort.abort(); await running;
}));

test("a revocation response received during disconnect still removes automatic startup", async () => fixture(async (abort) => {
  const mock = dependencies();
  let startupDisabled = 0;
  await runDaemon({ ...mock.options, signal: abort.signal, disableStartup: () => { startupDisabled++; },
    request: async () => {
      abort.abort();
      throw Object.assign(new Error("revoked"), { status: 401 });
    },
  });
  assert.equal(readState("config").revoked, true);
  assert.equal(startupDisabled, 1);
  assert.equal(readState("status").connection, "revoked");
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
