"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { describeOpenAction, openApp } = require("../src/open");

test("opening the app decides from local state only", () => {
  assert.equal(describeOpenAction(null).action, "setup");
  assert.equal(describeOpenAction({ device_token: "t", revoked: true }).action, "reinstall");
  assert.equal(describeOpenAction({ device_token: "t", paused: true }).action, "resume");
  assert.equal(describeOpenAction({ device_token: "t" }).action, "restart");
  for (const config of [null, { device_token: "t", revoked: true }]) assert.equal(describeOpenAction(config).openPage, true);
});

test("opening a paused install resumes it, restarts the service and reports the live result", async () => {
  const state = { config: { device_token: "t", paused: true, name: "Mac" }, status: null };
  const notices = []; let started = 0; let opened = 0;
  const result = await openApp({
    readState: (name) => state[name], writeState: (name, value) => { state[name] = value; },
    startService: () => { started++; setTimeout(() => { state.status = { connection: "connected" }; }, 20); },
    notifier: (message) => notices.push(message), opener: () => { opened++; }, waitMs: 2000, pollMs: 10,
  });
  assert.equal(result.action, "resume");
  assert.equal(state.config.paused, false);
  assert.equal(started, 1);
  assert.equal(opened, 0);
  assert.match(notices.at(-1), /^Connected\./);
});

test("opening without an account pairing sends the person to shapes.inc instead of starting anything", async () => {
  let started = 0, opened = 0;
  const result = await openApp({ readState: () => null, writeState: () => {}, startService: () => { started++; }, notifier: () => {}, opener: () => { opened++; } });
  assert.equal(result.action, "setup");
  assert.equal(started, 0);
  assert.equal(opened, 1);
});
