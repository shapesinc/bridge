"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = path.resolve(__dirname, "../bin/cli.js");
const DEAD_PID = 99999999;

test("status releases a lock whose command is gone and reports one that is still running", { timeout: 30000 }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-lock-notice-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, "--state-dir", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  const jobsDir = path.join(dir, "command-jobs"), lockPath = path.join(jobsDir, "mutation.lock");
  const id = "c".repeat(64), scope = "a".repeat(64), fingerprint = "d".repeat(64);
  const record = (extra) => fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify({
    job_id: id, scope, fingerprint, command_hash: "e".repeat(64), created_at: Date.now() - 60000, ...extra }));
  const lock = (extra = {}) => fs.writeFileSync(lockPath, JSON.stringify({ id, scope, fingerprint, command_hash: "e".repeat(64), launcher_pid: DEAD_PID, created_at: Date.now() - 60000, ...extra }));
  fs.mkdirSync(jobsDir, { recursive: true });

  // No lock: nothing to say and nothing to acknowledge.
  assert.doesNotMatch(run("status").stdout, /acknowledge-command|Commands are blocked/);
  const idle = run("acknowledge-command");
  assert.equal(idle.status, 0, idle.stderr);
  assert.match(idle.stdout, /No command lock is pending/);

  // The reported case: a timed-out command with unconfirmed cleanup, then an
  // uninstall and re-pair. No config remains, yet the lock still blocks.
  record({ state: "interrupted", finished_at: Date.now() - 50000, supervisor_pid: DEAD_PID,
    result: { exit_code: -1, stdout: "", stderr: "timed out", outcome_unknown: true } });
  lock();
  const cleared = run("status");
  assert.match(cleared.stdout, /not connected/);
  assert.doesNotMatch(cleared.stdout, /Commands are blocked/);
  assert.equal(fs.existsSync(lockPath), false);
  lock();

  // A live supervisor is reported as running, never as something to release.
  record({ state: "running", supervisor_pid: process.pid });
  const running = run("status");
  assert.match(running.stdout, new RegExp(`A computer command is running \\(job ${id}\\)`));
  assert.doesNotMatch(running.stdout, /Commands are blocked/);
  const refused = run("acknowledge-command");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no live supervisor/);
  assert.equal(fs.existsSync(lockPath), true);

  // Its supervisor died without a receipt: the receipt is settled as
  // interrupted and the lock is released without the owner.
  record({ state: "running", supervisor_pid: DEAD_PID });
  assert.doesNotMatch(run("status").stdout, /Commands are blocked/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), "utf8")).state, "interrupted");
  assert.doesNotMatch(run("status").stdout, /Commands are blocked/);

  // A launcher that died before its first receipt leaves only the lock.
  fs.rmSync(path.join(jobsDir, `${id}.json`));
  lock({ launcher_pid: process.pid, created_at: Date.now() });
  assert.match(run("status").stdout, /A computer command is running/);
  lock();
  assert.doesNotMatch(run("status").stdout, /Commands are blocked|is running/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.match(run("acknowledge-command").stdout, /No command lock is pending/);

  // A truncated lock cannot be acknowledged; name the file instead of crashing.
  fs.writeFileSync(lockPath, "");
  const damaged = run("status");
  assert.equal(damaged.status, 0, damaged.stderr);
  assert.ok(damaged.stdout.includes(`A damaged command lock blocks new commands: ${lockPath}`));
  const stuck = run("acknowledge-command");
  assert.equal(stuck.status, 1);
  assert.ok(stuck.stderr.includes(lockPath));
  assert.equal(fs.existsSync(lockPath), true);
});
