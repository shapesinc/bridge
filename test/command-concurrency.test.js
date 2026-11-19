"use strict";
// Commands never wait for each other: several chats, and several commands in
// one chat, run side by side. Real HTTP, real independent supervisors, throwaway state.
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
  const markers = () => fs.readdirSync(path.join(jobs.root(), "running")).sort();
  const state = async (name, options = {}) => {
    const scope = options.scope || hex(`chat ${name}`), key = options.key || hex(`key ${name}`);
    return (await request(`/commands/status?job_id=${jobId(scope, key)}&scope=${scope}&wait=0`)).body.state;
  };
  // A command that is running as far as Bridge can tell: this process stands in for its supervisor.
  const pretend = (label, { pid = process.pid, age = 0, legacy = false } = {}) => {
    const scope = hex(`chat ${label}`), id = jobId(scope, hex(`key ${label}`));
    jobs.save({ job_id: id, scope, fingerprint: hex("f"), command_hash: hex("c"), state: "running", created_at: Date.now() - age, started_at: Date.now() - age, supervisor_pid: pid, command: { timeout: 60 } });
    fs.mkdirSync(path.join(jobs.root(), "running"), { recursive: true });
    const file = legacy ? path.join(jobs.root(), "mutation.lock") : path.join(jobs.root(), "running", `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, scope, fingerprint: hex("f"), command_hash: hex("c"), launcher_pid: pid, created_at: Date.now() - age }));
    return { id, scope, file };
  };
  const finish = ({ id }) => { jobs.save({ ...jobs.load(id), state: "completed", finished_at: Date.now(), result: { exit_code: 0, stdout: "", stderr: "", cleanup_confirmed: true } }); jobs.release(id); };

  await t.test("different chats run at the same time and each runs exactly once", async () => {
    const names = ["a1", "a2", "a3"];
    for (const name of names) assert.equal((await start(name)).status, 202);
    // All three are running together: none has been told to finish yet.
    for (const name of names) await started(name);
    for (const name of names) assert.equal(await state(name), "running");
    assert.equal(markers().length, 3);
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

  await t.test("several commands sent together in one chat all run at once", async () => {
    // One model step issuing five tool calls: same chat scope, five request keys.
    const scope = hex("chat busy"), names = ["p1", "p2", "p3", "p4", "p5"];
    const replies = await Promise.all(names.map((name) => start(name, { scope })));
    assert.deepEqual(replies.map((reply) => [reply.status, reply.body.error_type]), names.map(() => [202, undefined]));
    assert.equal(new Set(replies.map((reply) => reply.body.job_id)).size, 5);
    for (const name of names) await started(name);
    for (const name of names) assert.equal(await state(name, { scope }), "running");
    // A file write in the same chat is not held up either.
    assert.equal((await request("/write", { path: at("same-chat", ".txt"), content: "ok" })).status, 200);
    // They finish in whatever order they finish; none waits for a sibling.
    for (const name of ["p4", "p1", "p5", "p3", "p2"]) {
      go(name);
      const receipt = await final(name, { scope });
      assert.equal(receipt.state, "completed", JSON.stringify(receipt));
      assert.equal(receipt.stdout.trim(), `done ${name}`);
    }
    assert.deepEqual(fs.readFileSync(path.join(dir, "order.txt"), "utf8").trim().split("\n").slice(-5), ["p4", "p1", "p5", "p3", "p2"]);
    for (const name of names) assert.equal(fs.readFileSync(at(name, ".ran"), "utf8"), "1");
    await idle();
  });

  await t.test("the only refusal is the runaway guard; discovery, status and reads always answer", async () => {
    assert.equal(jobs.MAX_RUNNING, 64);
    assert.equal((await start("real")).status, 202);
    await started("real");
    const fill = Array.from({ length: jobs.MAX_RUNNING - 1 }, (_, index) => pretend(`fill ${index}`));
    assert.equal(jobs.pendingLocks().length, jobs.MAX_RUNNING);
    const refused = await start("extra");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error_type, "computer_busy");
    assert.equal(refused.body.busy_reason, "limit");
    assert.equal(refused.body.job_id, undefined);
    // Refused means nothing was recorded, so the same start can be sent again.
    assert.equal((await request(`/commands/status?job_id=${jobId(hex("chat extra"), hex("key extra"))}&scope=${hex("chat extra")}&wait=0`)).status, 404);
    // The heartbeat's check and everything read-only answer with the computer full.
    const before = Date.now();
    for (let round = 0; round < 20; round++) assert.equal((await request("/sysinfo")).status, 200);
    assert.ok(Date.now() - before < 5000, "sysinfo does not wait on running commands");
    assert.equal((await request(`/ls?path=${encodeURIComponent(dir)}`)).status, 200);
    assert.equal((await request(`/read?path=${encodeURIComponent(script)}`)).status, 200);
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal(await state("real"), "running");
    assert.equal((await request("/write", { path: at("written", ".txt"), content: "ok" })).status, 200);
    // One finishes; the refused start, sent again unchanged, is accepted.
    finish(fill[0]);
    assert.equal((await start("extra")).status, 202);
    await started("extra");
    for (const entry of fill.slice(1)) finish(entry);
    go("real"); go("extra");
    assert.equal((await final("real")).state, "completed");
    assert.equal((await final("extra")).state, "completed");
    await idle();
  });

  await t.test("stopping one command leaves the others running, in the same chat and in others", async () => {
    const scope = hex("chat stop");
    assert.equal((await start("stop", { scope, mode: "hold" })).status, 202);
    assert.equal((await start("sibling", { scope })).status, 202);
    assert.equal((await start("neighbour")).status, 202);
    for (const name of ["stop", "sibling", "neighbour"]) await started(name);
    const id = jobId(scope, hex("key stop"));
    assert.equal((await request("/commands/cancel", { job_id: id, scope })).body.cancel_requested, true);
    const stopped = await final("stop", { scope });
    assert.equal(stopped.state, "cancelled", JSON.stringify(stopped));
    assert.equal(stopped.cleanup_confirmed, true);
    await until(() => !markers().includes(`${id}.json`), "the stopped command's marker to be cleared");
    assert.equal(await state("sibling", { scope }), "running");
    assert.equal(await state("neighbour"), "running");
    go("sibling"); go("neighbour");
    assert.equal((await final("sibling", { scope })).state, "completed");
    assert.equal((await final("neighbour")).state, "completed");
    // A late Stop does not rewrite a finished result.
    assert.equal((await request("/commands/cancel", { job_id: jobId(scope, hex("key sibling")), scope })).body.state, "completed");
    await idle();
  });

  await t.test("one command timing out leaves the others running", async () => {
    const scope = hex("chat slow");
    assert.equal((await start("slow", { scope, mode: "hold", timeout: 1 })).status, 202);
    assert.equal((await start("patient", { scope })).status, 202);
    await started("patient");
    const timedOut = await final("slow", { scope });
    assert.equal(timedOut.state, "timed_out", JSON.stringify(timedOut));
    assert.ok(timedOut.finished_at - timedOut.started_at < 10000, "the deadline is its own, not delayed by other commands");
    assert.equal(await state("patient", { scope }), "running");
    go("patient");
    assert.equal((await final("patient", { scope })).state, "completed");
    await idle();
  });

  await t.test("a command whose process is gone is cleared and never replayed", async () => {
    const dead = 99999999;
    assert.equal((await start("alive")).status, 202);
    await started("alive");
    // A supervisor that died mid-command, and a launcher that died before its first receipt.
    const gone = pretend("gone", { pid: dead, age: 60000 });
    const orphan = hex("chat orphan"), orphanId = jobId(orphan, hex("key orphan"));
    fs.writeFileSync(path.join(jobs.root(), "running", `${orphanId}.json`), JSON.stringify({ id: orphanId, scope: orphan, command_hash: hex("c"), launcher_pid: dead, created_at: Date.now() - 120000,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify([cmd("orphan"), null, 60, null])).digest("hex") }));
    // A launcher that died while writing its marker leaves an empty file.
    const empty = path.join(jobs.root(), "running", `${hex("empty")}.json`);
    fs.writeFileSync(empty, "");
    fs.utimesSync(empty, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
    assert.equal((await start("next")).status, 202);
    assert.equal(markers().length, 2, "only the two live commands remain");
    // Neither lost command is replayed; each keeps an honest receipt.
    const lost = (await request(`/commands/status?job_id=${gone.id}&scope=${gone.scope}&wait=0`)).body;
    assert.equal(lost.state, "interrupted"); assert.equal(lost.outcome_unknown, true);
    assert.equal(jobs.load(gone.id).released_automatically, true);
    assert.equal((await request(`/commands/status?job_id=${orphanId}&scope=${orphan}&wait=0`)).body.state, "interrupted");
    const replay = await request("/commands/start", { cmd: cmd("orphan"), timeout: 60, scope: orphan, request_key: hex("key orphan") });
    assert.equal(replay.body.deduplicated, true); assert.equal(replay.body.state, "interrupted");
    assert.equal(fs.existsSync(at("orphan", ".started")), false);
    assert.equal(await state("alive"), "running");
    await started("next"); go("alive"); go("next");
    assert.equal((await final("alive")).state, "completed");
    assert.equal((await final("next")).state, "completed");
    await idle();
  });

  await t.test("the old whole-computer lock from before the update stops nothing", async () => {
    const legacy = path.join(jobs.root(), "mutation.lock");
    // A command the old Bridge started is still running (this process stands in for its supervisor).
    const old = pretend("old", { legacy: true });
    assert.equal((await start("during-upgrade")).status, 202);
    assert.equal((await start("old-next", { scope: old.scope })).status, 202);
    assert.equal((await request("/write", { path: at("during-upgrade", ".txt"), content: "ok" })).status, 200);
    assert.equal(fs.existsSync(legacy), true, "a running command's old lock is left for its supervisor to remove");
    assert.equal((await request(`/commands/status?job_id=${old.id}&scope=${old.scope}&wait=0`)).body.state, "running");
    // The old supervisor finishes and removes its lock the way it always did.
    jobs.save({ ...jobs.load(old.id), state: "completed", finished_at: Date.now(), result: { exit_code: 0, stdout: "old\n", stderr: "", cleanup_confirmed: true } });
    jobs.release(old.id);
    assert.equal(fs.existsSync(legacy), false);
    // Or it died with the update: the next start settles its receipt and removes the lock.
    const lost = pretend("old lost", { legacy: true, pid: 99999999, age: 60000 });
    assert.equal((await start("after-upgrade")).status, 202);
    assert.equal(fs.existsSync(legacy), false);
    const receipt = (await request(`/commands/status?job_id=${lost.id}&scope=${lost.scope}&wait=0`)).body;
    assert.equal(receipt.state, "interrupted"); assert.equal(receipt.outcome_unknown, true);
    assert.equal((await request(`/commands/status?job_id=${old.id}&scope=${old.scope}&wait=0`)).body.stdout, "old\n", "receipts from before the update stay readable");
    // A damaged old lock no longer needs the owner: it is removed.
    fs.writeFileSync(legacy, "");
    fs.utimesSync(legacy, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
    assert.equal((await start("after-damaged")).status, 202);
    assert.equal(fs.existsSync(legacy), false);
    for (const name of ["during-upgrade", "old-next", "after-upgrade", "after-damaged"]) { await started(name); go(name); }
    assert.equal((await final("during-upgrade")).state, "completed");
    assert.equal((await final("old-next", { scope: old.scope })).state, "completed");
    assert.equal((await final("after-upgrade")).state, "completed");
    assert.equal((await final("after-damaged")).state, "completed");
    await idle();
  });
});

function home(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bridge-${label}-`)), previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
const hold = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' -e 'setInterval(()=>{},1000)'`;

// Start one command per body, each from its own Bridge process, all at once.
const startSource = `require(${JSON.stringify(path.resolve(__dirname, "../src/command-jobs"))}).start(JSON.parse(process.argv[1]))
  .then((r)=>console.log(r.state+(r.deduplicated?":deduplicated":"")),(e)=>console.log((e.errorType||e.message)+":"+e.busyReason))`;
const startTogether = (bodies) => Promise.all(bodies.map((body) => new Promise((resolve) => {
  const child = require("node:child_process").spawn(process.execPath, ["-e", startSource, JSON.stringify(body)], { env: process.env, windowsHide: true });
  let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("close", () => resolve(out.trim()));
})));
const settled = async (count = 0) => {
  for (const deadline = Date.now() + 20000; jobs.pendingLocks().length > count && Date.now() < deadline;) await sleep(50);
  assert.equal(jobs.pendingLocks().length, count);
};

test("separate Bridge processes starting at once never exceed the runaway guard, and its free places get used", { timeout: 60000 }, async (t) => {
  home(t, "concurrency-race");
  // Leave two places, then race eight starts from eight processes for them.
  fs.mkdirSync(path.join(jobs.root(), "running"), { recursive: true });
  for (let index = 0; index < jobs.MAX_RUNNING - 2; index++) {
    const id = hex(`held ${index}`);
    jobs.save({ job_id: id, scope: hex("held"), fingerprint: hex("f"), command_hash: hex("c"), state: "running", created_at: Date.now(), started_at: Date.now(), supervisor_pid: process.pid, command: { timeout: 60 } });
    fs.writeFileSync(path.join(jobs.root(), "running", `${id}.json`), JSON.stringify({ id, scope: hex("held"), launcher_pid: process.pid, created_at: Date.now() }));
  }
  const bodies = Array.from({ length: 8 }, (_, index) => ({ cmd: hold, timeout: 30, scope: hex(`race ${index}`), request_key: hex(`race key ${index}`) }));
  const replies = await startTogether(bodies);
  let accepted = replies.filter((reply) => reply === "queued").length;
  assert.deepEqual(replies.filter((reply) => reply !== "queued" && reply !== "computer_busy:limit"), []);
  // Processes racing for the last places may stand down together; the guard
  // itself is never exceeded and a refused start recorded nothing.
  assert.ok(accepted <= 2, `accepted ${accepted}`);
  assert.equal(jobs.pendingLocks().length, jobs.MAX_RUNNING - 2 + accepted);
  // The refused starts are sent again, as the backend does: both free places
  // get used, and only then is the computer full.
  for (const [index, body] of bodies.entries()) {
    if (replies[index] === "queued") continue;
    assert.throws(() => jobs.load(jobId(body.scope, body.request_key)), /not found/);
    if (accepted < 2) { assert.equal((await jobs.start(body)).state, "queued"); accepted++; replies[index] = "queued"; }
    else await assert.rejects(jobs.start(body), { errorType: "computer_busy", busyReason: "limit" });
  }
  assert.equal(accepted, 2);
  assert.equal(jobs.pendingLocks().length, jobs.MAX_RUNNING);
  for (const [index, body] of bodies.entries()) if (replies[index] === "queued") jobs.cancel(jobId(body.scope, body.request_key), body.scope);
  await settled(jobs.MAX_RUNNING - 2);
});

test("the same start from several Bridge processes at once runs once", { timeout: 60000 }, async (t) => {
  home(t, "concurrency-twins");
  const ran = path.join(process.env.SHAPES_BRIDGE_HOME, "ran.txt");
  const body = { cmd: `${process.platform === "win32" ? "& " : ""}'${process.execPath}' -e "require('fs').appendFileSync(process.argv[1],'1')" '${ran}'`,
    timeout: 30, scope: hex("twins"), request_key: hex("twins key") };
  for (let round = 0; round < 3; round++) {
    const replies = await startTogether(Array.from({ length: 6 }, () => ({ ...body, request_key: hex(`twins key ${round}`) })));
    // Each process either launched it or was handed the launcher's receipt.
    assert.deepEqual(replies.filter((reply) => !/^(queued|running|completed)(:deduplicated)?$/.test(reply)), [], JSON.stringify(replies));
    assert.equal(replies.filter((reply) => !reply.endsWith(":deduplicated")).length, 1, JSON.stringify(replies));
    await settled();
    assert.equal(jobs.status(jobId(body.scope, hex(`twins key ${round}`)), body.scope).state, "completed");
    assert.equal(fs.readFileSync(ran, "utf8"), "1".repeat(round + 1));
  }
});

test("several Bridge processes pruning a full receipt store at once all start their commands", { timeout: 120000 }, async (t) => {
  home(t, "concurrency-prune");
  fs.mkdirSync(jobs.root(), { recursive: true });
  const now = Date.now();
  for (let index = 0; index < jobs.MAX_RECEIPTS + 16; index++) {
    jobs.save({ job_id: hex(`old ${index}`), scope: hex("old"), fingerprint: hex("f"), command_hash: hex("c"), state: "completed",
      created_at: now - 100000 + index, finished_at: now - 90000 + index, result: { exit_code: 0, stdout: "", stderr: "", cleanup_confirmed: true } });
  }
  const quick = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' -e '0'`;
  for (let round = 0; round < 4; round++) {
    const bodies = Array.from({ length: 8 }, (_, index) => ({ cmd: quick, timeout: 30, scope: hex(`prune ${index}`), request_key: hex(`prune key ${round} ${index}`) }));
    assert.deepEqual(await startTogether(bodies), bodies.map(() => "queued"), `round ${round}`);
    await settled();
    for (const body of bodies) {
      const id = jobId(body.scope, body.request_key), receipt = jobs.status(id, body.scope);
      let worker = "";
      try { worker = fs.readFileSync(path.join(jobs.root(), `${id}.worker-error`), "utf8"); } catch { /* none */ }
      assert.equal(receipt.state, "completed", JSON.stringify({ round, receipt, worker }));
    }
    // Top the store back up so every round prunes.
    for (let index = 0; index < 16; index++) {
      jobs.save({ job_id: hex(`old ${round} ${index}`), scope: hex("old"), fingerprint: hex("f"), command_hash: hex("c"), state: "completed",
        created_at: now - 80000 + round * 100 + index, finished_at: now - 70000 + round * 100 + index, result: { exit_code: 0, stdout: "", stderr: "", cleanup_confirmed: true } });
    }
  }
  // Eight processes each make room for one and add one, then 16 are topped up.
  assert.ok(fs.readdirSync(jobs.root()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length <= jobs.MAX_RECEIPTS + 8 + 16);
});

test("a marker that cannot be read right now is counted as running and left alone", (t) => {
  home(t, "concurrency-unread");
  const id = hex("busy marker"), file = path.join(jobs.root(), "running", `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id, scope: hex("s"), fingerprint: hex("f"), command_hash: hex("c"), launcher_pid: 99999999, created_at: Date.now() - 600000 }));
  fs.utimesSync(file, new Date(Date.now() - 600000), new Date(Date.now() - 600000));
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (target, ...rest) => {
    if (target === file) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return read.call(fs, target, ...rest);
  });
  assert.deepEqual(jobs.pendingLocks().map((entry) => [entry.state, entry.running]), [["starting", true]]);
  assert.equal(fs.existsSync(file), true);
  t.mock.restoreAll();
  // Readable again, and its launcher is long gone: now it is cleared.
  assert.deepEqual(jobs.pendingLocks(), []);
  assert.equal(fs.existsSync(file), false);
});

test("a receipt another Bridge process is removing does not stop a full store from starting a command", { timeout: 60000 }, async (t) => {
  home(t, "concurrency-receipts-in-use");
  fs.mkdirSync(jobs.root(), { recursive: true });
  const now = Date.now(), scope = hex("chat in use");
  const receipt = (index, extra) => jobs.save({ job_id: hex(`in use ${index}`), scope, fingerprint: hex("f"), command_hash: hex("c"), state: "completed",
    created_at: now - 100000 + index, finished_at: now - 90000 + index, result: { exit_code: 0, stdout: "", stderr: "", cleanup_confirmed: true }, ...extra });
  for (let index = 0; index < jobs.MAX_RECEIPTS; index++) receipt(index);
  receipt("running", { state: "running", created_at: now - 200000, finished_at: undefined, supervisor_pid: process.pid, command: { timeout: 600 } });
  // On Windows a receipt that another process is deleting can be neither read
  // nor deleted again: both fail with EPERM until the deletion completes.
  const deleting = path.join(jobs.root(), `${hex("in use 0")}.json`), unreadable = path.join(jobs.root(), `${hex("in use 1")}.json`);
  const pending = () => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  const rm = fs.rmSync, read = fs.readFileSync;
  t.mock.method(fs, "rmSync", (target, ...rest) => { if (target === deleting) throw pending(); return rm.call(fs, target, ...rest); });
  t.mock.method(fs, "readFileSync", (target, ...rest) => { if (target === unreadable) throw pending(); return read.call(fs, target, ...rest); });
  const started = await jobs.start({ cmd: hold, timeout: 30, scope, request_key: hex("key in use") });
  t.mock.restoreAll();
  assert.equal(started.state, "queued");
  // The oldest could not be dropped yet, so the next oldest made room instead.
  assert.equal(jobs.load(hex("in use 0")).state, "completed");
  assert.equal(jobs.load(hex("in use 1")).state, "completed");
  assert.throws(() => jobs.load(hex("in use 2")), /not found/);
  assert.equal(jobs.load(hex("in use 3")).state, "completed");
  jobs.cancel(started.job_id, scope);
  for (const deadline = Date.now() + 15000; jobs.pendingLocks().length && Date.now() < deadline;) await sleep(50);
  assert.deepEqual(jobs.pendingLocks(), []);
});

test("a full receipt store drops its oldest finished receipts instead of refusing commands", { timeout: 60000 }, async (t) => {
  home(t, "concurrency-receipts");
  fs.mkdirSync(jobs.root(), { recursive: true });
  const now = Date.now(), scope = hex("chat full");
  const receipt = (index, extra) => jobs.save({ job_id: hex(`receipt ${index}`), scope, fingerprint: hex("f"), command_hash: hex("c"), state: "completed",
    created_at: now - 100000 + index, finished_at: now - 90000 + index, result: { exit_code: 0, stdout: "", stderr: "", cleanup_confirmed: true }, ...extra });
  for (let index = 0; index < jobs.MAX_RECEIPTS; index++) receipt(index);
  // A command still running is never dropped, however old.
  receipt("running", { state: "running", created_at: now - 200000, finished_at: undefined, supervisor_pid: process.pid, command: { timeout: 600 } });
  const started = await jobs.start({ cmd: hold, timeout: 30, scope, request_key: hex("key new") });
  assert.equal(started.state, "queued");
  const kept = fs.readdirSync(jobs.root()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(kept.length, jobs.MAX_RECEIPTS);
  assert.throws(() => jobs.load(hex("receipt 0")), /not found/);
  assert.throws(() => jobs.load(hex("receipt 1")), /not found/);
  assert.equal(jobs.load(hex("receipt 2")).state, "completed");
  assert.equal(jobs.load(hex("receipt running")).state, "running");
  jobs.cancel(started.job_id, scope);
  for (const deadline = Date.now() + 15000; jobs.pendingLocks().length && Date.now() < deadline;) await sleep(50);
  assert.deepEqual(jobs.pendingLocks(), []);
});
