"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createComputerControl, nativePath } = require("../src/computer");

const scope = "a".repeat(64);
const capture = () => ({ success: true, result: { width: 1200, height: 800, display_id: 42,
  display_device: "\\\\.\\DISPLAY1", bounds: { x: -1440, y: 0, width: 1440, height: 960 },
  frontmost: { pid: 123, window_id: "123456", process_started: "638650000000000000" },
  image_base64: "fixture", image_content_type: "image/jpeg" } });

test("Windows computer availability requires its actual packaged executable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-computer-package-"));
  try {
    const binary = nativePath("win32", path.join(directory, "node.exe"));
    assert.equal(path.basename(binary), "shapes.inc Bridge Computer.exe");
    assert.equal(createComputerControl({ platform: "win32", binary }).available(), false);
    fs.writeFileSync(binary, "synthetic package fixture");
    assert.equal(createComputerControl({ platform: "win32", binary }).available(), true);
    assert.equal(createComputerControl({ platform: "linux", binary }).available(), false);
    assert.equal(path.basename(nativePath("darwin", path.join(directory, "node"))), "shapes.inc Bridge Computer");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Windows observation binds its exact window/process/display identities to one scoped action", async () => {
  const requests = [];
  const control = createComputerControl({ platform: "win32", available: () => true,
    invoke: async request => { requests.push(request); return request.operation === "observe" ? capture()
      : { success: true, result: { dispatched: true, delivery_verified: false } }; } });
  const observed = await control.execute({ scope, control: { operation: "observe" } });
  const action = { operation: "type", text: "test", observation_id: observed.result.observation_id };
  assert.equal((await control.execute({ scope: "b".repeat(64), control: action })).error_type, "stale_observation");
  assert.equal((await control.execute({ scope, control: action })).success, true);
  assert.deepEqual(requests[1].expected, { pid: 123, display_id: 42, width: 1200, height: 800,
    bounds: capture().result.bounds, window_id: "123456", process_started: "638650000000000000", display_device: "\\\\.\\DISPLAY1" });
  assert.equal((await control.execute({ scope, control: action })).error_type, "stale_observation");
  assert.equal(requests.length, 2);
});

test("Windows rejects captures without trustworthy window, process and display bindings", async () => {
  for (const mutate of [value => delete value.frontmost.window_id, value => value.frontmost.window_id = "0",
    value => value.frontmost.process_started = "malformed", value => delete value.display_device,
    value => value.display_device = "\\\\server\\screen"]) {
    const receipt = capture(); mutate(receipt.result);
    const control = createComputerControl({ platform: "win32", available: () => true, invoke: async () => receipt });
    const result = await control.execute({ scope, control: { operation: "observe" } });
    assert.equal(result.error_type, "invalid_native_reply");
    assert.equal(result.success, false);
  }
});

test("blocked or partially inserted Windows input remains non-retryable and cannot reuse its image", async () => {
  for (const partial of [false, true]) {
    const control = createComputerControl({ platform: "win32", available: () => true, invoke: async request => request.operation === "observe" ? capture()
      : { success: false, error_type: "input_blocked", dispatched: partial, outcome_unknown: partial } });
    const observed = await control.execute({ scope, control: { operation: "observe" } });
    const action = { operation: "press_key", keys: ["CTRL", "A"], observation_id: observed.result.observation_id };
    const result = await control.execute({ scope, control: action });
    assert.equal(result.retryable, false); assert.equal(result.outcome_unknown, partial);
    assert.equal((await control.execute({ scope, control: action })).error_type, "stale_observation");
  }
});
