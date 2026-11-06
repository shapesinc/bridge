"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const commandSource = process.env.SHAPES_BRIDGE_SOURCE || path.resolve(__dirname, "..");
const { startServer } = require(path.join(commandSource, "src/server"));
const jobs = require(path.join(commandSource, "src/command-jobs"));

test("command receipts survive disconnects, deduplicate starts, isolate scopes and cancel", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-commands-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  let server, base;
  const scope = "a".repeat(64), key = "b".repeat(64);
  const open = async () => { server = await startServer({ port: 0, token: "test-command-token" }); base = `http://127.0.0.1:${server.address().port}`; };
  const close = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "x-token": "test-command-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const quote = (value) => "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
  const script = path.join(dir, "task.js"), marker = path.join(dir, "count.txt");
  fs.writeFileSync(script, `setTimeout(()=>{require('fs').appendFileSync(${JSON.stringify(marker)},'1');console.log('receipt-ok')},1200)`);
  const cmd = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`;
  try {
    await open();
    const unauthorized = await fetch(base + "/commands/start", { method: "POST" });
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    assert.equal((await request("/sysinfo")).body.command_protocol, 1);
    assert.equal((await request("/commands/start", { cmd, timeout: 10, scope_id: scope, request_key: key })).body.error_type, "command_protocol_mismatch");
    const started = await request("/commands/start", { cmd, timeout: 10, scope, request_key: key });
    assert.equal(started.status, 202);
    const id = started.body.job_id;
    assert.match(id, /^[a-f0-9]{64}$/);
    const duplicate = await request("/commands/start", { cmd, timeout: 10, scope, request_key: key });
    assert.equal(duplicate.body.job_id, id);
    assert.equal(duplicate.body.deduplicated, true);
    assert.equal((await request("/commands/start", { cmd: cmd + " changed", timeout: 10, scope, request_key: key })).body.error_type, "command_conflict");
    assert.equal((await request("/commands/status?job_id=" + id + "&scope=" + "c".repeat(64))).status, 404);
    assert.equal((await request("/commands/cancel", { job_id: id, scope: "c".repeat(64) })).status, 404);
    const busy = await request("/commands/start", { cmd, timeout: 10, scope: "c".repeat(64), request_key: key });
    assert.equal(busy.body.error_type, "computer_busy");
    assert.equal(busy.body.job_id, undefined);
    for (const [route, body] of [
      ["/run", { cmd }], ["/write", { path: path.join(dir, "conflicting.txt"), content: "wrong run" }],
      ["/open", { target: path.join(dir, "conflicting.txt") }],
    ]) {
      const rejected = await request(route, body);
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body.error_type, "computer_busy");
    }
    assert.equal(fs.existsSync(path.join(dir, "conflicting.txt")), false);
    // Closing/reopening the HTTP server models a lost tunnel/daemon. The
    // independent supervisor finishes once and its receipt remains readable.
    await close();
    await open();
    const completed = await request(`/commands/status?job_id=${id}&scope=${scope}`);
    assert.equal(completed.body.state, "completed", JSON.stringify(completed));
    assert.equal(completed.body.stdout.trim(), "receipt-ok");
    assert.equal(fs.readFileSync(marker, "utf8"), "1");
    assert.ok(completed.body.finished_at >= completed.body.started_at);
    const replay = await request("/commands/start", { cmd, timeout: 10, scope, request_key: key });
    assert.equal(replay.body.state, "completed");
    assert.equal(fs.readFileSync(marker, "utf8"), "1");
    await t.test("cancellation returns an acknowledgement, then a stopped receipt", async () => {
      fs.writeFileSync(script, "setInterval(()=>{},1000)");
      const started = await request("/commands/start", { cmd, timeout: 30, scope, request_key: "d".repeat(64) });
      const id = started.body.job_id;
      const cancelled = await request("/commands/cancel", { job_id: id, scope });
      assert.equal(cancelled.body.cancel_requested, true);
      const final = await request(`/commands/status?job_id=${id}&scope=${scope}`);
      assert.equal(final.body.state, "cancelled", JSON.stringify(final));
      assert.equal(final.body.cleanup_confirmed, true, "successful Stop requires actual process/Job exit proof");
      assert.equal(final.body.exit_code, -1);
      if (process.platform !== "win32") assert.equal(final.body.cleanup_confirmed, true);
      else if (!final.body.cleanup_confirmed) {
        assert.equal(final.body.outcome_unknown, true);
        // Windows taskkill is exercised below by the platform integration, but
        // this receipt does not invent independent full-tree exit evidence.
        await new Promise((resolve) => setTimeout(resolve, 200));
        jobs.acknowledgeInterrupted(id);
      }
    });
    await t.test("cancel-before-start tombstones are scoped and cannot be replayed", async () => {
      const request_key = "1".repeat(64);
      const id = crypto.createHash("sha256").update(JSON.stringify([scope, request_key])).digest("hex");
      const stopped = await request("/commands/cancel", { job_id: id, scope });
      assert.equal(stopped.body.state, "cancelled");
      assert.equal(stopped.body.cancelled_before_start, true);
      assert.equal(stopped.body.cleanup_confirmed, true);
      assert.equal(stopped.body.command_hash, null);
      assert.equal((await request("/commands/cancel", { job_id: id, scope: "c".repeat(64) })).status, 404);
      const late = await request("/commands/start", { cmd, timeout: 10, scope, request_key });
      assert.equal(late.body.state, "cancelled"); assert.equal(late.body.deduplicated, true);
      assert.equal(fs.readFileSync(marker, "utf8"), "1");
    });
    await t.test("a cancellation racing the exclusive initial save cannot launch", async () => {
      const request_key = "2".repeat(64);
      const id = crypto.createHash("sha256").update(JSON.stringify([scope, request_key])).digest("hex");
      const link = fs.linkSync;
      let injected = false;
      fs.linkSync = (from, to) => {
        if (!injected && to.endsWith(`${id}.json`)) {
          injected = true;
          const cancelled = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(commandSource, "src/command-jobs"))}).cancel(${JSON.stringify(id)},${JSON.stringify(scope)})`], { encoding: "utf8", timeout: 3000 });
          assert.equal(cancelled.status, 0, cancelled.stderr);
        }
        return link(from, to);
      };
      try {
        const late = await request("/commands/start", { cmd, timeout: 10, scope, request_key });
        assert.equal(late.body.state, "cancelled", JSON.stringify(late));
        assert.equal(late.body.cleanup_confirmed, true);
        assert.equal(fs.existsSync(path.join(jobs.root(), `${id}.supervisor`)), false);
        assert.equal(fs.existsSync(path.join(jobs.root(), "mutation.lock")), false);
      } finally { fs.linkSync = link; }
    });
    await t.test("protocol1 Stop ends the owned process tree before a delayed side effect", { skip: process.platform === "win32" }, async () => {
      const escaped = path.join(dir, "late-after-stop.txt"), identity = path.join(dir, "child-pids.json");
      // Existence is the readiness signal: publish only after the JSON write
      // finishes, so a concurrent reader cannot observe a newly opened empty file.
      fs.writeFileSync(script, `const fs=require('fs'),{spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>require('fs').writeFileSync(" + JSON.stringify(escaped) + ",'bad'),1500);setInterval(()=>{},1000)")}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(identity + ".tmp")},JSON.stringify([process.pid,c.pid]));fs.renameSync(${JSON.stringify(identity + ".tmp")},${JSON.stringify(identity)});setInterval(()=>{},1000)`);
      const started = await request("/commands/start", { cmd, timeout: 30, scope, request_key: "3".repeat(64) });
      const id = started.body.job_id;
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(identity) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
      assert.ok(fs.existsSync(identity), "fixture did not publish its process identities before the readiness deadline");
      const pids = JSON.parse(fs.readFileSync(identity));
      assert.equal((await request("/commands/cancel", { job_id: id, scope })).body.cancel_requested, true);
      const final = (await request(`/commands/status?job_id=${id}&scope=${scope}`)).body;
      assert.equal(final.state, "cancelled", JSON.stringify(final)); assert.equal(final.cleanup_confirmed, true);
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(fs.existsSync(escaped), false);
    });
    await t.test("completion racing a liveness check keeps the completed receipt", async (t) => {
      const complete = jobs.load(id);
      jobs.save({ ...complete, state: "running", created_at: Date.now() - 20000, supervisor_pid: 99999999 });
      t.mock.method(process, "kill", () => {
        jobs.save(complete);
        throw Object.assign(new Error("exited"), { code: "ESRCH" });
      });
      assert.equal(jobs.status(id, scope).state, "completed");
      assert.equal(jobs.load(id).state, "completed");
    });
    await t.test("local acknowledgement recovers a terminal receipt with a stranded lock", async () => {
      const complete = jobs.load(id);
      for (const state of ["completed", "failed", "cancelled", "timed_out"]) {
        const record = { ...complete, state, supervisor_pid: process.pid,
          result: { ...complete.result, exit_code: state === "completed" ? 0 : -1 } };
        jobs.save(record);
        fs.writeFileSync(path.join(jobs.root(), "mutation.lock"), JSON.stringify({ id, scope }));
        assert.throws(() => jobs.acknowledgeInterrupted(id), /live supervisor/);
        jobs.save({ ...record, supervisor_pid: 99999999 });
        // Persisted completion plus a crash before release survives restart.
        await close();
        await open();
        assert.equal((await request("/write", { path: path.join(dir, "recovered.txt"), content: state })).status, 409);
        const before = jobs.status(id, scope);
        assert.equal(before.state, state);
        jobs.acknowledgeInterrupted(id);
        assert.deepEqual(jobs.status(id, scope), before);
        assert.equal(fs.existsSync(path.join(jobs.root(), "mutation.lock")), false);
        assert.equal((await request("/write", { path: path.join(dir, "recovered.txt"), content: state })).status, 200);
        assert.equal((await jobs.start({ cmd, timeout: 10, scope, request_key: key })).state, state);
        assert.equal(fs.readFileSync(marker, "utf8"), "1");
      }
    });
    await t.test("local acknowledgement recovers a crash before the first receipt without replay", async () => {
      const orphanBody = { cmd, timeout: 10, scope, request_key: "f".repeat(64) };
      const crashed = spawnSync(process.execPath, ["-e", `
        const fs = require('node:fs');
        const write = fs.writeFileSync;
        fs.writeFileSync = function(file, ...args) {
          if (/\\.json\\.[0-9]+\\.tmp$/.test(String(file))) process.exit(93);
          return write.call(this, file, ...args);
        };
        require(${JSON.stringify(path.join(commandSource, 'src/command-jobs'))}).start(${JSON.stringify(orphanBody)});
      `], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      assert.equal(crashed.status, 93, crashed.stderr);
      const lockPath = path.join(jobs.root(), "mutation.lock");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      assert.throws(() => jobs.load(lock.id), /not found/);
      assert.equal((await request("/write", { path: path.join(dir, "orphan-recovered.txt"), content: "ok" })).status, 409);
      fs.writeFileSync(lockPath, JSON.stringify({ ...lock, launcher_pid: process.pid }));
      assert.throws(() => jobs.acknowledgeInterrupted(lock.id), /live launcher/);
      fs.writeFileSync(lockPath, JSON.stringify(lock));
      assert.throws(() => jobs.acknowledgeInterrupted("0".repeat(64)), /not found/);
      const acknowledged = jobs.acknowledgeInterrupted(lock.id);
      assert.equal(acknowledged.state, "interrupted");
      assert.equal(acknowledged.outcome_unknown, true);
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal((await request("/write", { path: path.join(dir, "orphan-recovered.txt"), content: "ok" })).status, 200);
      const replay = await jobs.start(orphanBody);
      assert.equal(replay.deduplicated, true);
      assert.equal(replay.state, "interrupted");
      assert.equal(fs.readFileSync(marker, "utf8"), "1");
    });
    await t.test("missing supervisor is reported as uncertain and never replayed", async () => {
      const record = jobs.load(id);
      // The daemon is alive, but its worker died before persisting running state.
      jobs.save({ ...record, state: "queued", created_at: Date.now() - 20000, supervisor_pid: undefined, launcher_pid: process.pid });
      fs.writeFileSync(path.join(jobs.root(), `${id}.supervisor`), "99999999");
      const result = jobs.status(id, scope);
      assert.equal(result.state, "interrupted");
      assert.equal(result.outcome_unknown, true);
      assert.equal((await jobs.start({ cmd, timeout: 10, scope, request_key: key })).state, "interrupted");
      fs.writeFileSync(path.join(jobs.root(), "mutation.lock"), JSON.stringify({ id, scope }));
      jobs.acknowledgeInterrupted(id);
      assert.equal(fs.existsSync(path.join(jobs.root(), "mutation.lock")), false);
      assert.equal((await jobs.start({ cmd, timeout: 10, scope, request_key: key })).state, "interrupted");
    });
    await t.test("a delayed supervisor cannot execute an interrupted job", async () => {
      const lateId = "e".repeat(64);
      jobs.save({ ...jobs.load(id), job_id: lateId });
      fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)},'replayed')`);
      const child = spawnSync(process.execPath, [path.join(commandSource, "src/command-worker.js"), lateId],
        { timeout: 5000, windowsHide: true, encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(jobs.load(lateId).state, "interrupted");
      assert.equal(fs.readFileSync(marker, "utf8"), "1");
    });
  } finally {
    if (server?.listening) await close();
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
