"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexRpcSession } = require("../src/codex-rpc");

function fixture(t, mode, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-startup-"));
  const executable = path.join(directory, "app-server"), calls = path.join(directory, "calls.jsonl");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');
const launches=${JSON.stringify(path.join(directory, "launches"))};
const attempt=fs.existsSync(launches)?Number(fs.readFileSync(launches))+1:1;
fs.writeFileSync(launches,String(attempt));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({attempt,pid:process.pid,method:m.method})+'\\n');
  if(m.method==='initialize'){
    if(${JSON.stringify(mode)}==='initialize'||(${JSON.stringify(mode)}==='first'&&attempt===1))return;
    send({id:m.id,result:{}});
  }
  if(m.method==='thread/start'){
    if(${JSON.stringify(mode)}==='thread_start')return;
    send({id:m.id,result:{thread:{id:'thread-1'},approvalPolicy:'never'}});
  }
  if(m.method==='turn/start'){
    if(${JSON.stringify(mode)}==='turn_start')return;
    send({id:m.id,result:{turn:{id:'turn-1'}}});
    send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[]}}});
  }
});
`, { mode: 0o700 });
  const lifecycle = [];
  const session = createCodexRpcSession({ executable, cwd: directory, startupRetries: 1,
    // The full suite starts many real children in parallel. Allow their OS
    // launch overhead before the deliberately unresponsive protocol stage.
    startupTimeoutMs: 3000, requestTimeoutMs: 5000, shutdownTimeoutMs: 100,
    onLifecycle: (event) => lifecycle.push(event), ...options });
  const read = () => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [];
  t.after(async () => {
    await session.close();
    for (const pid of new Set(read().map((value) => value.pid))) {
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Every attempt must exit");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { session, read, lifecycle };
}

test("a stalled initialize is recovered once before any task or inference is dispatched", async (t) => {
  const f = fixture(t, "first");
  const result = await f.session.start("Exactly one task");
  assert.equal(result.status, "completed");
  assert.equal(f.read().filter((m) => m.method === "initialize").length, 2);
  assert.equal(f.read().filter((m) => m.method === "thread/start").length, 1);
  assert.equal(f.read().filter((m) => m.method === "turn/start").length, 1);
  assert.ok(f.lifecycle.some((event) => event.phase === "initialize" && event.failure === "timeout" && event.attempt === 1));
  assert.ok(f.lifecycle.some((event) => event.phase === "running" && event.attempt === 2));
});

for (const [mode, attempts] of [["initialize", 2], ["thread_start", 1], ["turn_start", 1]]) {
  test(`timeout at ${mode} is bounded and never replays dispatched work`, async (t) => {
    const f = fixture(t, mode);
    await assert.rejects(f.session.start("Do not duplicate"), (error) => error.code === "CODEX_RPC_TIMEOUT" && error.phase === mode);
    assert.equal(f.read().filter((m) => m.method === "initialize").length, attempts);
    assert.equal(f.read().filter((m) => m.method === "turn/start").length, mode === "turn_start" ? 1 : 0);
  });
}

test("personal sessions retain their no-retry default", async (t) => {
  const f = fixture(t, "first", { startupRetries: 0 });
  await assert.rejects(f.session.start("Personal task"), { code: "CODEX_RPC_TIMEOUT" });
  assert.equal(f.read().filter((m) => m.method === "initialize").length, 1);
});

test("closing during initialization prevents a retry", async (t) => {
  const f = fixture(t, "initialize");
  const running = f.session.start("Cancelled task");
  const rejected = assert.rejects(running);
  setTimeout(() => { void f.session.close(); }, 150);
  await rejected;
  assert.ok(f.read().filter((m) => m.method === "initialize").length <= 1);
  assert.equal(f.read().some((m) => m.method === "turn/start"), false);
});
