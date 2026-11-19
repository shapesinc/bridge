"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createComputerControl, validateControl } = require("../src/computer");
const { startServer } = require("../src/server");

const SCOPE = "a".repeat(64), OTHER = "b".repeat(64);
const windowCapture = (pid = 9) => ({ success: true, result: { width: 800, height: 600, display_id: 0, window_id: 162,
  window_title: "Activity - Slack", bounds: { x: 25, y: 38, width: 1073, height: 805 },
  app: { pid, bundle_id: "com.example.chat", name: "Chat" }, frontmost: { pid: 1, name: "Other" }, launched: false,
  elements: [{ index: 0, role: "Button", label: "Activity", frame: [1, 2, 30, 20] }],
  element_identities: [{ index: 0, role: "AXButton", frame: { x: 26, y: 40, width: 40, height: 27 } }],
  image_base64: "fixture", image_content_type: "image/jpeg" } });
function fixture(options = {}) {
  const calls = [];
  let hold, held = false;
  const control = createComputerControl({ platform: "darwin", available: () => true, invoke: async (request) => {
    calls.push(request);
    if (options.hold && !held && request.operation !== "observe") { held = true; await new Promise((r) => { hold = r; }); }
    if (request.operation === "apps") return { success: true, result: { apps: [{ name: "Chat", windows: [] }] } };
    if (request.operation === "observe") return request.app ? windowCapture() : { success: true, result: { width: 100, height: 80,
      display_id: 1, bounds: { x: 0, y: 0, width: 100, height: 80 }, frontmost: { pid: 1, name: "Other" },
      image_base64: "fixture", image_content_type: "image/jpeg" } };
    return { success: true, result: { dispatched: true, delivery_verified: false, method: "accessibility" } };
  }, ...options });
  const run = (value, scope = SCOPE) => control.execute({ scope, control: value });
  return { control, calls, run, release: () => hold?.() };
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

test("elements and menus need an app observation; screen observations stay screen-only", async () => {
  const f = fixture();
  const screen = await f.run({ operation: "observe" });
  assert.match(screen.result.message, /frontmost app \(Other\)/);
  assert.equal((await f.run({ operation: "menu", path: ["File"], observation_id: screen.result.observation_id })).error_type, "invalid_arguments");
  assert.equal((await f.run({ operation: "apps" })).result.apps[0].name, "Chat");
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
