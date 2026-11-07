"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createComputerControl } = require("../src/computer");
const { startServer } = require("../src/server");

const SCOPE = "a".repeat(64), OTHER = "b".repeat(64);
const screen = () => ({ success: true, result: { width: 1200, height: 800, display_id: 42,
  bounds: { x: -1440, y: 0, width: 1440, height: 960 }, frontmost: { pid: 123 },
  image_base64: "fixture", image_content_type: "image/jpeg" } });
function fixture(options = {}) {
  const calls = [];
  const control = createComputerControl({ platform: "darwin", available: () => true,
    invoke: async (request) => { calls.push(request); return request.operation === "observe" ? screen()
      : { success: true, result: { dispatched: true, delivery_verified: false } }; }, ...options });
  const run = (value, scope = SCOPE) => control.execute({ scope, control: value });
  const observe = async (scope) => (await run({ operation: "observe" }, scope)).result.observation_id;
  return { control, calls, run, observe };
}

test("observations are actor/chat scoped, one-use, and preserve display geometry", async () => {
  const f = fixture(), id = await f.observe();
  const click = { operation: "click", observation_id: id, point: [1199, 799] };
  assert.equal((await f.run(click, OTHER)).error_type, "stale_observation");
  assert.equal(f.calls.length, 1);
  assert.equal((await f.run(click)).result.delivery_verified, false);
  assert.deepEqual(f.calls[1].expected, { pid: 123, display_id: 42,
    bounds: { x: -1440, y: 0, width: 1440, height: 960 }, width: 1200, height: 800 });
  assert.equal((await f.run(click)).error_type, "stale_observation");
  assert.equal(f.calls.length, 2);
});

test("new captures and expiry invalidate image coordinates; invalid input never posts", async () => {
  let now = 0;
  const f = fixture({ now: () => now }), old = await f.observe(), id = await f.observe();
  assert.equal((await f.run({ operation: "type", text: "a", observation_id: old })).error_type, "stale_observation");
  for (const control of [
    { operation: "click", point: [1200, 0] }, { operation: "drag", point: [1, 2], to: [NaN, 0] },
    { operation: "press_key", keys: ["CMD", "CMD", "A"] }, { operation: "type", text: "x".repeat(4097) },
    { operation: "observe", expected: { pid: 123 } }, { operation: ["observe"] },
  ]) assert.equal((await f.run({ observation_id: id, ...control })).error_type, "invalid_arguments");
  now = 30001;
  assert.equal((await f.run({ operation: "type", text: "x", observation_id: id })).error_type, "stale_observation");
  assert.equal(f.calls.length, 2);
});

test("a lost native response consumes input and forbids replay", async () => {
  let inputs = 0;
  const f = fixture({ invoke: async (r) => {
    if (r.operation === "observe") return screen(); inputs++; throw new Error("lost response");
  } });
  const command = { operation: "type", text: "once", observation_id: await f.observe() };
  assert.equal((await f.run(command)).outcome_unknown, true);
  assert.equal((await f.run(command)).error_type, "stale_observation");
  assert.equal(inputs, 1);
});

test("permission denial and changed desktop fail without a success receipt", async () => {
  for (const reason of ["accessibility_denied", "screen_recording_denied", "desktop_changed", "secure_input"]) {
    const f = fixture({ invoke: async (r) => r.operation === "observe" ? screen()
      : { success: false, error_type: reason, dispatched: false } });
    const command = { operation: "press_key", keys: ["TAB"], observation_id: await f.observe() };
    assert.deepEqual(await f.run(command), { success: false, error_type: reason, dispatched: false, retryable: false });
    assert.equal((await f.run(command)).error_type, "stale_observation");
  }
});

test("simultaneous computer actions are rejected, never queued behind a stale image", async () => {
  let release;
  const f = fixture({ invoke: () => new Promise((r) => { release = r; }) });
  const pending = f.run({ operation: "observe" });
  assert.equal((await f.run({ operation: "observe" }, OTHER)).error_type, "computer_busy");
  release(screen()); assert.equal((await pending).success, true);
});

test("HTTP computer actions require the daemon token and use the exact bounded contract", async () => {
  const f = fixture();
  const server = await startServer({ port: 0, token: "synthetic-computer-token", computerControl: f.control });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const request = { method: "POST", body: JSON.stringify({ scope: SCOPE, control: { operation: "observe" } }) };
    assert.equal((await fetch(`${base}/computer`, request)).status, 401);
    assert.equal(f.calls.length, 0);
    const response = await fetch(`${base}/computer`, { ...request, headers: { "x-token": "synthetic-computer-token" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    const unsupported = fixture({ available: () => false });
    assert.equal((await unsupported.run({ operation: "observe" })).error_type, "computer_unsupported");
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
