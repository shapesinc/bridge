"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const jobs = require("../src/command-jobs");
const { replaceStateFile } = require("../src/state");
const { startServer } = require("../src/server");

const scope = "a".repeat(64), fingerprint = "f".repeat(64);
const LOST = "The command supervisor stopped without a completion receipt. Its effects are unknown; inspect the computer before issuing another mutation.";

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-receipt-")), previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  fs.mkdirSync(jobs.root(), { recursive: true });
  t.after(() => {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
// An exited child's PID models a supervisor that is gone.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const lockFile = () => path.join(jobs.root(), "mutation.lock");
// Anything that looks at what is running clears the markers of commands that are gone.
const sweep = () => jobs.pendingLocks();
function stranded(id, record, pending) {
  const supervisor = deadPid(), base = { job_id: id, scope, fingerprint, command_hash: "c".repeat(64), created_at: Date.now() - 60000 };
  fs.writeFileSync(path.join(jobs.root(), `${id}.json`), JSON.stringify({ ...base, ...record, ...(record.state === "queued" ? {} : { supervisor_pid: supervisor }) }));
  fs.writeFileSync(path.join(jobs.root(), `${id}.supervisor`), String(supervisor));
  fs.writeFileSync(lockFile(), JSON.stringify({ id, scope, fingerprint, launcher_pid: supervisor, created_at: base.created_at }));
  if (pending) fs.writeFileSync(path.join(jobs.root(), `${id}.json.${supervisor}.tmp`), JSON.stringify({ ...base, supervisor_pid: supervisor, ...pending }));
  return supervisor;
}
const done = { state: "completed", started_at: 1, finished_at: 2, result: { exit_code: 0, stdout: "ok\n", stderr: "", cleanup_confirmed: true } };

test("a finished command whose receipt could not be replaced is adopted and unlocks", (t) => {
  home(t);
  const id = "1".repeat(64);
  stranded(id, { state: "running", started_at: 1 }, done);
  const receipt = jobs.status(id, scope);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.stdout, "ok\n");
  assert.equal(fs.existsSync(lockFile()), false);
  assert.deepEqual(fs.readdirSync(jobs.root()).filter((name) => name.endsWith(".tmp")), []);
});

test("an already interrupted receipt with the finished record beside it heals on the next look", async (t) => {
  home(t);
  const id = "2".repeat(64);
  stranded(id, { state: "interrupted", started_at: 1, finished_at: 3, result: { exit_code: -1, stdout: "", stderr: LOST, outcome_unknown: true } }, done);
  sweep();
  assert.equal(jobs.load(id).state, "completed");
  assert.equal(fs.existsSync(lockFile()), false);
});

test("a supervisor that could not record its start is settled as not run", (t) => {
  home(t);
  for (const [id, record] of [["3".repeat(64), { state: "queued" }],
    ["4".repeat(64), { state: "interrupted", finished_at: 3, result: { exit_code: -1, stdout: "", stderr: LOST, outcome_unknown: true } }]]) {
    stranded(id, record, { state: "running", started_at: 5 });
    const receipt = jobs.status(id, scope);
    assert.equal(receipt.state, "failed");
    assert.match(receipt.stderr, /Nothing ran/);
    assert.equal(receipt.cleanup_confirmed, true);
    assert.equal(fs.existsSync(lockFile()), false);
  }
});

test("without local proof the outcome stays unknown, and the lock clears once the supervisor is gone", async (t) => {
  home(t);
  const cases = [
    ["5".repeat(64), { state: "running", started_at: 1 }, null],
    ["6".repeat(64), { state: "running", started_at: 1 }, { ...done, fingerprint: "e".repeat(64) }],
    ["7".repeat(64), { state: "running", started_at: 1 }, { state: "running", started_at: 1 }],
    ["8".repeat(64), { state: "interrupted", started_at: 1, finished_at: 3, result: { exit_code: -1, stdout: "", stderr: "timed out after 5s\nCommand process exit could not be confirmed.", outcome_unknown: true } }, done],
    ["9".repeat(64), { state: "running", started_at: 1 }, { state: "interrupted", started_at: 1, finished_at: 2, result: { exit_code: -1, stdout: "", stderr: "", outcome_unknown: true } }],
  ];
  for (const [id, record, pending] of cases) {
    fs.rmSync(lockFile(), { force: true });
    stranded(id, record, pending);
    const receipt = jobs.status(id, scope);
    assert.equal(receipt.state, "interrupted", id);
    assert.equal(receipt.outcome_unknown, true, id);
    sweep();
    assert.equal(fs.existsSync(lockFile()), false, id);
    assert.equal(jobs.load(id).state, "interrupted", id);
    assert.equal(jobs.load(id).released_automatically, true, id);
  }
});

test("a command whose supervisor is alive keeps its marker", async (t) => {
  home(t);
  const id = "b".repeat(64);
  stranded(id, { state: "running", started_at: 1 }, null);
  fs.writeFileSync(path.join(jobs.root(), `${id}.json`), JSON.stringify({ ...jobs.load(id), supervisor_pid: process.pid }));
  assert.deepEqual(sweep().map((entry) => [entry.job_id, entry.running]), [[id, true]]);
  assert.equal(fs.existsSync(lockFile()), true);
  assert.equal(jobs.load(id).state, "running");
});

test("a process number reused by another program does not keep the lock", async (t) => {
  home(t);
  // The reported machine: the command finished, its receipt rename was refused,
  // and hours later Windows gave the supervisor's PID to an unrelated process.
  const id = "c".repeat(64), old = Date.now() - 2 * 60 * 60 * 1000;
  stranded(id, { state: "interrupted", started_at: 1, finished_at: 3, result: { exit_code: -1, stdout: "", stderr: LOST, outcome_unknown: true } }, done);
  const reuse = (file, patch) => fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch }));
  const dead = jobs.load(id).supervisor_pid;
  fs.renameSync(path.join(jobs.root(), `${id}.json.${dead}.tmp`), path.join(jobs.root(), `${id}.json.${process.pid}.tmp`));
  reuse(path.join(jobs.root(), `${id}.json.${process.pid}.tmp`), { supervisor_pid: process.pid, created_at: old });
  reuse(path.join(jobs.root(), `${id}.json`), { supervisor_pid: process.pid, created_at: old, command: { timeout: 90 } });
  fs.writeFileSync(path.join(jobs.root(), `${id}.supervisor`), String(process.pid));
  sweep();
  assert.equal(jobs.load(id).state, "completed");
  assert.equal(fs.existsSync(lockFile()), false);

  // Same for a launcher that died before its first receipt.
  const orphan = "d".repeat(64);
  fs.writeFileSync(lockFile(), JSON.stringify({ id: orphan, scope, fingerprint, command_hash: "c".repeat(64), launcher_pid: process.pid, created_at: old }));
  sweep();
  assert.equal(jobs.load(orphan).state, "interrupted");
  // Inside the launch window a live launcher still owns the lock.
  fs.writeFileSync(lockFile(), JSON.stringify({ id: "e".repeat(64), scope, fingerprint, command_hash: "c".repeat(64), launcher_pid: process.pid, created_at: Date.now() }));
  assert.equal(sweep().length, 1);
  assert.equal(fs.existsSync(lockFile()), true);
});

test("receipt replacement waits out a longer Windows sharing violation", () => {
  let clock = 0, calls = 0;
  const denied = Object.assign(new Error("denied"), { code: "EPERM" });
  replaceStateFile("a", "b", { platform: "win32", budgetMs: 5000, now: () => clock, wait: (ms) => { clock += ms; },
    rename: () => { if (++calls < 100) throw denied; } });
  assert.equal(calls, 100);
  clock = 0; calls = 0;
  assert.throws(() => replaceStateFile("a", "b", { platform: "win32", now: () => clock, wait: (ms) => { clock += ms; },
    rename: () => { calls++; throw denied; } }), { code: "EPERM" });
  assert.equal(calls, 26);
});

test("a missing path is a not-found answer, not a helper failure", async (t) => {
  home(t);
  const server = await startServer({ port: 0, token: "test-token-with-fixed-length" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const missing = path.join(os.tmpdir(), "bridge-missing-" + process.pid, "nowhere");
  for (const route of ["/ls", "/read"]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}?path=${encodeURIComponent(missing)}`, { headers: { "x-token": "test-token-with-fixed-length" } });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error_type, "path_not_found");
  }
});
