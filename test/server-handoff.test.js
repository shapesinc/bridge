"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

function fixture({ pipeError = true } = {}) {
  const child = new EventEmitter(), signals = [], timers = new Set();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  for (const stream of [child.stdout, child.stderr, child.stdin]) stream.destroy = () => {};
  child.stdin.end = (input) => {
    assert.equal(input, "release\n");
    if (pipeError) child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
  };
  const file = path.resolve(__dirname, "../src/server.js"), realRequire = createRequire(file);
  const module = { exports: {} };
  // Exercise the actual server state machine with deterministic Windows event
  // ordering. Native helper behavior has separate real Windows integration tests.
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, Buffer, process: { platform: "win32" },
    require: (name) => name === "./owned-process" ? { spawnOwned: () => child, signalOwned: (_, signal) => signals.push(signal) }
      : name === "./command-shell" ? { commandShell: () => ({ executable: "C:\\shell.exe", args: [], shell: "powershell", cleanup() {} }) }
      : name === "./local-workspace" ? { localEnvironment: () => ({}) } : realRequire(name),
    setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
  }, { filename: file });
  const result = module.exports.runCommand({ cmd: "fixture", timeout: 1 });
  child.stderr.emit("data", Buffer.from("command error"));
  child.stdout.emit("end"); child.stderr.emit("end");
  return { child, result, signals, timers };
}

test("failed helper exit wins over a control EPIPE after output EOF", async () => {
  for (const code of [1, 7, 70]) {
    const f = fixture();
    assert.deepEqual(f.signals, [], "EPIPE must not replace the real helper exit by killing it");
    f.child.exitCode = code; f.child.emit("close", code);
    const result = await f.result;
    assert.equal(result.exit_code, code);
    assert.equal(result.stderr, "command error");
    assert.equal(f.timers.size, 0);
  }
});

test("a successful helper still requires a successful control handoff", async () => {
  for (const pipeError of [true, false]) {
    const f = fixture({ pipeError });
    f.child.exitCode = 0; f.child.emit("close", 0);
    const result = await f.result;
    assert.equal(result.exit_code, pipeError ? -1 : 0);
    assert.equal(result.stderr.includes("handoff failed"), pipeError);
    assert.equal(f.timers.size, 0);
  }
});

test("a helper that never exits after control EPIPE is terminated within the settlement bound", async () => {
  const f = fixture();
  assert.equal(f.timers.size, 1);
  const [timer] = f.timers;
  assert.equal(timer.ms, 5000);
  timer.callback();
  const result = await f.result;
  assert.deepEqual(f.signals, ["SIGKILL"]);
  assert.equal(result.exit_code, -1);
  assert.match(result.stderr, /handoff did not finish/);
  assert.equal(f.timers.size, 0);
});
