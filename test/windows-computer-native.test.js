"use strict";
// Windows-only runtime acceptance with actual pixels/events and an owned test
// window. Skips on other hosts are not proof of Windows release readiness.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createComputerControl } = require("../src/computer");

const helper = process.env.SHAPES_TEST_COMPUTER_HELPER;
const fixture = process.env.SHAPES_TEST_COMPUTER_FIXTURE;
const skipped = process.platform !== "win32" ? "requires the actual Windows desktop"
  : !helper || !fixture ? "requires compiled helper and owned fixture paths" : false;
const pause = () => new Promise(resolve => setTimeout(resolve, 80));
async function until(read, check, message) {
  const deadline = Date.now() + 7000;
  let value;
  do { try { value = await read(); if (check(value)) return value; } catch {} await pause(); } while (Date.now() < deadline);
  assert.fail(`${message}; no matching state before deadline`);
}
function native(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("native helper exceeded deadline")); }, 15000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4100000) { child.kill(); reject(new Error("oversized native reply")); } else chunks.push(chunk); });
    child.on("close", () => { clearTimeout(timer); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify(request));
  });
}

test("Windows actual screenshot and one-use mouse/Unicode/key actions affect only the owned fixture", { skip: skipped, timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-computer-native-"));
  const statusPath = path.join(directory, "status.json");
  const child = spawn(fixture, [statusPath], { stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "the owned native fixture exited");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const state = () => JSON.parse(fs.readFileSync(statusPath, "utf8"));
  await until(state, value => value.pid === child.pid, "fixture opened");
  const controller = createComputerControl({ platform: "win32", binary: helper });
  const scope = "a".repeat(64);
  const run = control => controller.execute({ scope, control });
  const observe = async () => {
    const reply = await run({ operation: "observe" });
    assert.equal(reply.success, true, `${reply.error_type || ""}: ${reply.error || ""}`);
    assert.equal(reply.result.frontmost.pid, child.pid, "the owned fixture is frontmost; never target another app");
    return reply.result;
  };
  const coordinate = (observation, target) => {
    const point = state().targets[target];
    return [(point[0] - observation.bounds.x) * observation.width / observation.bounds.width,
      (point[1] - observation.bounds.y) * observation.height / observation.bounds.height];
  };
  const action = async (operation, args = {}, target) => {
    const observation = await observe();
    const request = { operation, observation_id: observation.observation_id, ...args };
    if (target) request.point = coordinate(observation, target);
    if (operation === "drag") request.to = [request.point[0] + 40, request.point[1] + 20];
    const reply = await run(request);
    assert.equal(reply.success, true, `${reply.error_type || ""}: ${reply.error || ""}`);
    assert.equal(reply.result.dispatched, true); assert.equal(reply.result.delivery_verified, false);
    assert.equal((await run(request)).error_type, "stale_observation");
    return reply;
  };
  const initial = await observe();
  assert.deepEqual(Buffer.from(initial.image_base64, "base64").subarray(0, 2), Buffer.from([0xff, 0xd8]));
  assert.ok(initial.width > 0 && initial.width <= 1600 && initial.height > 0 && initial.height <= 1600);
  assert.match(initial.frontmost.window_id, /^[1-9][0-9]*$/);
  assert.match(initial.scroll_delta_unit, /120/);
  await action("type", { text: "shapes.inc π 😀" });
  await until(state, value => value.text === "shapes.inc π 😀", "Unicode typing persisted in fixture");
  await action("press_key", { keys: ["CTRL", "A"] });
  await action("type", { text: "replacement" });
  await until(state, value => value.text === "replacement", "keyboard chord selected old text");
  await action("click", { click_count: 2 }, "button");
  await until(state, value => value.clicks >= 2, "native clicks reached fixture");
  await action("move", {}, "area");
  await action("drag", {}, "area");
  await until(state, value => value.drags > 0 && value.moves > 0, "native drag reached fixture");
  await action("scroll", { dx: 0, dy: 120 }, "area");
  await until(state, value => value.wheels === 120, "wheel delta reached fixture");
  const observed = await observe();
  const expected = { pid: observed.frontmost.pid, window_id: observed.frontmost.window_id,
    process_started: observed.frontmost.process_started, display_id: observed.display_id,
    display_device: observed.display_device, bounds: observed.bounds, width: observed.width, height: observed.height };
  for (const changed of [{ window_id: "999999999" }, { process_started: "1" }, { display_device: "\\\\.\\DISPLAY999" }, { bounds: { ...expected.bounds, width: expected.bounds.width + 1 } }]) {
    const denied = await native({ operation: "type", text: "must-not-type", expected: { ...expected, ...changed } });
    assert.equal(denied.success, false); assert.equal(denied.error_type, "desktop_changed"); assert.equal(denied.dispatched, false);
  }
  assert.equal(state().text, "replacement");
  await action("click", {}, "password");
  const password = await observe();
  const denied = await run({ operation: "type", text: "must-not-type", observation_id: password.observation_id });
  assert.equal(denied.error_type, "secure_input"); assert.equal(denied.dispatched, false);
  await pause(); assert.equal(state().passwordLength, 0);
});

test("Windows native parser rejects an unsupported request without input", { skip: skipped }, async () => {
  const reply = await native({ operation: "shell", command: "must-not-run" });
  assert.equal(reply.success, false); assert.equal(reply.dispatched, false); assert.equal(reply.error_type, "invalid_arguments");
});
