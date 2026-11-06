"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const available = process.platform === "win32" && process.env.SHAPES_TEST_JOB_HOST;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("The Windows command receipt did not settle.");
}

test("native owner shutdown interrupts a command without replay or releasing its mutation lock", { skip: !available, timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-owned-receipt-"));
  const node = path.join(dir, "node.exe"), host = path.join(dir, "shapes.inc Bridge Job.exe");
  fs.copyFileSync(process.execPath, node);
  fs.copyFileSync(process.env.SHAPES_TEST_JOB_HOST, host);
  const env = { ...process.env, SHAPES_BRIDGE_HOME: path.join(dir, "state") };
  const owners = new Set();
  t.after(async () => {
    for (const owner of owners) {
      if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); await once(owner, "close"); }
    }
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const serverModule = path.resolve(__dirname, "../src/server.js");
  const jobsModule = path.resolve(__dirname, "../src/command-jobs.js");
  const script = path.join(dir, "server.js");
  fs.writeFileSync(script, `require(${JSON.stringify(serverModule)}).startServer({port:0,token:'owned-command-fixture'}).then(s=>require('node:fs').writeFileSync(process.argv[2],String(s.address().port)))`);
  let generation = 0;
  const open = async () => {
    const ready = path.join(dir, `ready-${++generation}`);
    const owner = spawn(host, ["--parent-pid", String(process.pid), "--", node, script, ready], { env, stdio: "ignore", windowsHide: true });
    owners.add(owner);
    await waitFor(() => fs.existsSync(ready));
    const base = `http://127.0.0.1:${fs.readFileSync(ready, "utf8")}`;
    const request = async (route, body) => {
      const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "x-token": "owned-command-fixture", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    return { owner, request };
  };
  const childPid = path.join(dir, "command.pid"), late = path.join(dir, "late.txt");
  const command = path.join(dir, "command.js");
  fs.writeFileSync(command, `require('node:fs').writeFileSync(${JSON.stringify(childPid)},String(process.pid));setTimeout(()=>require('node:fs').appendFileSync(${JSON.stringify(late)},'unexpected'),10000);setInterval(()=>{},1000);`);
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const body = { cmd: `& ${quote(node)} ${quote(command)}`, cwd: dir, timeout: 30, scope: "a".repeat(64), request_key: "b".repeat(64) };
  const first = await open();
  const started = await first.request("/commands/start", body);
  assert.equal(started.status, 202);
  const id = started.body.job_id;
  await waitFor(() => fs.existsSync(childPid));
  const pid = Number(fs.readFileSync(childPid, "utf8"));
  assert.equal(alive(pid), true);
  const recordFile = path.join(env.SHAPES_BRIDGE_HOME, "command-jobs", `${id}.json`);
  const running = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  assert.equal(running.state, "running");
  assert.equal(alive(running.supervisor_pid), true);

  // This is a real kernel Job termination, not a close/reopen of one HTTP
  // server in the same process. It models explicit native owner retirement.
  first.owner.kill();
  await once(first.owner, "close");
  await waitFor(() => !alive(pid) && !alive(running.supervisor_pid));
  const second = await open();
  const route = `/commands/status?job_id=${id}&scope=${body.scope}`;
  const interrupted = await waitFor(async () => {
    const value = await second.request(route);
    return value.body.state === "interrupted" && value;
  });
  assert.equal(interrupted.body.outcome_unknown, true);
  // Wait past the actual delayed mutation, including the process startup gap.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, running.started_at + 12000 - Date.now())));
  assert.equal(fs.existsSync(late), false);
  const replay = await second.request("/commands/start", body);
  assert.equal(replay.body.state, "interrupted");
  assert.equal(replay.body.deduplicated, true);
  assert.equal((await second.request("/commands/start", { ...body, cmd: "Write-Output changed" })).body.error_type, "command_conflict");
  assert.equal((await second.request(`/commands/status?job_id=${id}&scope=${"c".repeat(64)}`)).status, 404);
  const target = path.join(dir, "after-reconcile.txt");
  assert.equal((await second.request("/write", { path: target, content: "too early" })).body.error_type, "computer_busy");
  assert.equal(fs.existsSync(target), false);

  // Only the local owner can acknowledge the reconciled unknown outcome.
  await execute(node, ["-e", "require(process.argv[1]).acknowledgeInterrupted(process.argv[2])", jobsModule, id], { env, timeout: 10000, windowsHide: true });
  assert.equal((await second.request("/write", { path: target, content: "reconciled" })).status, 200);
  assert.equal(fs.readFileSync(target, "utf8"), "reconciled");
  assert.equal((await second.request("/commands/start", body)).body.state, "interrupted");
  assert.equal(fs.existsSync(late), false);
});
