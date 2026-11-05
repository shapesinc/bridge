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
