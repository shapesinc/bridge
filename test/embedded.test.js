"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmbeddedController } = require("../src/embedded");
const { startServer } = require("../src/server");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const DEVICE = "11111111-1111-4111-8111-111111111111", SECRET = "a".repeat(43), TOKEN = `sbd_${DEVICE}.${SECRET}`;

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(options = {}) {
  const state = options.state || new Map(), calls = [], time = { value: Date.now() };
  let live = false;
  const runtime = { running: () => live, pid: () => live ? 123 : null,
    start: async () => { calls.push("start"); live = true; if (options.ready !== false) heartbeat(); },
    stop: async () => { calls.push("stop"); live = false; } };
  function heartbeat() { state.set("status", { pid: 123, device_id: state.get("config").device_id, connection: "connected",
    updated_at: new Date(time.value).toISOString(), last_heartbeat: new Date(time.value).toISOString(), permissions: { accessibility: "granted", full_disk_access: "secret" } }); }
  const controller = createEmbeddedController({ read: (key) => state.get(key) || null,
    write: (key, value) => state.set(key, structuredClone(value)), remove: (key) => state.delete(key), runtime,
    now: () => time.value, readinessMs: 500, sleep: async (ms) => { time.value += ms; },
    begin: async () => { calls.push("begin"); return { pairing_id: "pair-1", device_code: SECRET, user_code: "ABCD-1234", expires_in: 600 }; },
    poll: async () => { calls.push("poll"); return { status: "approved", owner_user_id: "owner-a", device_id: DEVICE, device_token: TOKEN }; },
    cancel: async (request) => { calls.push("cancel"); calls.push(request); return { status: "cancelled" }; }, ...options.controller });
  const account = (userId = "owner-a", deviceIds = [DEVICE], verified = true) => controller.updateAccount({ userId, deviceIds, verified });
  const begin = (attemptId = "attempt-1") => controller.beginConnect({ attemptId, expectedUserId: "owner-a" });
  const complete = (attemptId = "attempt-1") => controller.completeConnect({ attemptId });
  return { controller, state, calls, runtime, time, heartbeat, account, begin, complete };
}
const saved = (overrides = {}) => ({ mode: "embedded", api: "https://api.shapes.inc", owner_user_id: "owner-a", device_id: DEVICE, device_token: TOKEN, name: "Laptop", paused: false, ...overrides });
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test("original composition: verify account, pair, approve, connect, named permission, disconnect", async () => {
  const f = fixture();
  assert.equal(f.controller.status().state, "disconnected"); assert.deepEqual(f.calls, []);
  await f.account("owner-a", []);
  assert.deepEqual(await f.begin(), { attemptId: "attempt-1", userCode: "ABCD-1234" });
  await rejectsCode(f.complete(), "device_unavailable"); assert.equal(f.calls.includes("start"), false);
  await f.account();
  const result = await f.complete(); assert.equal(result.state, "connected"); assert.equal(result.online, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(result.permissions.full_disk_access, "unknown");
  assert.equal(result.permissions.accessibility, "granted");
  await f.controller.requestPermission({ permission: "screen_recording" });
  assert.deepEqual(f.state.get("permission-request"), { permission: "screen_recording" });
  await rejectsCode(f.controller.requestPermission({ permission: "all" }), "invalid_request");
  await f.controller.disconnect(); assert.equal(f.controller.status().state, "paused");
  assert.equal(f.state.has("permission-request"), false);
  await f.account(); assert.equal(f.controller.status().state, "paused");
});

test("alternative composition: enabled reconnect waits for verified same-account membership; status never launches", async () => {
  const f = fixture(); f.state.set("config", saved());
  assert.equal(f.controller.status().deviceId, undefined); assert.deepEqual(f.calls, []);
  await f.account(null, [], false); assert.equal(f.calls.includes("start"), false);
  await f.account("owner-b"); assert.equal(f.controller.status().deviceId, undefined);
  await f.account("owner-a", []); assert.equal(f.calls.includes("start"), false);
  await f.account(); assert.equal(f.controller.status().state, "connected");
  await f.account(); assert.equal(f.calls.filter((v) => v === "start").length, 1);
  await f.controller.dispose(); assert.equal(f.state.get("config").paused, false); assert.equal(f.runtime.running(), false);
});

test("alternative composition: explicit paused device resumes without pairing or replacing grants", async () => {
  const f = fixture(); f.state.set("config", saved({ paused: true })); await f.account();
  assert.deepEqual(await f.begin(), { attemptId: "attempt-1", deviceId: DEVICE });
  await f.complete(); await f.complete();
  assert.equal(f.calls.includes("begin"), false); assert.equal(f.calls.includes("poll"), false);
  assert.equal(f.calls.filter((v) => v === "start").length, 1);
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  assert.equal(f.state.get("config").paused, true); assert.equal(f.calls.includes("cancel"), false);
});

test("account switch cancels pending approval, hides prior device, and stops its runtime", async () => {
  const f = fixture(); await f.account(); await f.begin();
  await f.account("owner-b", ["device-b"]);
  assert.equal(f.calls.includes("cancel"), true); assert.equal(f.state.has("embedded-pairing"), false);
  await rejectsCode(f.complete(), "attempt_not_found");
  assert.equal(f.runtime.running(), false);
});

test("approved poll must carry current server owner, never relabels a different owner's token", async () => {
  const f = fixture({ controller: { poll: async () => ({ status: "approved", owner_user_id: "owner-b", device_id: DEVICE, device_token: "secret" }) } });
  await f.account(); await f.begin(); await rejectsCode(f.complete(), "account_changed");
  assert.equal(f.calls.includes("cancel"), true); assert.equal(f.state.has("config"), false);
});

test("cancel while poll is pending rejects late approval and never starts runtime", async () => {
  const pending = deferred(), polled = deferred();
  const f = fixture({ controller: { poll: async () => { polled.resolve(); return pending.promise; } } });
  await f.account(); await f.begin();
  const completion = f.complete(); await polled.promise;
  const cancellation = f.controller.cancelConnect({ attemptId: "attempt-1" });
  pending.resolve({ status: "approved", owner_user_id: "owner-a", device_id: DEVICE, device_token: "secret" });
  await rejectsCode(completion, "pairing_cancelled"); await cancellation;
  assert.equal(f.calls.includes("start"), false); assert.equal(f.calls.includes("cancel"), true);
});

test("cancel queued begin prevents exposing or creating a pairing", async () => {
  const f = fixture(); await f.account();
  const beginning = f.begin(); await f.controller.cancelConnect({ attemptId: "attempt-1" });
  await rejectsCode(beginning, "pairing_cancelled"); assert.equal(f.calls.includes("begin"), false);
});

test("late begin response is retained privately and cancelled even if transport ignores abort", async () => {
  const pending = deferred(), entered = deferred();
  const f = fixture({ controller: { begin: async () => { entered.resolve(); return pending.promise; } } });
  await f.account(); const beginning = f.begin(); await entered.promise;
  const cancellation = f.controller.cancelConnect({ attemptId: "attempt-1" });
  pending.resolve({ pairing_id: "pair-1", user_code: "ABCD-1234", device_code: "private", expires_in: 600 });
  await rejectsCode(beginning, "pairing_cancelled"); await cancellation;
  assert.equal(f.calls.includes("cancel"), true); assert.equal(f.state.has("embedded-pairing"), false);
});

test("connection waits for actual heartbeat; retry uses the same device and keeps cancellation authority", async () => {
  const f = fixture({ ready: false }); await f.account(); await f.begin();
  await rejectsCode(f.complete(), "connection_pending");
  // The tunnel exists but the backend cannot reach it yet. The actual daemon
  // reports reconnecting for this retryable first-heartbeat failure.
  f.state.set("status", { pid: 123, device_id: DEVICE, connection: "reconnecting",
    updated_at: new Date(f.time.value).toISOString(), last_heartbeat: null });
  assert.equal(f.controller.status().state, "connecting");
  assert.equal(f.controller.status().error, undefined);
  assert.equal(f.controller.status().online, false); assert.equal(f.state.has("embedded-pairing"), true);
  assert.equal(f.state.get("embedded-pairing").device_code, undefined);
  assert.equal(f.state.get("embedded-pairing").device_token, TOKEN);
  f.heartbeat(); assert.equal((await f.complete()).state, "connected");
  assert.equal(f.calls.filter((v) => v === "poll").length, 1);
  assert.equal(f.calls.filter((v) => v === "start").length, 1);
  // The host lost the success reply and cancels its exact latest attempt.
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  assert.equal(f.runtime.running(), false); assert.equal(f.calls.includes("cancel"), true); assert.equal(f.state.has("config"), false);
  assert.equal(f.calls.find((value) => value?.pairing_id).device_code, SECRET);
});

test("cancelled or failed first-heartbeat setup stops, clears its attempt, and permits a fresh connection", async () => {
  for (const failRuntime of [false, true]) {
    let failNextWait = false;
    const options = { ready: false, controller: { sleep: async (ms) => {
      f.time.value += ms;
      if (failNextWait) await f.runtime.stop();
    } } };
    const f = fixture(options); await f.account(); await f.begin();
    await rejectsCode(f.complete(), "connection_pending");
    f.state.set("status", { pid: 123, device_id: DEVICE, connection: "reconnecting",
      updated_at: new Date(f.time.value).toISOString(), last_heartbeat: null });
    assert.equal(f.controller.status().state, "connecting");
    if (failRuntime) {
      failNextWait = true;
      await rejectsCode(f.complete(), "connection_failed");
      assert.equal(f.controller.status().state, "error");
      assert.equal(f.controller.status().error, "connection_failed");
    }
    // The host cancels on user action or after a non-retryable failure.
    const cancelled = await f.controller.cancelConnect({ attemptId: "attempt-1" });
    assert.equal(cancelled.state, "disconnected"); assert.equal(cancelled.error, undefined);
    assert.equal(f.runtime.running(), false);
    assert.equal(f.state.has("config"), false); assert.equal(f.state.has("embedded-pairing"), false);
    await f.account(); assert.equal(f.runtime.running(), false);
    options.ready = true;
    assert.deepEqual(await f.begin("attempt-2"), { attemptId: "attempt-2", userCode: "ABCD-1234" });
    assert.equal((await f.complete("attempt-2")).state, "connected");
    assert.equal(f.calls.filter((value) => value === "begin").length, 2);
    await f.controller.dispose();
  }
});

test("pending setup preserves revocation and reconnect failures after an acknowledged heartbeat", async () => {
  const f = fixture({ ready: false }); await f.account(); await f.begin();
  await rejectsCode(f.complete(), "connection_pending");
  f.state.set("status", { pid: 123, device_id: DEVICE, connection: "revoked",
    updated_at: new Date(f.time.value).toISOString(), last_heartbeat: null });
  assert.equal(f.controller.status().state, "error");
  assert.equal(f.controller.status().error, "connection_failed");
  f.heartbeat(); f.state.get("status").connection = "reconnecting";
  assert.equal(f.controller.status().state, "error");
  assert.equal(f.controller.status().error, "connection_failed");
  await f.controller.dispose();
});

test("cancelled resume stays paused after account refresh even when its first heartbeat never arrived", async () => {
  const f = fixture({ ready: false }); f.state.set("config", saved({ paused: true })); await f.account(); await f.begin();
  await rejectsCode(f.complete(), "connection_pending");
  await f.controller.cancelConnect({ attemptId: "attempt-1" }); await f.account();
  assert.equal(f.runtime.running(), false); assert.equal(f.state.get("config").paused, true);
  assert.equal(f.state.get("config").device_token, TOKEN); assert.equal(f.calls.includes("cancel"), false);
});

test("cancelled enabled retry survives quit and reopens the same device after account verification", async () => {
  const f = fixture({ ready: false }); f.state.set("config", saved());
  await f.account(); await f.begin(); await rejectsCode(f.complete(), "connection_pending");
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  assert.equal(f.runtime.running(), false);
  assert.equal(f.state.get("config").paused, false);
  await f.controller.dispose();

  const reopened = fixture({ state: f.state });
  assert.equal(reopened.runtime.running(), false);
  assert.equal(reopened.controller.status().deviceId, undefined);
  await reopened.account(null, [], false);
  await reopened.account("owner-b", [DEVICE]);
  await reopened.account("owner-a", []);
  assert.equal(reopened.runtime.running(), false);
  await reopened.account();
  assert.equal(reopened.controller.status().state, "connected");
  assert.equal(reopened.controller.status().deviceId, DEVICE);
  assert.equal(reopened.state.get("config").device_token, TOKEN);
  assert.equal(reopened.calls.filter(value => value === "start").length, 1);
  assert.equal([...f.calls, ...reopened.calls].some(value => ["begin", "poll", "cancel"].includes(value)), false);
  await reopened.controller.dispose();
});

test("late completed retry cancellation preserves enabled consent and duplicate cancellation is harmless", async () => {
  const f = fixture(); f.state.set("config", saved());
  await f.account(); await f.begin(); await f.complete();
  // The runtime completed, but the app closed before consuming its success.
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  assert.equal(f.runtime.running(), false);
  assert.equal(f.state.get("config").paused, false);
  await f.account();
  assert.equal(f.controller.status().state, "connected");
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  assert.equal(f.controller.status().state, "connected");
  assert.equal(f.state.get("config").paused, false);
  assert.equal(f.calls.includes("cancel"), false);
  await f.controller.dispose();
});

test("cancelled explicitly paused resume remains paused across a new controller", async () => {
  const f = fixture({ ready: false }); f.state.set("config", saved({ paused: true }));
  await f.account(); await f.begin(); await rejectsCode(f.complete(), "connection_pending");
  await f.controller.cancelConnect({ attemptId: "attempt-1" }); await f.controller.dispose();
  const reopened = fixture({ state: f.state }); await reopened.account();
  assert.equal(reopened.controller.status().state, "paused");
  assert.equal(reopened.runtime.running(), false);
  assert.equal(reopened.state.get("config").device_token, TOKEN);
  await reopened.controller.dispose();
});

test("late enabled retry cancellation never undoes an explicit disconnect or revocation", async () => {
  for (const restriction of ["disconnect", "revocation"]) {
    const f = fixture(); f.state.set("config", saved());
    await f.account(); await f.begin(); await f.complete();
    // Queue cancellation before the newer control change to exercise its
    // serialized cleanup after the newer decision has changed durable state.
    const cancelling = f.controller.cancelConnect({ attemptId: "attempt-1" });
    if (restriction === "disconnect") await f.controller.disconnect();
    else f.state.set("config", { ...f.state.get("config"), revoked: true });
    await cancelling;
    await f.account();
    assert.equal(f.runtime.running(), false, restriction);
    assert.equal(f.state.get("config")[restriction === "disconnect" ? "paused" : "revoked"], true, restriction);
    await f.controller.dispose();
  }
});

test("enabled retry cancellation preserves device removal and cannot run under another account", async () => {
  for (const restriction of ["removal", "account-change"]) {
    const f = fixture({ ready: false }); f.state.set("config", saved());
    await f.account(); await f.begin(); await rejectsCode(f.complete(), "connection_pending");
    const cancellation = f.controller.cancelConnect({ attemptId: "attempt-1" });
    if (restriction === "removal") await f.account("owner-a", []);
    else await f.account("owner-b", [DEVICE]);
    await cancellation;
    assert.equal(f.runtime.running(), false, restriction);
    if (restriction === "removal") {
      assert.equal(f.state.get("config").paused, true);
      await f.account();
      assert.equal(f.runtime.running(), false);
    } else {
      assert.equal(f.controller.status().deviceId, undefined);
      assert.equal(f.state.get("config").paused, false);
      await f.account();
      assert.equal(f.runtime.running(), true);
    }
    await f.controller.dispose();
  }
});

test("verified same-account device removal aborts an in-flight readiness wait immediately", async () => {
  const waiting = deferred();
  const f = fixture({ ready: false, controller: { sleep: (_ms, signal) => new Promise((_resolve, reject) => {
    waiting.resolve(); signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "pairing_cancelled" })), { once: true });
  }) } });
  f.state.set("config", saved({ paused: true })); await f.account(); await f.begin();
  const completing = f.complete(); await waiting.promise;
  const removed = f.account("owner-a", []);
  await rejectsCode(completing, "pairing_cancelled"); await removed;
  assert.equal(f.runtime.running(), false); assert.equal(f.state.get("config").paused, true);
  await f.account(); assert.equal(f.runtime.running(), false); assert.equal(f.calls.includes("cancel"), false);
});

test("older completed cancellation cannot affect a newer connection attempt", async () => {
  const f = fixture(); await f.account(); await f.begin(); await f.complete();
  await f.controller.disconnect(); await f.begin("attempt-2"); await f.complete("attempt-2");
  await f.controller.cancelConnect({ attemptId: "attempt-1" });
  assert.equal(f.controller.status().online, true); assert.equal(f.calls.includes("cancel"), false);
});

test("failed cancellation stops local access and retains only its private retry capability", async () => {
  let failing = true;
  const f = fixture({ controller: { cancel: async () => { if (failing) throw new Error("private raw diagnostic"); } } });
  await f.account(); await f.begin();
  await rejectsCode(f.controller.cancelConnect({ attemptId: "attempt-1" }), "cancel_failed");
  assert.equal(f.runtime.running(), false); assert.equal(f.state.has("embedded-pairing"), true);
  assert.equal(f.controller.status().error, "cancel_failed");
  failing = false; await f.controller.disconnect(); assert.equal(f.state.has("embedded-pairing"), false);
});

test("orphaned approval is cancelled before reopening can resume, while standalone state is refused", async () => {
  const f = fixture(); f.state.set("config", saved());
  f.state.set("embedded-pairing", { pairing_id: "pair-1", device_code: "private", deviceId: DEVICE, expiresAt: f.time.value + 60000 });
  f.controller.status(); assert.deepEqual(f.calls, []);
  await f.account(); assert.equal(f.calls.includes("cancel"), true); assert.equal(f.calls.includes("start"), false);
  f.state.set("config", { device_id: "standalone" });
  await rejectsCode(f.account(), "invalid_request"); assert.deepEqual(f.state.get("config"), { device_id: "standalone" });
});

test("stale or wrong-process status cannot report connected or granted permission", async () => {
  const f = fixture(); f.state.set("config", saved()); await f.account();
  f.state.get("status").pid = 456;
  assert.equal(f.controller.status().online, false); assert.equal(f.controller.status().permissions.accessibility, "unknown");
  f.heartbeat(); f.time.value += 90001; assert.equal(f.controller.status().online, false);
});

test("pending cancellation file read through actual computer API contains only the recognizable full credential", async () => {
  const f = fixture({ ready: false }); await f.account(); await f.begin(); await rejectsCode(f.complete(), "connection_pending");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pending-read-")), file = path.join(directory, "embedded-pairing.json");
  fs.writeFileSync(file, JSON.stringify(f.state.get("embedded-pairing")), { mode: 0o600 });
  const server = await startServer({ port: 0, token: "synthetic-request-token" });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/read?path=${encodeURIComponent(file)}`, { headers: { "x-token": "synthetic-request-token" } });
    assert.equal(response.status, 200);
    const result = await response.json(), record = JSON.parse(result.content);
    assert.equal(record.device_code, undefined); assert.equal(record.device_token, TOKEN);
    // The existing backend boundary applies its sbd_UUID.secret redactor. This
    // local transport test proves there is no separate bare secret to miss.
    assert.equal(result.content.replace(TOKEN, "[REDACTED]").includes(SECRET), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); await f.controller.dispose(); }
});

test("UI detach preserves an established connection and repeated detach is idempotent", async () => {
  const f = fixture(); await f.account(); await f.begin(); await f.complete();
  const before = [...f.calls], config = structuredClone(f.state.get("config"));
  for (let count = 0; count < 2; count++) {
    assert.equal((await f.controller.detach()).online, true);
    assert.equal(f.runtime.pid(), 123);
    assert.deepEqual(f.calls, before); assert.deepEqual(f.state.get("config"), config);
  }
  await f.controller.disconnect(); await f.account();
  assert.equal(f.runtime.running(), false); assert.equal(f.state.get("config").paused, true);
  await f.begin("attempt-2"); await f.complete("attempt-2"); await f.controller.detach();
  await f.account("owner-b", ["device-b"]);
  assert.equal(f.runtime.running(), false); assert.equal(f.controller.status().deviceId, undefined);
});

test("detach invalidates queued and in-flight setup but permits a fresh attempt", async () => {
  for (const phase of ["queued", "begin", "poll"]) {
    const entered = deferred(), pending = deferred();
    const f = fixture({ controller: phase === "begin" ? { begin: async () => { entered.resolve(); return pending.promise; } } :
      phase === "poll" ? { poll: async () => { entered.resolve(); return pending.promise; } } : {} });
    await f.account();
    if (phase === "poll") await f.begin();
    const operation = phase === "poll" ? f.complete() : f.begin();
    const rejected = rejectsCode(operation, "pairing_cancelled");
    if (phase !== "queued") await entered.promise;
    const detached = f.controller.detach();
    if (phase === "begin") pending.resolve({ pairing_id: "pair-1", device_code: SECRET, user_code: "ABCD-1234", expires_in: 600 });
    if (phase === "poll") pending.resolve({ status: "approved", owner_user_id: "owner-a", device_id: DEVICE, device_token: TOKEN });
    await rejected; await detached; await f.controller.detach();
    assert.equal(f.state.has("config"), false); assert.equal(f.state.has("embedded-pairing"), false);
    assert.equal(f.runtime.running(), false); assert.equal(f.calls.includes("start"), false);
    assert.equal(f.calls.includes("cancel"), phase !== "queued");
    await f.begin("attempt-2");
    assert.equal((await f.complete("attempt-2")).online, true);
    await f.controller.dispose(); assert.equal(f.runtime.running(), false);
  }
});

test("detach during first-heartbeat wait revokes new pairing and pauses a resumed device", async () => {
  for (const resume of [false, true]) {
    const waiting = deferred();
    const f = fixture({ ready: false, controller: { sleep: (_ms, signal) => new Promise((_resolve, reject) => {
      waiting.resolve(); signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "pairing_cancelled" })), { once: true });
    }) } });
    if (resume) f.state.set("config", saved({ paused: true }));
    await f.account(); await f.begin();
    const completing = f.complete(), rejected = rejectsCode(completing, "pairing_cancelled");
    await waiting.promise;
    await f.controller.detach(); await rejected;
    assert.equal(f.runtime.running(), false); assert.equal(f.state.has("embedded-pairing"), false);
    assert.equal(f.calls.includes("cancel"), !resume);
    if (resume) { assert.equal(f.state.get("config").paused, true); assert.equal(f.state.get("config").device_token, TOKEN); }
    else assert.equal(f.state.has("config"), false);
    await f.account(); assert.equal(f.runtime.running(), false);
  }
});

test("detach cancellation failure remains retryable and never leaves local access active", async () => {
  let failed = true;
  const f = fixture({ ready: false, controller: { cancel: async () => { if (failed) throw new Error("unavailable"); } } });
  await f.account(); await f.begin(); await rejectsCode(f.complete(), "connection_pending");
  await rejectsCode(f.controller.detach(), "cancel_failed");
  assert.equal(f.runtime.running(), false); assert.equal(f.state.get("config").paused, true);
  assert.equal(f.state.has("embedded-pairing"), true);
  failed = false; await f.controller.detach();
  assert.equal(f.state.has("config"), false); assert.equal(f.state.has("embedded-pairing"), false);
  assert.equal(f.controller.status().state, "disconnected");
});
