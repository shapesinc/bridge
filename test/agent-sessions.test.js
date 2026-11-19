"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);

// A fake Claude Code that behaves like the real CLI where sessions matter: it
// runs under --session-id or --resume, writes its transcript where Claude Code
// does, and `claude agents --json` reports what FAKE_ACTIVE lists.
function claudeFixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shapes-agent-sessions-")));
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  const executable = path.join(dir, "fake-claude");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const a=process.argv.slice(2);
if(a.includes('--version')){console.log('2.1.300 (Claude Code)');process.exit(0);}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
if(a[0]==='agents'){const f=process.env.FAKE_ACTIVE;console.log(f&&fs.existsSync(f)?fs.readFileSync(f,'utf8'):'[]');process.exit(0);}
if(a.includes('--help')){console.log('--print --output-format --verbose --permission-prompts --permission-mode --tools --strict-mcp-config --mcp-config --disallowedTools --session-id --resume -n, --name <name>');process.exit(0);}
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',async()=>{
  fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify({args:a,prompt,cwd:process.cwd()})+'\\n');
  const id=a.includes('--resume')?a[a.indexOf('--resume')+1]:a[a.indexOf('--session-id')+1];
  while(process.env.FAKE_HOLD&&fs.existsSync(process.env.FAKE_HOLD))await new Promise(r=>setTimeout(r,20));
  const folder=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));
  fs.mkdirSync(folder,{recursive:true});
  const line=x=>fs.appendFileSync(path.join(folder,id+'.jsonl'),JSON.stringify(x)+'\\n');
  line({type:'user',message:{role:'user',content:prompt},timestamp:new Date().toISOString()});
  line({type:'assistant',message:{id:'m-'+prompt.length,role:'assistant',content:[{type:'text',text:'done: '+prompt}]}});
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:id}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done: '+prompt,session_id:id}));
});`, { mode: 0o700 });
  const env = {
    SHAPES_CLAUDE_BINARY: executable, SHAPES_CODEX_JOB_DIR: path.join(dir, "jobs"), CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
    FAKE_LOG: path.join(dir, "runs.jsonl"), FAKE_HOLD: path.join(dir, "hold"), FAKE_ACTIVE: path.join(dir, "active.json"),
  };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const runs = () => (fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  return { dir, work, env, runs, codex: require("../src/codex") };
}

async function finished(codex, id) {
  for (let i = 0; i < 400; i++) {
    const status = codex.publicStatus(id);
    if (TERMINAL.has(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The job did not finish in time.");
}

async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition not reached.");
}

test("a Claude Code session starts under its own id and later turns continue that same session", async (t) => {
  const f = claudeFixture(t);
  const start = await f.codex.startJob({ prompt: "Add TODO.md", cwd: f.work, agent: "claude", sandbox: "workspace-write",
    sessionScope: SCOPE_A, title: "Tod: starter todos\n-p", startedBy: "Tod" });
  const id = start.agent_session_id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(start.open, { app: "Claude", app_url: `claude://resume?session=${id}`, cli_command: `claude --resume ${id}` });
  assert.equal((await finished(f.codex, start.job_id)).state, "completed");

  const send = await f.codex.sendTurn({ agentSessionId: id, sessionScope: SCOPE_A, prompt: "Add a fourth" });
  assert.equal(send.agent_session_id, id);
  assert.equal((await finished(f.codex, send.job_id)).final, "done: Add a fourth");

  const [first, second] = f.runs();
  // The new session is named for the person's own lists; the newline can't
  // smuggle a flag, and the name is one argument joined to its option.
  assert.deepEqual(first.args.slice(first.args.indexOf("--session-id"), first.args.indexOf("--session-id") + 2), ["--session-id", id]);
  assert.ok(first.args.includes("--name=Tod: starter todos -p"));
  assert.ok(!first.args.includes("--resume"));
  assert.deepEqual(second.args.slice(second.args.indexOf("--resume"), second.args.indexOf("--resume") + 2), ["--resume", id]);
  assert.ok(!second.args.includes("--session-id") && !second.args.some((arg) => arg.startsWith("--name")));
  assert.equal(second.cwd, first.cwd);
  assert.ok(second.args.includes("--dangerously-skip-permissions"), "the session's write access carries over");

  const status = await f.codex.sessionStatus({ agentSessionId: id, sessionScope: SCOPE_A });
  assert.equal(status.state, "idle");
  assert.equal(status.turns, 2);
  assert.equal(status.started_by, "Tod");
  assert.equal(status.open_elsewhere, false);
  assert.equal(status.last_turn.job_id, send.job_id);

  const read = await f.codex.readSession({ agentSessionId: id, sessionScope: SCOPE_A });
  assert.deepEqual(read.messages.map((m) => [m.role, m.text]),
    [["user", "Add TODO.md"], ["assistant", "done: Add TODO.md"], ["user", "Add a fourth"], ["assistant", "done: Add a fourth"]]);

  // Another chat's scope gets the same answer as an id that doesn't exist.
  const unknown = { statusCode: 404, message: "No session with that id was started from this chat on this computer." };
  await assert.rejects(f.codex.sendTurn({ agentSessionId: id, sessionScope: SCOPE_B, prompt: "Steal it" }), unknown);
  await assert.rejects(f.codex.readSession({ agentSessionId: id, sessionScope: SCOPE_B }), unknown);
  await assert.rejects(f.codex.sessionStatus({ agentSessionId: "0".repeat(8) + "-0000-4000-8000-" + "0".repeat(12), sessionScope: SCOPE_A }), unknown);
  assert.deepEqual(f.codex.listSessions({ sessionScope: SCOPE_B }).sessions, []);
  assert.deepEqual(f.codex.listSessions({ sessionScope: SCOPE_A }).sessions.map((s) => s.agent_session_id), [id]);
  // A task bound to Codex (the person's saved choice) can't reach a Claude Code session.
  await assert.rejects(f.codex.sendTurn({ agentSessionId: id, sessionScope: SCOPE_A, prompt: "x", agent: "codex" }),
    { statusCode: 409, errorType: "session_agent_mismatch" });
  await assert.rejects(f.codex.readSession({ agentSessionId: id, sessionScope: SCOPE_A, agent: "codex" }),
    { statusCode: 409, errorType: "session_agent_mismatch" });
  assert.equal(f.runs().length, 2, "no refused operation ran the agent");
});

test("a session refuses a message while its turn runs or while the person has it open, and Stop ends the turn", async (t) => {
  const f = claudeFixture(t);
  fs.writeFileSync(f.env.FAKE_HOLD, "");
  const start = await f.codex.startJob({ prompt: "Long task", cwd: f.work, agent: "claude", sessionScope: SCOPE_A });
  const id = start.agent_session_id;
  await until(() => f.runs().length === 1);
  await assert.rejects(f.codex.sendTurn({ agentSessionId: id, sessionScope: SCOPE_A, prompt: "Another" }),
    { statusCode: 409, errorType: "session_busy", jobId: start.job_id });
  assert.equal((await f.codex.sessionStatus({ agentSessionId: id, sessionScope: SCOPE_A })).state, "running");

  const stop = f.codex.stopSession({ agentSessionId: id, sessionScope: SCOPE_A });
  assert.equal(stop.stopped, true);
  assert.equal((await finished(f.codex, start.job_id)).state, "cancelled");
  fs.rmSync(f.env.FAKE_HOLD);

  // Open in the person's Claude app: never two writers on one conversation.
  fs.writeFileSync(f.env.FAKE_ACTIVE, JSON.stringify([{ sessionId: id.toUpperCase(), kind: "interactive", status: "idle", pid: 4242 }]));
  await assert.rejects(f.codex.sendTurn({ agentSessionId: id, sessionScope: SCOPE_A, prompt: "Another" }),
    { statusCode: 409, errorType: "session_open_elsewhere" });
  assert.equal((await f.codex.sessionStatus({ agentSessionId: id, sessionScope: SCOPE_A })).open_elsewhere, true);
  assert.equal(f.runs().length, 1);
  assert.equal(f.codex.stopSession({ agentSessionId: id, sessionScope: SCOPE_A }).stopped, false, "Stop never reaches a session the person runs");
});

test("a Claude Code transcript reads as the conversation, without tool traffic or bookkeeping", (t) => {
  const { claudeTranscriptMessages } = require("../src/agent-sessions");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-transcript-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "s.jsonl");
  const lines = [
    { type: "summary", summary: "old" },
    { type: "user", message: { role: "user", content: "Fix the build" }, timestamp: "2026-11-19T10:00:00Z" },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Looking" }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "secret output" }] } },
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Fixed it." }] } },
    { type: "user", isMeta: true, message: { content: "Caveat: meta" } },
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    { type: "assistant", isSidechain: true, message: { id: "m2", content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "user", message: { content: [{ type: "text", text: "Thanks, now run tests" }] } },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n{not json\n");
  const read = claudeTranscriptMessages(file, 10);
  assert.deepEqual(read.messages.map((m) => [m.role, m.text]),
    [["user", "Fix the build"], ["assistant", "Looking\nFixed it."], ["user", "Thanks, now run tests"]]);
  assert.equal(claudeTranscriptMessages(file, 1).truncated, true);
});

// A fake Codex app-server for the session transport.
function codexServer(t, { configuredModel, models, thread }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-codex-session-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "fake-codex");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');const input=[];
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');const reply=(m,result)=>send({id:m.id,result});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);input.push(m);fs.writeFileSync(${JSON.stringify(path.join(dir, "input.json"))},JSON.stringify(input));
  if(m.method==='initialize')return reply(m,{});
  if(m.method==='config/read')return reply(m,{config:{model:${JSON.stringify(configuredModel)}}});
  if(m.method==='model/list')return reply(m,{data:${JSON.stringify(models)}});
  if(m.method==='thread/read')return reply(m,{thread:${JSON.stringify(thread || null)}});
  if(m.method==='thread/start'||m.method==='thread/resume'){const id=(m.params.threadId||'019a0000-0000-7000-8000-000000000001');reply(m,{thread:{id},approvalPolicy:'never'});return;}
  if(m.method==='thread/name/set')return reply(m,{});
  if(m.method==='turn/start'){reply(m,{turn:{id:'turn-1',status:'inProgress'}});send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'turn-1',status:'completed',items:[]}}});}
});`, { mode: 0o700 });
  return { dir, executable, input: () => JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8")) };
}

test("Codex uses the account's default model when the configured one isn't offered, and names only new threads", async (t) => {
  const { createCodexRpcSession } = require("../src/codex-rpc");
  const offered = [{ id: "gpt-6-luna", model: "gpt-6-luna", isDefault: true }, { id: "gpt-5.6-terra", model: "gpt-5.6-terra", isDefault: false },
    { id: "gpt-reserve", model: "gpt-reserve", hidden: true, isDefault: false }];
  const cases = [
    { name: "unavailable model", configured: "gpt-6.1-sol", expect: "gpt-6-luna" },
    { name: "hidden model counts as not offered", configured: "gpt-reserve", expect: "gpt-6-luna" },
    { name: "offered model is kept", configured: "gpt-5.6-terra", expect: undefined },
    { name: "no configured model is Codex's choice", configured: null, expect: undefined },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const f = codexServer(t, { configuredModel: item.configured, models: offered });
      const events = [];
      const session = createCodexRpcSession({ executable: f.executable, cwd: f.dir, pickAvailableModel: true, threadName: "Tod: fix the build",
        onEvent: (event) => events.push(event), shutdownTimeoutMs: 100 });
      t.after(() => session.close());
      await session.start("Fix the build");
      const input = f.input();
      assert.equal(input.find((m) => m.method === "thread/start").params.model, item.expect);
      assert.equal(events.some((event) => event.type === "model.substituted"), item.expect !== undefined);
      assert.deepEqual(input.find((m) => m.method === "thread/name/set").params,
        { threadId: "019a0000-0000-7000-8000-000000000001", name: "Tod: fix the build" });
    });
  }
  await t.test("a resumed thread keeps its name and its id", async (t) => {
    const f = codexServer(t, { configuredModel: "gpt-6-luna", models: offered });
    const session = createCodexRpcSession({ executable: f.executable, cwd: f.dir, pickAvailableModel: true, threadName: "ignored",
      resumeThreadId: "019a0000-0000-7000-8000-0000000000aa", shutdownTimeoutMs: 100 });
    t.after(() => session.close());
    await session.start("And now the tests");
    const input = f.input();
    assert.equal(input.find((m) => m.method === "thread/resume").params.threadId, "019a0000-0000-7000-8000-0000000000aa");
    assert.ok(!input.some((m) => m.method === "thread/start" || m.method === "thread/name/set"));
  });
});

test("a Codex thread reads back as its messages, the person's own turns included", async (t) => {
  const { codexThreadMessages } = require("../src/agent-sessions");
  const id = "019a0000-0000-7000-8000-0000000000bb";
  const f = codexServer(t, { configuredModel: null, models: [], thread: { id, name: "Tod: docs", status: { type: "notLoaded" }, turns: [
    { status: "completed", startedAt: 1795135000, items: [
      { type: "userMessage", content: [{ type: "text", text: "Write the README" }] },
      { type: "commandExecution", command: "ls" },
      { type: "agentMessage", text: "Wrote README.md" }] },
    { status: "failed", startedAt: 1795135100, items: [{ type: "userMessage", content: [{ type: "text", text: "typed in the Codex app" }] }] },
  ] } });
  const read = await codexThreadMessages(f.executable, id, { cwd: f.dir, limit: 10 });
  assert.deepEqual(read.messages.map((m) => [m.role, m.text]),
    [["user", "Write the README"], ["assistant", "Wrote README.md"], ["user", "typed in the Codex app"]]);
  assert.equal(read.last_turn_status, "failed");
  assert.equal(read.vendor_title, "Tod: docs");
  await assert.rejects(codexThreadMessages(f.executable, "019a0000-0000-7000-8000-0000000000cc", { cwd: f.dir, limit: 10 }), /different thread/);
});
