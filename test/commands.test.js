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
const { runCommand } = require(path.join(commandSource, "src/command-process"));
const { startCommand } = require(path.join(commandSource, "src/commands"));
const TOKEN = "private-command-test-token";
const scope = "actor:room:device";
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const idFor = (key) => crypto.createHash("sha256").update(`${scope}\0${key}`).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, serverOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-commands-"));
  const old = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = path.join(dir, "state");
  const server = await startServer({ port: 0, token: TOKEN, ...serverOptions });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (old === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = old;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (route, body, token = TOKEN) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", "x-token": token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  // The v0 module is retained only to read/cancel pre-upgrade receipts. New
  // HTTP starts use protocol1; these fixtures reproduce existing legacy jobs.
  const start = async (request_key, cmd, extra = {}) => {
    try { const body = startCommand({ scope_id: scope, request_key, cmd, cwd: dir, ...extra }); return { status: body.deduplicated ? 200 : 202, body }; }
    catch (error) { return { status: error.statusCode || 400, body: { error: error.message } }; }
  };
  const status = (id, selectedScope = scope) => request(`/commands/status?command_id=${id}&scope_id=${selectedScope}`);
  const cancel = (id, selectedScope = scope, token = TOKEN) => request("/commands/cancel", { command_id: id, scope_id: selectedScope }, token);
  const until = async (id, predicate = (r) => r.state !== "running") => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const r = (await status(id)).body; if (predicate(r)) return r; await sleep(15); }
    throw new Error("Command did not reach the expected state.");
  };
  return { dir, request, start, status, cancel, until };
}

test("legacy scoped command starts deduplicate side effects, bind arguments, and retain completed receipts across a reader restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/capabilities")).body.features.command_jobs, true);
  assert.equal((await f.request("/commands/start", { scope_id: scope, request_key: "bad", cmd: "touch unsafe" }, "wrong")).status, 401);
  assert.equal(fs.existsSync(path.join(f.dir, "unsafe")), false);
  const cmd = "printf once >> count.txt; printf command-ok";
  const starts = await Promise.all([f.start("once", cmd), f.start("once", cmd)]);
  assert.deepEqual(starts.map((r) => r.status).sort(), [200, 202]);
  const id = starts[0].body.command_id;
  assert.equal(id, idFor("once"));
  assert.equal((await f.start("once", "printf changed >> count.txt")).status, 409);
  assert.equal((await f.status(id, "different-room")).status, 404);
  const done = await f.until(id);
  assert.equal(done.state, "completed"); assert.equal(done.exit_code, 0); assert.equal(done.stdout, "command-ok");
  assert.equal(fs.readFileSync(path.join(f.dir, "count.txt"), "utf8"), "once");
  const before = fs.readFileSync(path.join(process.env.SHAPES_BRIDGE_HOME, "commands", `${id}.json`));
  assert.equal((await f.cancel(id)).body.state, "completed");
  assert.deepEqual(fs.readFileSync(path.join(process.env.SHAPES_BRIDGE_HOME, "commands", `${id}.json`)), before);
  const restarted = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path.join(commandSource, "src/commands"))}).commandStatus(${JSON.stringify({ command_id: id, scope_id: scope })})))`], { env: process.env, encoding: "utf8" });
  assert.equal(restarted.status, 0); assert.deepEqual(JSON.parse(restarted.stdout), done);
});

test("cancel stops only its live shell tree including a detached child, remains idempotent, and prevents the delayed write", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, "wait.js"), `const fs=require('node:fs'); const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('after-stop.txt','bad'),1200)"],{detached:true,stdio:'ignore'});
    fs.writeFileSync('children.json',JSON.stringify([process.pid,child.pid])); console.log('stop-test-running');setInterval(()=>{},1000);`);
  const command = `${quote(process.execPath)} wait.js`;
  const started = await f.start("stop-tree", command);
  const id = started.body.command_id;
  const control = await f.start("control", "sleep 0.3; printf safe > control.txt");
  await f.until(id, (r) => r.stdout.includes("stop-test-running"));
  const children = JSON.parse(fs.readFileSync(path.join(f.dir, "children.json"), "utf8"));
  assert.equal((await f.cancel(id, "different-room")).status, 404);
  assert.equal((await f.cancel(id, scope, "wrong")).status, 401);
  for (const pid of children) assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal((await f.cancel(id)).body.cancel_requested, true);
  const cancelled = await f.until(id);
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.cleanup_confirmed, true);
  assert.equal((await f.cancel(id)).body.state, "cancelled");
  for (const pid of children) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await f.until(control.body.command_id)).state, "completed");
  await sleep(1300);
  assert.equal(fs.existsSync(path.join(f.dir, "after-stop.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.dir, "control.txt"), "utf8"), "safe");
});

test("cancel before a delayed start is durable, while deadline and output limits settle distinct failures", async (t) => {
  const f = await fixture(t);
  const id = idFor("cancel-before-start");
  assert.equal((await f.cancel(id)).body.state, "cancelled");
  assert.equal((await f.start("cancel-before-start", "touch should-not-exist")).body.state, "cancelled");
  assert.equal(fs.existsSync(path.join(f.dir, "should-not-exist")), false);
  const timeout = await f.start("timeout", "sleep 5; touch after-timeout", { timeout: 1 });
  const timed = await f.until(timeout.body.command_id);
  assert.equal(timed.state, "timed_out"); assert.equal(timed.cleanup_confirmed, true);
  const output = await f.start("output", `${quote(process.execPath)} -e 'process.stdout.write("x".repeat(5*1024*1024));setInterval(()=>{},1000)'`);
  const limited = await f.until(output.body.command_id);
  assert.equal(limited.state, "failed"); assert.match(limited.stderr, /output limit/); assert.ok(limited.stdout.length <= 20000);
  assert.equal(limited.cleanup_confirmed, true);
  assert.equal(fs.existsSync(path.join(f.dir, "after-timeout")), false);
});

test("an interrupted receipt never signals a reused PID or reruns the uncertain command", async (t) => {
  const f = await fixture(t);
  const id = idFor("interrupted");
  const file = path.join(process.env.SHAPES_BRIDGE_HOME, "commands", `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ command_id: id, scope_id: scope, state: "running", pid: process.pid, fingerprint: null }));
  const interrupted = (await f.status(id)).body;
  assert.equal(interrupted.state, "failed"); assert.equal(interrupted.outcome_unknown, true); assert.equal(interrupted.cleanup_confirmed, false);
  assert.equal((await f.start("interrupted", "touch unsafe-retry")).body.deduplicated, true);
  assert.equal(fs.existsSync(path.join(f.dir, "unsafe-retry")), false);
  assert.equal((await f.cancel(id)).body.outcome_unknown, true);
});

test("a failed cancellation receipt write still stops the owned command", async (t) => {
  const f = await fixture(t);
  const started = await f.start("disk-error", "printf ready; sleep 5; touch unsafe-after-disk-error");
  const id = started.body.command_id;
  await f.until(id, (r) => r.stdout.includes("ready"));
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && to.endsWith(`${id}.json`)) {
      injected = true;
      fs.rmSync(from); // Simulate the failed write without obstructing later recovery.
      throw Object.assign(new Error("test disk write failure"), { code: "EIO" });
    }
    return rename(from, to);
  };
  try { assert.equal((await f.cancel(id)).status, 400); }
  finally { fs.renameSync = rename; }
  const done = await f.until(id);
  assert.equal(done.state, "cancelled"); assert.equal(done.cleanup_confirmed, true);
  assert.equal(fs.existsSync(path.join(f.dir, "unsafe-after-disk-error")), false);
});

test("denied termination signals settle bounded uncertainty without crashing or losing the cleanup path", async (t) => {
  const f = await fixture(t);
  const sent = [];
  const execution = runCommand({ cmd: `${quote(process.execPath)} -e 'require("node:fs").writeFileSync("pid",String(process.pid));console.log("ready");setInterval(()=>{},1000)'`, cwd: f.dir }, {
    signal: (pid, name) => {
      if (name === 0) return process.kill(pid, 0);
      sent.push([pid, name]);
      throw Object.assign(new Error("test signal denial"), { code: "EPERM" });
    },
  });
  let child;
  try {
    const deadline = Date.now() + 3000;
    while (!execution.snapshot().stdout.includes("ready") && Date.now() < deadline) await sleep(10);
    child = Number(fs.readFileSync(path.join(f.dir, "pid"), "utf8"));
    const started = Date.now();
    assert.doesNotThrow(() => execution.cancel());
    const result = await execution.result;
    assert.ok(Date.now() - started < 3500);
    assert.equal(result.cleanup_confirmed, false); assert.equal(result.exit_code, -1);
    assert.match(result.stderr, /exit could not be confirmed/);
    assert.ok(sent.some(([, name]) => name === "SIGTERM")); assert.ok(sent.some(([, name]) => name === "SIGKILL"));
    assert.doesNotThrow(() => process.kill(child, 0));
  } finally {
    // Only this fixture's captured process groups are stopped after the denial
    // simulation; no real process permission or helper configuration changed.
    for (const pid of new Set(sent.map(([pid]) => pid))) { try { process.kill(pid, "SIGKILL"); } catch {} }
    if (child) { try { process.kill(child, "SIGKILL"); } catch {} }
    const deadline = Date.now() + 1000;
    if (child) {
      while (Date.now() < deadline) {
        try { process.kill(child, 0); } catch { break; }
        await sleep(20);
      }
      assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    }
  }
});

test("Windows command jobs remain available while unverified tree termination never claims cleanup", async (t) => {
  const f = await fixture(t, { platform: "win32" });
  assert.equal((await f.request("/capabilities")).body.features.command_jobs, true);
  const execution = runCommand({ cmd: `${quote(process.execPath)} -e 'require("node:fs").writeFileSync("pid",String(process.pid));console.log("ready");setInterval(()=>{},1000)'`, cwd: f.dir }, { platform: "win32" });
  let child;
  try {
    const deadline = Date.now() + 3000;
    while (!execution.snapshot().stdout.includes("ready") && Date.now() < deadline) await sleep(10);
    child = Number(fs.readFileSync(path.join(f.dir, "pid"), "utf8"));
    execution.cancel();
    const result = await execution.result;
    assert.equal(result.cleanup_confirmed, false);
    assert.match(result.stderr, /exit could not be confirmed/);
  } finally {
    // This is a parent-only signal simulation on the host OS, not execution on
    // Windows. The fixture's independently recorded descendant is cleaned up.
    if (child) {
      try { process.kill(child, "SIGKILL"); } catch {}
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) { try { process.kill(child, 0); } catch { break; } await sleep(20); }
      assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
    }
  }
});
