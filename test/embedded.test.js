"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEmbeddedController } = require("../src/embedded");
const { startServer } = require("../src/server");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const DEVICE = "11111111-1111-4111-8111-111111111111", SECRET = "a".repeat(43), TOKEN = `sbd_${DEVICE}.${SECRET}`;

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(options = {}) {
  const state = new Map(), calls = [], time = { value: Date.now() };
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
  assert.equal(f.controller.status().state, "connecting");
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

test("cancelled resume stays paused after account refresh even when its first heartbeat never arrived", async () => {
  const f = fixture({ ready: false }); f.state.set("config", saved({ paused: true })); await f.account(); await f.begin();
  await rejectsCode(f.complete(), "connection_pending");
  await f.controller.cancelConnect({ attemptId: "attempt-1" }); await f.account();
  assert.equal(f.runtime.running(), false); assert.equal(f.state.get("config").paused, true);
  assert.equal(f.state.get("config").device_token, TOKEN); assert.equal(f.calls.includes("cancel"), false);
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
