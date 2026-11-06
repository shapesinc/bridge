"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { closeProcessGroup } = require("../src/process-close");

test("shutdown reports an unconfirmed parent exit within its bound", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  t.after(async () => {
    child.ref();
    const exited = once(child, "exit"); process.kill(-child.pid, "SIGKILL"); await exited;
  });
  const sent = [], started = Date.now();
  const result = await closeProcessGroup(child, { graceMs: 30, exitTimeoutMs: 30, signal: (pid, name) => sent.push([pid, name]) });
  assert.equal(result.processExited, false);
  assert.equal(result.exitCode, null);
  assert.deepEqual(sent, [[child.pid, "SIGTERM"], [child.pid, "SIGKILL"]]);
  assert.ok(Date.now() - started < 1000);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});


test("short provider grace does not preempt the native cleanup receipt window", async () => {
  const { EventEmitter } = require("node:events");
  const { spawnOwned, signalOwned, ownedCleanup } = require("../src/owned-process");
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null,
    kill: () => assert.fail("must wait for the native cleanup bound"), unref() {} });
  child.stdio = Array.from({ length: 6 }, () => Object.assign(new EventEmitter(), { destroy() {} }));
  [child.stdin, child.stdout, child.stderr] = child.stdio;
  child.stdio[4].end = () => setTimeout(() => {
    child.stdio[5].emit("data", Buffer.from("job-empty\n")); child.stdio[5].emit("end");
    child.exitCode = 130; child.emit("exit", 130, null);
  }, 300);
  spawnOwned("C:\\node.exe", [], { cleanupReceipt: true, stdio: ["pipe", "pipe", "pipe"] },
    { platform: "win32", host: "C:\\Job.exe", exists: () => true, spawnProcess: () => child });
  const result = await closeProcessGroup(child, { graceMs: 250, exitTimeoutMs: 500,
    signal: (_pid, name) => signalOwned(child, name, { platform: "win32" }) });
  assert.equal(result.processExited, true); assert.equal(ownedCleanup(child), true);
});
