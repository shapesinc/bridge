"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const { cleanupReplay, stopReplayJobs } = require("../scripts/replay-cleanup");

test("replay cleanup waits for the owned leader after terminal state and closes only its listener", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-cleanup-"));
  const owned = http.createServer(), unrelated = http.createServer();
  await Promise.all([owned, unrelated].map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
  const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.once('data', () => setTimeout(() => process.exit(0), 150))"], { stdio: ["pipe", "ignore", "ignore"] });
  t.after(async () => { child.kill(); await new Promise(resolve => unrelated.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  let cancelled = false;
  const started = Date.now();
  await cleanupReplay({ root, servers: [owned], jobs: ["owned"], cancelJob() { cancelled = true; child.stdin.end("cancel"); }, getState() { return { status: cancelled ? "cancelled" : "running", supervisorPid: child.pid }; } });
  assert(Date.now() - started >= 140);
  assert.equal(fs.existsSync(root), false);
  assert.equal(owned.listening, false); assert.equal(unrelated.listening, true);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("failed cancellation still attempts every job and closes listener while retaining evidence", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-cleanup-"));
  const server = http.createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attempted = [];
  await assert.rejects(cleanupReplay({ root, servers: [server], jobs: ["first", "second"], cancelJob(id) { attempted.push(id); if (id === "first") throw new Error("simulated failure"); }, getState() { return { status: "completed" }; } }), /cleanup failed/);
  assert.deepEqual(attempted, ["first", "second"]); assert.equal(server.listening, false); assert.equal(fs.existsSync(root), true);
});

test("forced owned-process cleanup is a failed replay even after process absence", async t => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  t.after(() => child.kill());
  await assert.rejects(stopReplayJobs({ jobs: ["owned"], cancelJob() {}, getState() { return { status: "failed", supervisorPid: child.pid }; }, timeoutMs: 80 }), /required emergency/);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});
