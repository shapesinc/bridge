"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createComputerControl } = require("../src/computer");
const { createShapeCursor } = require("../src/computer-cursor");
const { startServer } = require("../src/server");

const SCOPE = "a".repeat(64), OTHER = "b".repeat(64);
const WINDOW = { window_id: 77, title: "Notes.txt", bounds: { x: 100, y: 50, width: 600, height: 400 } };
const display = () => ({ success: true, result: { width: 1200, height: 800, display_id: 42, input: "look_only",
  bounds: { x: -1440, y: 0, width: 1440, height: 960 }, frontmost: { pid: 123 },
  image_base64: "fixture", image_content_type: "image/jpeg" } });
const targeted = (kind = "app") => ({ success: true, result: { width: 1200, height: 800, display_id: 42, input: "background",
  bounds: WINDOW.bounds, frontmost: { pid: 123, bundle_id: "com.example.front", name: "Front" },
  target: { kind, pid: 456, bundle_id: "com.example.notes", name: "Notes", ...(kind === "window" ? { window_id: 77, title: "Notes.txt" } : {}) },
  windows: [WINDOW], image_base64: "fixture", image_content_type: "image/jpeg" } });
const sent = () => ({ success: true, result: { dispatched: true, delivery_verified: false, delivery: "background", via: "accessibility",
  pointer: { x: 400, y: 250 }, message: "Sent to the app in the background." } });
function fixture(options = {}) {
  const calls = [], pointer = [];
  const control = createComputerControl({ platform: "darwin", available: () => true, cursorLeadMs: 0,
    cursor: { send: (command) => pointer.push(command), close() {} },
    invoke: async (request) => { calls.push(request);
      if (request.operation === "observe") return request.app || request.window_id ? targeted(request.window_id ? "window" : "app") : display();
      return sent(); }, ...options });
  const run = (value, scope = SCOPE, extra = {}) => control.execute({ scope, control: value, ...extra });
  const observe = async (target = { app: "Notes" }, scope) => (await run({ operation: "observe", ...target }, scope)).result.observation_id;
  return { control, calls, pointer, run, observe };
}

test("a whole-display image is look-only on macOS: input never reaches the helper", async () => {
  const f = fixture(), id = await f.observe({});
  const reply = await f.run({ operation: "click", observation_id: id, point: [10, 10] });
  assert.equal(reply.error_type, "background_target_required");
  assert.equal(reply.dispatched, false);
  assert.equal(reply.delivery, "background");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.pointer, []);
});

test("app observations are actor/chat scoped, one-use, and bind the target's windows", async () => {
  const f = fixture(), id = await f.observe();
  const click = { operation: "click", observation_id: id, point: [1199, 799] };
  assert.equal((await f.run(click, OTHER)).error_type, "stale_observation");
  assert.equal(f.calls.length, 1);
  const reply = await f.run(click, SCOPE, { delivery: "background", cursor: { label: "Nyx" } });
  assert.deepEqual(reply, { success: true, delivery: "background", result: { dispatched: true, delivery_verified: false,
    delivery: "background", message: "Sent to the app in the background." } });
  assert.deepEqual(f.calls[1].expected, { kind: "app", pid: 456, bundle_id: "com.example.notes", display_id: 42,
    bounds: WINDOW.bounds, width: 1200, height: 800, windows: [{ window_id: 77, bounds: WINDOW.bounds }] });
  assert.equal((await f.run(click)).error_type, "stale_observation");
  assert.equal(f.calls.length, 2);
});

test("the shape pointer leads to the target point and shows the shape's name; typing only pulses it", async () => {
  const f = fixture();
  await f.run({ operation: "click", observation_id: await f.observe(), point: [600, 400] }, SCOPE, { cursor: { label: "Nyx" } });
  // Image (600,400) of 1200x800 over a 600x400 window at (100,50) is global (400,250).
  assert.deepEqual(f.pointer, [{ op: "move", x: 400, y: 250, label: "Nyx" }, { op: "click", x: 400, y: 250 }]);
  await f.run({ operation: "type", text: "hi", observation_id: await f.observe() });
  assert.deepEqual(f.pointer.at(-1), { op: "key" });
});

test("window observations must come back for the requested window", async () => {
  const wrong = fixture({ invoke: async () => targeted("app") });
  assert.equal((await wrong.run({ operation: "observe", window_id: 77 })).error_type, "invalid_native_reply");
  const f = fixture(), id = await f.observe({ window_id: 77 });
  assert.equal((await f.run({ operation: "scroll", observation_id: id, point: [5, 5], dx: 0, dy: -200 })).success, true);
  assert.equal(f.calls[1].expected.kind, "window");
});

test("new captures and expiry invalidate image coordinates; invalid input never posts", async () => {
  let now = 0;
  const f = fixture({ now: () => now }), old = await f.observe(), id = await f.observe();
  assert.equal((await f.run({ operation: "type", text: "a", observation_id: old })).error_type, "stale_observation");
  for (const control of [
    { operation: "click", point: [1200, 0] }, { operation: "drag", point: [1, 2], to: [NaN, 0] },
    { operation: "press_key", keys: ["CMD", "CMD", "A"] }, { operation: "type", text: "x".repeat(4097) },
    { operation: "observe", expected: { pid: 123 } }, { operation: ["observe"] },
    { operation: "observe", app: "Notes", window_id: 3 }, { operation: "observe", app: "Notes‮" },
    { operation: "windows", app: "Notes" },
  ]) assert.equal((await f.run({ observation_id: id, ...control })).error_type, "invalid_arguments");
  for (const extra of [{ delivery: "global" }, { cursor: { label: "x".repeat(41) } }, { cursor: { color: "red" } }, { mode: "background" }]) {
    assert.equal((await f.run({ operation: "type", text: "x", observation_id: id }, SCOPE, extra)).error_type, "invalid_arguments");
  }
  now = 30001;
  assert.equal((await f.run({ operation: "type", text: "x", observation_id: id })).error_type, "stale_observation");
  assert.equal(f.calls.length, 2);
});

test("a lost native response consumes input and forbids replay", async () => {
  let inputs = 0;
  const f = fixture({ invoke: async (r) => {
    if (r.operation === "observe") return targeted(); inputs++; throw new Error("lost response");
  } });
  const command = { operation: "type", text: "once", observation_id: await f.observe() };
  assert.equal((await f.run(command)).outcome_unknown, true);
  assert.equal((await f.run(command)).error_type, "stale_observation");
  assert.equal(inputs, 1);
});

test("an input receipt without background delivery is an unknown outcome, never a success", async () => {
  const f = fixture({ invoke: async (r) => r.operation === "observe" ? targeted()
    : { success: true, result: { dispatched: true, delivery_verified: false } } });
  const reply = await f.run({ operation: "press_key", keys: ["RETURN"], observation_id: await f.observe() });
  assert.equal(reply.error_type, "invalid_native_reply");
  assert.equal(reply.outcome_unknown, true);
});

test("permission denial, changed targets and blockers fail without a success receipt", async () => {
  for (const reason of ["accessibility_denied", "screen_recording_denied", "target_changed", "outside_target", "secure_input"]) {
    const f = fixture({ invoke: async (r) => r.operation === "observe" ? targeted()
      : { success: false, error_type: reason, dispatched: false } });
    const command = { operation: "press_key", keys: ["TAB"], observation_id: await f.observe() };
    assert.deepEqual(await f.run(command), { success: false, error_type: reason, dispatched: false, retryable: false, delivery: "background" });
    assert.equal((await f.run(command)).error_type, "stale_observation");
  }
});

test("window discovery returns only bounded, allowlisted fields and needs no observation", async () => {
  const list = { apps: [{ name: "Notes", bundle_id: "com.example.notes", pid: 456, frontmost: false, extra: "drop",
    windows: [{ ...WINDOW, secret: "drop" }] }] };
  const f = fixture({ invoke: async () => ({ success: true, result: list }) });
  assert.deepEqual(await f.run({ operation: "windows" }), { success: true, delivery: "background", result: { apps: [
    { name: "Notes", bundle_id: "com.example.notes", pid: 456, frontmost: false, windows: [WINDOW] }] } });
  const bad = fixture({ invoke: async () => ({ success: true, result: { apps: [{ name: "x" }] } }) });
  assert.equal((await bad.run({ operation: "windows" })).error_type, "invalid_native_reply");
});

test("Windows refuses background delivery and app targets instead of using the foreground", async () => {
  const calls = [];
  const control = createComputerControl({ platform: "win32", available: () => true, invoke: async (r) => { calls.push(r); return display(); } });
  for (const body of [{ control: { operation: "observe", app: "Notes" } }, { control: { operation: "windows" } },
    { control: { operation: "observe" }, delivery: "background" }]) {
    const reply = await control.execute({ scope: SCOPE, ...body });
    assert.equal(reply.error_type, "background_unsupported");
    assert.equal(reply.dispatched, false);
  }
  assert.equal(calls.length, 0);
});

test("simultaneous computer actions are rejected, never queued behind a stale image", async () => {
  let release;
  const f = fixture({ invoke: () => new Promise((r) => { release = r; }) });
  const pending = f.run({ operation: "observe" });
  assert.equal((await f.run({ operation: "observe" }, OTHER)).error_type, "computer_busy");
  release(display()); assert.equal((await pending).success, true);
});

test("the pointer process is spawned once, fed lines, and never on other platforms", () => {
  const spawned = [];
  const fake = () => { const lines = []; const child = { exitCode: null, signalCode: null, lines, on() {}, unref() {},
    stdin: { writable: true, write: (l) => lines.push(l), on() {}, unref() {}, end() { this.writable = false; } } };
  spawned.push(child); return child; };
  const cursor = createShapeCursor({ platform: "darwin", binary: "/bin/helper", spawnImpl: fake });
  cursor.send({ op: "move", x: 1, y: 2 }); cursor.send({ op: "key" });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].lines, ['{"op":"move","x":1,"y":2}\n', '{"op":"key"}\n']);
  cursor.close(); cursor.send({ op: "key" });
  assert.equal(spawned.length, 2);
  assert.equal(createShapeCursor({ platform: "win32", binary: "x", spawnImpl: fake }).send({ op: "key" }), false);
  assert.equal(spawned.length, 2);
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
