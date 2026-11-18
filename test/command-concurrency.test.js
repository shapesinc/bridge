"use strict";
// Commands from different chats run side by side; one chat's commands run one
// after another. Real HTTP, real independent supervisors, throwaway state.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { startServer } = require("../src/server");
const jobs = require("../src/command-jobs");

const TOKEN = "test-concurrency-token";
const hex = (label) => crypto.createHash("sha256").update(label).digest("hex");
const jobId = (scope, key) => crypto.createHash("sha256").update(JSON.stringify([scope, key])).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("commands from several chats share one computer", { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-concurrency-")), previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  const server = await startServer({ port: 0, token: TOKEN }), base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "x-token": TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  // The fixture reports that it started, waits until it is told to go, then
  // records that it ran. `hold` commands never finish on their own.
  const script = path.join(dir, "task.js");
  fs.writeFileSync(script, `const fs=require('fs'),[name,mode]=process.argv.slice(2),at=(s)=>require('path').join(${JSON.stringify(dir)},name+s);
    fs.writeFileSync(at('.started'),String(Date.now()));
    const tick=()=>{if(mode!=='hold'&&fs.existsSync(at('.go'))){fs.appendFileSync(at('.ran'),'1');fs.appendFileSync(${JSON.stringify(path.join(dir, "order.txt"))},name+'\\n');console.log('done '+name);process.exit(0)}setTimeout(tick,25)};tick();`);
  const quote = (value) => "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\\''") + "'";
  const cmd = (name, mode = "run") => `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)} ${name} ${mode}`;
  const at = (name, suffix) => path.join(dir, name + suffix);
  const go = (name) => fs.writeFileSync(at(name, ".go"), "");
  const until = async (check, what, ms = 15000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(25)) if (await check()) return;
    assert.fail(`timed out waiting for ${what}`);
  };
  const started = (name) => until(() => fs.existsSync(at(name, ".started")), `${name} to start`);
  const start = (name, { scope = hex(`chat ${name}`), key = hex(`key ${name}`), timeout = 60, mode } = {}) =>
    request("/commands/start", { cmd: cmd(name, mode), timeout, scope, request_key: key });
  const final = async (name, { scope = hex(`chat ${name}`), key = hex(`key ${name}`) } = {}) => {
    let result;
    await until(async () => jobs.TERMINAL.has((result = (await request(`/commands/status?job_id=${jobId(scope, key)}&scope=${scope}&wait=0`)).body).state), `${name} to finish`);
    return result;
  };
  const idle = () => until(() => jobs.pendingLocks().length === 0, "every lock to be released");
  const locks = () => fs.readdirSync(path.join(jobs.root(), "locks")).sort();

  await t.test("different chats run at the same time and each runs exactly once", async () => {
    const names = ["a1", "a2", "a3"];
    for (const name of names) assert.equal((await start(name)).status, 202);
    // All three are running together: none has been told to finish yet.
    for (const name of names) await started(name);
    for (const name of names) assert.equal((await request(`/commands/status?job_id=${jobId(hex(`chat ${name}`), hex(`key ${name}`))}&scope=${hex(`chat ${name}`)}&wait=0`)).body.state, "running");
    assert.deepEqual(locks(), names.map((name) => `${hex(`chat ${name}`)}.lock`).sort());
    assert.equal(fs.existsSync(path.join(jobs.root(), "mutation.lock")), false, "the old whole-computer lock is never written");
    // A chat cannot see or stop another chat's command.
    assert.equal((await request(`/commands/status?job_id=${jobId(hex("chat a1"), hex("key a1"))}&scope=${hex("chat a2")}&wait=0`)).status, 404);
    assert.equal((await request("/commands/cancel", { job_id: jobId(hex("chat a1"), hex("key a1")), scope: hex("chat a2") })).status, 404);
    // The same start sent again while it runs, and after, never runs twice.
    const again = await start("a1");
    assert.equal(again.body.deduplicated, true); assert.equal(again.body.state, "running");
    for (const name of names.slice().reverse()) go(name);
    for (const name of names) {
      const receipt = await final(name);
      assert.equal(receipt.state, "completed", JSON.stringify(receipt));
      assert.equal(receipt.stdout.trim(), `done ${name}`);
      assert.equal((await start(name)).body.deduplicated, true);
      assert.equal(fs.readFileSync(at(name, ".ran"), "utf8"), "1");
    }
    await idle();
  });

  await t.test("the same start sent twice at once runs once", async () => {
    const replies = await Promise.all([start("twin"), start("twin"), start("twin")]);
    assert.deepEqual(replies.map((reply) => reply.status), [202, 202, 202]);
    assert.equal(new Set(replies.map((reply) => reply.body.job_id)).size, 1);
    assert.equal(replies.filter((reply) => !reply.body.deduplicated).length, 1);
    await started("twin"); go("twin");
    assert.equal((await final("twin")).state, "completed");
    assert.equal(fs.readFileSync(at("twin", ".ran"), "utf8"), "1");
    await idle();
  });

  await t.test("one chat's commands run one after another, in order", async () => {
    const scope = hex("chat serial");
    assert.equal((await start("s1", { scope })).status, 202);
    await started("s1");
    const waiting = await start("s2", { scope });
    assert.equal(waiting.status, 409);
    assert.equal(waiting.body.error_type, "computer_busy");
    assert.equal(waiting.body.busy_reason, "scope");
    assert.equal(waiting.body.job_id, jobId(scope, hex("key s1")), "the chat is told which of its own commands is ahead");
    // The refused start recorded nothing, so sending it again later is a first start.
    assert.equal((await request(`/commands/status?job_id=${jobId(scope, hex("key s2"))}&scope=${scope}&wait=0`)).status, 404);
    // Another chat is not held up by this one.
    assert.equal((await start("other")).status, 202);
    go("s2"); go("other"); await sleep(300);
    assert.equal(fs.existsSync(at("s2", ".started")), false, "the second command did not start early");
    go("s1");
    assert.equal((await final("s1", { scope })).state, "completed");
    // The backend's wait-and-resend: the identical request now starts.
    let resent;
    await until(async () => (resent = await start("s2", { scope })).status === 202, "the resent start to be accepted");
    assert.notEqual(resent.body.deduplicated, true);
    assert.equal((await final("s2", { scope })).state, "completed");
    assert.equal((await final("other")).state, "completed");
    const order = fs.readFileSync(path.join(dir, "order.txt"), "utf8").trim().split("\n");
    assert.ok(order.indexOf("s1") < order.indexOf("s2"));
    await idle();
  });

  await t.test("at most MAX_RUNNING commands run at once; discovery, status and reads are never refused", async () => {
    const names = Array.from({ length: jobs.MAX_RUNNING }, (_, index) => `cap${index}`);
    for (const name of names) assert.equal((await start(name)).status, 202);
    for (const name of names) await started(name);
    const refused = await start("extra");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error_type, "computer_busy");
    assert.equal(refused.body.busy_reason, "limit");
    assert.equal(refused.body.job_id, undefined, "another chat's job is never named");
    assert.equal((await request(`/commands/status?job_id=${jobId(hex("chat extra"), hex("key extra"))}&scope=${hex("chat extra")}&wait=0`)).status, 404);
    assert.equal(locks().length, jobs.MAX_RUNNING);
    // The heartbeat's check and everything read-only answer while the computer is full.
    const before = Date.now();
    for (let round = 0; round < 20; round++) assert.equal((await request("/sysinfo")).status, 200);
    assert.ok(Date.now() - before < 5000, "sysinfo does not wait on running commands");
    assert.equal((await request("/sysinfo")).body.command_protocol, 1);
    assert.equal((await request(`/ls?path=${encodeURIComponent(dir)}`)).status, 200);
    assert.equal((await request(`/read?path=${encodeURIComponent(script)}`)).status, 200);
    assert.equal((await fetch(base + "/health")).status, 200);
    // A write with no chat scope is not counted against the limit or refused.
    assert.equal((await request("/write", { path: at("written", ".txt"), content: "ok" })).status, 200);
    // One finishes; the refused start, sent again unchanged, is accepted.
    go(names[0]);
    assert.equal((await final(names[0])).state, "completed");
    let resent;
    await until(async () => (resent = await start("extra")).status === 202, "a place to free up");
    await started("extra");
    for (const name of [...names.slice(1), "extra"]) go(name);
    for (const name of [...names.slice(1), "extra"]) assert.equal((await final(name)).state, "completed");
    assert.equal(fs.readFileSync(at("extra", ".ran"), "utf8"), "1");
    await idle();
  });

  await t.test("stopping one chat's command leaves the others running", async () => {
    for (const name of ["stop", "keep1", "keep2"]) assert.equal((await start(name, { mode: name === "stop" ? "hold" : "run" })).status, 202);
    for (const name of ["stop", "keep1", "keep2"]) await started(name);
    const scope = hex("chat stop"), id = jobId(scope, hex("key stop"));
    assert.equal((await request("/commands/cancel", { job_id: id, scope })).body.cancel_requested, true);
    const stopped = await final("stop");
    assert.equal(stopped.state, "cancelled", JSON.stringify(stopped));
    await until(() => !locks().includes(`${scope}.lock`), "the stopped chat's lock to be released");
    for (const name of ["keep1", "keep2"]) {
      assert.equal((await request(`/commands/status?job_id=${jobId(hex(`chat ${name}`), hex(`key ${name}`))}&scope=${hex(`chat ${name}`)}&wait=0`)).body.state, "running");
      assert.ok(locks().includes(`${hex(`chat ${name}`)}.lock`));
    }
    // The stopped chat can use the computer again at once.
    assert.equal((await start("after-stop", { scope })).status, 202);
    for (const name of ["keep1", "keep2", "after-stop"]) go(name);
    assert.equal((await final("keep1")).state, "completed");
    assert.equal((await final("keep2")).state, "completed");
    assert.equal((await final("after-stop", { scope })).state, "completed");
    // A late Stop does not rewrite a finished result.
    assert.equal((await request("/commands/cancel", { job_id: jobId(hex("chat keep1"), hex("key keep1")), scope: hex("chat keep1") })).body.state, "completed");
    await idle();
  });

  await t.test("one chat's command timing out leaves the others running", async () => {
    assert.equal((await start("slow", { mode: "hold", timeout: 1 })).status, 202);
    assert.equal((await start("patient")).status, 202);
    await started("patient");
    const timedOut = await final("slow");
    assert.equal(timedOut.state, "timed_out", JSON.stringify(timedOut));
    assert.ok(timedOut.finished_at - timedOut.started_at < 10000, "the deadline is its own, not delayed by other chats");
    await until(() => !locks().includes(`${hex("chat slow")}.lock`), "the timed-out chat's lock to be released");
    assert.equal((await request(`/commands/status?job_id=${jobId(hex("chat patient"), hex("key patient"))}&scope=${hex("chat patient")}&wait=0`)).body.state, "running");
    go("patient");
    assert.equal((await final("patient")).state, "completed");
    await idle();
  });

  await t.test("a lock whose command is gone is released for that chat only", async () => {
    const dead = 99999999, gone = hex("chat gone"), goneId = jobId(gone, hex("key gone"));
    assert.equal((await start("alive")).status, 202);
    await started("alive");
    // A supervisor that died mid-command, and a launcher that died before its first receipt.
    jobs.save({ job_id: goneId, scope: gone, fingerprint: hex("f"), command_hash: hex("c"), state: "running", created_at: Date.now() - 60000, started_at: Date.now() - 59000, supervisor_pid: dead, command: { timeout: 60 } });
    fs.writeFileSync(path.join(jobs.root(), "locks", `${gone}.lock`), JSON.stringify({ id: goneId, scope: gone, fingerprint: hex("f"), launcher_pid: dead, created_at: Date.now() - 60000 }));
    const orphan = hex("chat orphan"), orphanId = jobId(orphan, hex("key orphan"));
    fs.writeFileSync(path.join(jobs.root(), "locks", `${orphan}.lock`), JSON.stringify({ id: orphanId, scope: orphan, command_hash: hex("c"), launcher_pid: dead, created_at: Date.now() - 120000,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify([cmd("orphan"), null, 60, null])).digest("hex") }));
    // Stale locks do not use up places: fill the computer around them.
    const names = Array.from({ length: jobs.MAX_RUNNING - 1 }, (_, index) => `fill${index}`);
    for (const name of names) assert.equal((await start(name)).status, 202, name);
    assert.deepEqual(locks(), ["alive", ...names].map((name) => `${hex(`chat ${name}`)}.lock`).sort());
    // Neither lost command is replayed; each keeps an honest receipt.
    const lost = (await request(`/commands/status?job_id=${goneId}&scope=${gone}&wait=0`)).body;
    assert.equal(lost.state, "interrupted"); assert.equal(lost.outcome_unknown, true);
    assert.equal(jobs.load(goneId).released_automatically, true);
    assert.equal((await request(`/commands/status?job_id=${orphanId}&scope=${orphan}&wait=0`)).body.state, "interrupted");
    const replay = await request("/commands/start", { cmd: cmd("orphan"), timeout: 60, scope: orphan, request_key: hex("key orphan") });
    assert.equal(replay.body.deduplicated, true); assert.equal(replay.body.state, "interrupted");
    assert.equal(fs.existsSync(at("orphan", ".started")), false);
    assert.equal((await request(`/commands/status?job_id=${jobId(hex("chat alive"), hex("key alive"))}&scope=${hex("chat alive")}&wait=0`)).body.state, "running");
    for (const name of ["alive", ...names]) { await started(name); go(name); }
    for (const name of ["alive", ...names]) assert.equal((await final(name)).state, "completed");
    await idle();
    // A lock file that cannot be parsed stops only its own chat, and is named for the owner.
    const damaged = path.join(jobs.root(), "locks", `${hex("chat damaged")}.lock`);
    fs.writeFileSync(damaged, "");
    assert.equal((await start("damaged")).status, 409);
    assert.deepEqual(jobs.pendingLocks().map((lock) => [lock.state, lock.file]), [["unreadable", damaged]]);
    assert.equal((await start("beside-damaged")).status, 202);
    await started("beside-damaged"); go("beside-damaged");
    assert.equal((await final("beside-damaged")).state, "completed");
    fs.rmSync(damaged);
    await idle();
  });

  await t.test("a command still running across the update keeps the old whole-computer lock until it is gone", async () => {
    const legacy = path.join(jobs.root(), "mutation.lock"), scope = hex("chat old"), id = jobId(scope, hex("key old"));
    const record = { job_id: id, scope, fingerprint: hex("f"), command_hash: hex("c"), state: "running", created_at: Date.now(), started_at: Date.now(), command: { timeout: 60 } };
    // The old Bridge's supervisor is still alive (this process stands in for it).
    jobs.save({ ...record, supervisor_pid: process.pid });
    fs.writeFileSync(legacy, JSON.stringify({ id, scope, fingerprint: hex("f"), command_hash: hex("c"), launcher_pid: process.pid, created_at: Date.now() }));
    const other = await start("during-upgrade");
    assert.equal(other.status, 409); assert.equal(other.body.error_type, "computer_busy");
    assert.equal(other.body.busy_reason, "upgrade"); assert.equal(other.body.job_id, undefined);
    const same = await start("old-next", { scope });
    assert.equal(same.status, 409); assert.equal(same.body.job_id, id);
    assert.equal((await request("/write", { path: at("during-upgrade", ".txt"), content: "no" })).status, 409);
    assert.equal(fs.existsSync(at("during-upgrade", ".txt")), false);
    assert.equal((await request("/sysinfo")).status, 200);
    assert.equal((await request(`/commands/status?job_id=${id}&scope=${scope}&wait=0`)).body.state, "running");
    assert.deepEqual(jobs.pendingLocks().map((lock) => [lock.job_id, lock.running]), [[id, true]]);
    // The old supervisor finishes and releases the lock the way it always did.
    jobs.save({ ...record, supervisor_pid: process.pid, state: "completed", finished_at: Date.now(), result: { exit_code: 0, stdout: "old\n", stderr: "", cleanup_confirmed: true } });
    jobs.release(id);
    assert.equal(fs.existsSync(legacy), false);
    assert.equal((await start("during-upgrade")).status, 202);
    await started("during-upgrade");
    // Or it died with the update: the next start settles its receipt and clears the lock itself.
    const lostId = jobId(scope, hex("key lost"));
    jobs.save({ ...record, job_id: lostId, supervisor_pid: 99999999, created_at: Date.now() - 60000 });
    fs.writeFileSync(legacy, JSON.stringify({ id: lostId, scope, fingerprint: hex("f"), launcher_pid: 99999999, created_at: Date.now() - 60000 }));
    assert.equal((await start("after-upgrade")).status, 202);
    assert.equal(fs.existsSync(legacy), false);
    const lost = (await request(`/commands/status?job_id=${lostId}&scope=${scope}&wait=0`)).body;
    assert.equal(lost.state, "interrupted"); assert.equal(lost.outcome_unknown, true);
    assert.equal((await request(`/commands/status?job_id=${id}&scope=${scope}&wait=0`)).body.stdout, "old\n", "receipts from before the update stay readable");
    await started("after-upgrade"); go("during-upgrade"); go("after-upgrade");
    assert.equal((await final("during-upgrade")).state, "completed");
    assert.equal((await final("after-upgrade")).state, "completed");
    assert.equal(fs.existsSync(legacy), false, "the old lock is never written again");
    await idle();
  });
});

test("separate Bridge processes starting at once never exceed the limit", { timeout: 60000 }, async (t) => {
  const { spawn } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-concurrency-race-")), previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hold = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' -e 'setInterval(()=>{},1000)'`;
  const chats = Array.from({ length: jobs.MAX_RUNNING * 2 }, (_, index) => ({ scope: hex(`race ${index}`), request_key: hex(`race key ${index}`) }));
  const source = `require(${JSON.stringify(path.resolve(__dirname, "../src/command-jobs"))}).start(JSON.parse(process.argv[1]))
    .then((r)=>console.log(r.state),(e)=>console.log(e.errorType+":"+e.busyReason))`;
  const replies = await Promise.all(chats.map((chat) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", source, JSON.stringify({ cmd: hold, timeout: 30, ...chat })], { env: process.env, windowsHide: true });
    let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("close", () => resolve(out.trim()));
  })));
  const accepted = replies.filter((reply) => reply === "queued").length;
  assert.deepEqual(replies.filter((reply) => reply !== "queued" && reply !== "computer_busy:limit"), []);
  // Racing processes may all stand down; the limit itself is never exceeded,
  // and a refused start recorded nothing, so sending it again is safe.
  assert.ok(accepted <= jobs.MAX_RUNNING, `accepted ${accepted}`);
  for (const [index, chat] of chats.entries()) if (replies[index] !== "queued") assert.throws(() => jobs.load(jobId(chat.scope, chat.request_key)), /not found/);
  assert.equal(jobs.pendingLocks().length, accepted);
  for (const [index, chat] of chats.entries()) if (replies[index] === "queued") jobs.cancel(jobId(chat.scope, chat.request_key), chat.scope);
  for (const deadline = Date.now() + 15000; jobs.pendingLocks().length && Date.now() < deadline;) await sleep(50);
  assert.deepEqual(jobs.pendingLocks(), []);
});
