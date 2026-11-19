"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createComputerControl, validateControl } = require("../src/computer");
const { createShapeCursor } = require("../src/computer-cursor");
const { startServer } = require("../src/server");

const SCOPE = "a".repeat(64), OTHER = "b".repeat(64);
const windowCapture = (pid = 9) => ({ success: true, result: { width: 800, height: 600, display_id: 0, window_id: 162,
  window_title: "Activity - Slack", bounds: { x: 25, y: 38, width: 1073, height: 805 },
  app: { pid, bundle_id: "com.example.chat", name: "Chat" }, frontmost: { pid: 1, name: "Other" }, launched: false,
  elements: [{ index: 0, role: "Button", label: "Activity", frame: [1, 2, 30, 20] }],
  element_identities: [{ index: 0, role: "AXButton", frame: { x: 26, y: 40, width: 40, height: 27 } }],
  image_base64: "fixture", image_content_type: "image/jpeg" } });
function fixture(options = {}) {
  const calls = [], pointer = [];
  let hold, held = false;
  const control = createComputerControl({ platform: "darwin", available: () => true, cursorLeadMs: 0,
    cursor: { send: (command) => pointer.push(command), close() {} }, invoke: async (request) => {
    calls.push(request);
    if (options.hold && !held && request.operation !== "observe") { held = true; await new Promise((r) => { hold = r; }); }
    if (request.operation === "apps") return { success: true, result: { apps: [{ name: "Chat", windows: [] }] } };
    if (request.operation === "observe") return request.app ? windowCapture() : { success: true, result: { width: 100, height: 80,
      display_id: 1, bounds: { x: 0, y: 0, width: 100, height: 80 }, frontmost: { pid: 1, name: "Other" },
      image_base64: "fixture", image_content_type: "image/jpeg" } };
    return { success: true, result: { dispatched: true, delivery_verified: false, method: "accessibility",
      ...(request.operation === "click" ? { pointer: { x: 46, y: 53.5 } } : {}) } };
  }, ...options });
  const run = (value, scope = SCOPE, extra = {}) => control.execute({ scope, control: value, ...extra });
  return { control, calls, pointer, run, release: () => hold?.() };
}

test("app operations validate their own fields", () => {
  const id = "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12);
  for (const ok of [{ operation: "apps" }, { operation: "observe", app: "Slack" }, { operation: "observe", app: "Slack", window_id: 3 },
    { operation: "click", element: 2, observation_id: id }, { operation: "set_text", element: 1, text: "", observation_id: id },
    { operation: "menu", path: ["File", "New"], observation_id: id }]) assert.equal(validateControl(ok), true, JSON.stringify(ok));
  for (const bad of [{ operation: "observe", window_id: 3 }, { operation: "observe", app: "" }, { operation: "observe", app: "a\nb" },
    { operation: "observe", app: "Slack", display_id: 1 }, { operation: "click", element: 1, point: [1, 1], observation_id: id },
    { operation: "click", observation_id: id }, { operation: "menu", path: [], observation_id: id }, { operation: "apps", observation_id: id }])
    assert.equal(validateControl(bad), false, JSON.stringify(bad));
});

test("an app observation binds input to that app's window and its elements, once", async () => {
  const f = fixture();
  const seen = await f.run({ operation: "observe", app: "Chat" });
  assert.equal(seen.success, true);
  assert.equal(seen.result.element_identities, undefined);
  assert.equal(seen.result.elements[0].label, "Activity");
  const click = { operation: "click", element: 0, observation_id: seen.result.observation_id };
  assert.equal((await f.run(click, OTHER)).error_type, "stale_observation");
  assert.equal((await f.run(click)).success, true);
  assert.deepEqual(f.calls.at(-1).expected, { mode: "app", pid: 9, window_id: 162, bounds: windowCapture().result.bounds,
    width: 800, height: 600, element_identities: windowCapture().result.element_identities });
  assert.equal((await f.run(click)).error_type, "stale_observation");
});

test("on a Mac a whole-screen view is look-only: its input never reaches the helper", async () => {
  const f = fixture();
  const screen = await f.run({ operation: "observe" });
  assert.equal(screen.result.input, "look_only");
  assert.match(screen.result.message, /^Look only/);
  for (const input of [{ operation: "click", point: [10, 10] }, { operation: "type", text: "hi" }, { operation: "press_key", keys: ["RETURN"] },
    { operation: "menu", path: ["File"] }]) {
    const reply = await f.run({ ...input, observation_id: screen.result.observation_id });
    assert.equal(reply.error_type, "background_target_required", JSON.stringify(input));
    assert.equal(reply.dispatched, false);
  }
  assert.deepEqual(f.calls.map((c) => c.operation), ["observe"]);
  assert.equal((await f.run({ operation: "apps" })).result.apps[0].name, "Chat");
});

test("every Mac reply says input is background-only, so a server can tell it from an older Bridge", async () => {
  const f = fixture();
  for (const control of [{ operation: "apps" }, { operation: "observe", app: "Chat" }, { operation: "click", element: 9, observation_id: "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12) }])
    assert.equal((await f.run(control)).delivery, "background");
  assert.equal((await f.run({ operation: "apps" }, SCOPE, { delivery: "background" })).error_type, "invalid_arguments");
});

test("the shape's pointer leads to the element or point it acts on and carries its name", async () => {
  const f = fixture();
  const seen = await f.run({ operation: "observe", app: "Chat" }, SCOPE, { cursor: { label: "Nyx" } });
  await f.run({ operation: "click", element: 0, observation_id: seen.result.observation_id });
  // Element 0's global frame is (26,40) 40x27: its centre, then the helper's reported point.
  assert.deepEqual(f.pointer, [{ op: "move", x: 46, y: 53.5, label: "Nyx" }, { op: "click", x: 46, y: 53.5 }]);
  assert.equal(f.calls.at(-1).pointer, undefined);
  const again = await f.run({ operation: "observe", app: "Chat" }, SCOPE, { cursor: { label: "Nyx" } });
  await f.run({ operation: "click", point: [400, 300], observation_id: again.result.observation_id });
  // Image (400,300) of 800x600 over the window at (25,38) 1073x805.
  assert.deepEqual(f.pointer[2], { op: "move", x: 25 + 1073 / 2, y: 38 + 805 / 2, label: "Nyx" });
  const third = await f.run({ operation: "observe", app: "Chat" });
  await f.run({ operation: "type", text: "hi", observation_id: third.result.observation_id });
  assert.deepEqual(f.pointer.at(-1), { op: "key" });
  for (const cursor of [{ label: "x".repeat(41) }, { label: "Nyx\u202e" }, { color: "red" }, "Nyx"])
    assert.equal((await f.run({ operation: "observe", app: "Chat" }, SCOPE, { cursor })).error_type, "invalid_arguments");
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

test("app work runs in parallel and does not invalidate other chats' observations", async () => {
  const f = fixture({ hold: true });
  const other = await f.run({ operation: "observe", app: "Chat" }, OTHER);
  const mine = await f.run({ operation: "observe", app: "Chat" });
  const pending = f.run({ operation: "click", element: 0, observation_id: mine.result.observation_id });
  await new Promise((r) => setImmediate(r));
  const parallel = await f.run({ operation: "observe", app: "Chat" }, OTHER);
  assert.equal(parallel.success, true);
  f.release(); assert.equal((await pending).success, true);
  // Using one observation never voids another chat's still-valid one.
  const again = await f.run({ operation: "observe", app: "Chat" });
  const third = "c".repeat(64);
  const theirs = await f.run({ operation: "observe", app: "Chat" }, third);
  await f.run({ operation: "click", element: 0, observation_id: again.result.observation_id });
  assert.equal((await f.run({ operation: "click", element: 0, observation_id: theirs.result.observation_id }, third)).success, true);
  assert.ok(other.success);
});

test("Windows and older platforms report app control unavailable without dispatching", async () => {
  const calls = [];
  const control = createComputerControl({ platform: "win32", available: () => true, invoke: async (r) => { calls.push(r); return {}; } });
  const result = await control.execute({ scope: SCOPE, control: { operation: "observe", app: "Notepad" } });
  assert.equal(result.error_type, "computer_unsupported");
  assert.equal(calls.length, 0);
  assert.equal(control.appControlAvailable(), false);
});

test("capabilities advertise background app control separately", async () => {
  const f = fixture();
  const server = await startServer({ port: 0, token: "synthetic-computer-token", computerControl: f.control });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/capabilities`, { headers: { "x-token": "synthetic-computer-token" } });
    const body = await response.json();
    assert.equal(body.features.computer_control, true);
    assert.equal(body.features.computer_app_control, true);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
