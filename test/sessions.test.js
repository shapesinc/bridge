"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { startServer } = require("../src/server");
const { getStatus, cancelJob } = require("../src/codex");
const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
const OTHER_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR4nGNgYPiPAw0pCQCpcD/BFMrqcwAAAABJRU5ErkJggg==";

async function until(id, condition = (value) => terminal.has(value.state), attempts = 150) {
  for (let index = 0; index < attempts; index++) {
    const value = getStatus(id);
    if (condition(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Job did not settle: ${JSON.stringify(getStatus(id))}`);
}

async function fixture(t, { stallFirstInitialize = false, rejectFirstTurn = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sessions-test-"));
  const state = path.join(directory, "state"), jobs = path.join(directory, "jobs");
  const executable = path.join(directory, "app-server"), calls = path.join(directory, "calls.jsonl");
  const environment = { SHAPES_BRIDGE_HOME: state, SHAPES_CODEX_JOB_DIR: jobs,
    SHAPES_BUNDLED_CODEX_BINARY: executable, CODEX_HOME: path.join(directory, "personal-codex") };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  // This fixture implements the pinned stdio protocol, not paid inference.
  // Separate opt-in replay exercises the actual official binary and real tools.
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('app-server'))process.exit(11);
if(process.env.CODEX_HOME===${JSON.stringify(environment.CODEX_HOME)})process.exit(12);
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const reply=(m,result)=>send({id:m.id,result});
const stored=path.join(process.env.CODEX_HOME,'fixture-thread.json');
let threadId,turns=0,billed=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');
 if(m.method==='initialize'){
  const marker=${JSON.stringify(path.join(directory, "initialized-once"))};
  if(${stallFirstInitialize}&&!fs.existsSync(marker)){fs.writeFileSync(marker,'stalled');return;}
  reply(m,{});
 }
 if(m.method==='thread/start'||m.method==='thread/resume'){
  if(m.method==='thread/resume'){const prior=JSON.parse(fs.readFileSync(stored));threadId=prior.threadId;turns=prior.turns;billed=prior.billed||0;if(threadId!==m.params.threadId)process.exit(13);}
  else threadId='fixture-'+require('node:crypto').randomUUID();
  reply(m,{thread:{id:threadId},approvalPolicy:'never'});
 }
 if(m.method==='turn/start'){
  turns++;fs.writeFileSync(stored,JSON.stringify({threadId,turns,billed}));
  const rejection=${JSON.stringify(path.join(directory, "rejected-first-turn"))};
  if(${rejectFirstTurn}&&!fs.existsSync(rejection)){fs.writeFileSync(rejection,'rejected');send({id:m.id,error:{code:-32602,message:'Fixture rejected turn before input delivery'}});return;}
  const turnId='turn-'+turns,prompt=m.params.input[0].text;
  reply(m,{turn:{id:turnId,status:'inProgress'}});
  if(prompt==='detached-pipe'){
   const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},12000)'],{detached:true,stdio:['ignore',1,2]});
   child.unref();fs.writeFileSync('escaped.pid',String(child.pid));return;
  }
  if(prompt==='wait'){
   send({id:'question',method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'question',questions:[{id:'answer',header:'Answer',question:'Continue?',options:[{label:'Yes',description:'Proceed'}]}]}});return;
  }
  if(prompt==='exit')process.exit(2);
  if(prompt==='provider401'||prompt==='provider429'){
   const message=prompt==='provider401'?'Provider rejected the sandbox request (HTTP 401).':'Provider rate limit (HTTP 429).';
   send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',items:[],error:{message}}}});return;
  }
  if(prompt==='gatewayStopped'){
   send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',items:[],error:{message:'unexpected status 403 Forbidden: Computer inference access was revoked or cancelled.',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:403}}}}}});return;
  }
  billed++;fs.writeFileSync(stored,JSON.stringify({threadId,turns,billed}));
  const token=process.env.SHAPES_RUNTIME_TOKEN;
  const item={id:'answer',type:'agentMessage',text:prompt==='leak'?'Result '+token:'Completed '+prompt};
  send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{last:{inputTokens:100,outputTokens:20,totalTokens:120},total:{inputTokens:100*billed,outputTokens:20*billed,totalTokens:120*billed}}}});
  send({method:'item/completed',params:{threadId,turnId,item}});
  send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:prompt==='fail'?'failed':'completed',items:[item],error:prompt==='fail'?{message:'Simulated provider unavailable'}:null}}});
 }
}).on('close',()=>process.exit(0));
`, { mode: 0o700 });
  let server = await startServer({ port: 0, token: "session-fixture-token" });
  const started = [];
  async function request(route, body, token = "session-fixture-token") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? "GET" : "POST", headers: { "x-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() };
    if (result.status === 202) started.push(result.body.job_id);
    return result;
  }
  async function restart() {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    server = await startServer({ port: 0, token: "session-fixture-token" });
  }
  t.after(async () => {
    for (const id of started) { if (!terminal.has(getStatus(id).state)) cancelJob(id); await until(id); }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const identity = { session_id: crypto.randomUUID(), scope_id: "backend-actor-room-device-binding" };
  const create = { ...identity, cwd: directory, workspace_write: true, funding: "shapes_credits" };
  function turn(prompt = "first", key = "stable_request_key_first") {
    return { ...identity, prompt, request_key: key, gateway: { ...identity, request_key: key,
      base_url: "http://127.0.0.1:1/v1", token: "ephemeral-fixture-secret-not-for-disk", model: "fixture-model",
      run_id: crypto.randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 120 } };
  }
  return { directory, state, jobs, executable, calls, identity, create, turn, request, restart };
}

test("session discovery and immutable creation need no personal login or inference", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/capabilities")).body.features.bundled_sessions, true);
  assert.equal((await f.request("/capabilities")).body.features.session_input, true);
  assert.equal((await f.request("/sessions/create", f.create, "wrong")).status, 401);
  assert.equal(fs.existsSync(f.state), false);
  const first = await f.request("/sessions/create", f.create);
  assert.equal(first.status, 200);
  assert.equal(first.body.sandbox, "workspace-write");
  assert.equal(first.body.turn_count, 0);
  assert.deepEqual((await f.request("/sessions/create", f.create)).body, first.body);
  assert.equal((await f.request("/sessions/create", { ...f.create, workspace_write: false })).status, 409);
  assert.equal((await f.request("/sessions/create", { ...f.create, scope_id: "other" })).status, 403);
  assert.equal((await f.request("/sessions/create", { ...f.create, funding: "personal" })).status, 400);
  assert.equal(fs.existsSync(f.calls), false);
  fs.unlinkSync(f.executable);
  assert.equal((await f.request("/capabilities")).body.features.bundled_sessions, false);
  assert.equal((await f.request("/capabilities")).body.features.session_input, false);
  assert.equal((await f.request("/agents/start", f.turn())).status, 409);
});

test("typed original input survives authenticated dispatch, retry, restart and same-thread followup", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const { prompt: _prompt, ...base } = f.turn();
  const input = [{ type: "text", text: "Fix this exact bug.\nKeep my wording." },
    { type: "image", url: PNG },
    { type: "text", text: "Inspect the selected project before making changes." }];
  const body = { ...base, input };
  assert.equal((await f.request("/agents/start", body, "wrong")).status, 401);
  assert.equal(fs.existsSync(f.calls), false);
  const start = await f.request("/agents/start", body);
  assert.equal(start.status, 202);
  const first = await until(start.body.job_id);
  assert.equal(first.state, "completed");
  const stored = path.join(f.jobs, start.body.job_id, "request.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(stored)).input, input);
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  assert.equal((await f.request(`/agents/jobs?request_key=${body.request_key}`)).body.jobs[0].task_preview.includes("base64"), false);
  assert.equal((await f.request("/agents/start", body)).body.job_id, start.body.job_id);
  const changed = input.map((item) => item.type === "image" ? { ...item, url: OTHER_PNG } : item);
  assert.equal((await f.request("/agents/start", { ...body, input: changed })).status, 409);
  assert.equal((await f.request("/agents/start", { ...body, input: [...input].reverse() })).status, 409);
  await f.restart();
  assert.equal((await f.request(`/agents/jobs?request_key=${body.request_key}`)).body.jobs[0].job_id, start.body.job_id);
  assert.equal((await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`)).body.turn_count, 1);
  const { prompt: _followup, ...followup } = f.turn("unused", "typed_input_followup_key");
  const nextInput = [{ type: "text", text: "Now verify the result." }];
  const next = await f.request("/agents/start", { ...followup, input: nextInput });
  const second = await until(next.body.job_id);
  assert.equal(second.thread_id, first.thread_id);
  const turns = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse).filter((call) => call.method === "turn/start");
  assert.deepEqual(turns.map((turn) => turn.params.input), [input, nextInput]);
});

test("typed text at the aggregate byte limit keeps all input despite preview separators", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const { prompt: _prompt, ...base } = f.turn();
  const input = [{ type: "text", text: "é".repeat(16384) }, { type: "text", text: "x".repeat(32768) }];
  assert.equal(input.reduce((bytes, item) => bytes + Buffer.byteLength(item.text), 0), 65536);
  const started = await f.request("/agents/start", { ...base, input });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal((await until(started.body.job_id)).state, "completed");
  const request = JSON.parse(fs.readFileSync(path.join(f.jobs, started.body.job_id, "request.json")));
  assert.deepEqual(request.input, input);
  assert.ok(Buffer.byteLength(request.prompt) <= 65536);
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.find((call) => call.method === "turn/start").params.input, input);
});

test("source context is delivered once across five followups and restart, with stable retry and isolated sessions", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const context = [{ type: "text", text: "Fix this exact screenshot", context_key: "source:sha256:0" },
    { type: "image", url: PNG, context_key: "source:sha256:1" }];
  const { prompt: _prompt, ...base } = f.turn();
  const body = { ...base, input: [...context, { type: "text", text: "Inspect before editing." }] };
  const first = await f.request("/agents/start", body);
  assert.equal(first.status, 202);
  const initial = await until(first.body.job_id);
  assert.equal(initial.state, "completed");
  for (let index = 0; index < 5; index++) {
    if (index === 2) await f.restart();
    const { prompt: _unused, ...next } = f.turn("unused", `source_followup_${index}_key`);
    const input = [...context, { type: "text", text: `Continue step ${index}.` }];
    const started = await f.request("/agents/start", { ...next, input });
    assert.equal(started.status, 202);
    const result = await until(started.body.job_id);
    assert.equal(result.state, "completed");
    assert.equal(result.thread_id, initial.thread_id);
    const stored = JSON.parse(fs.readFileSync(path.join(f.jobs, started.body.job_id, "request.json")));
    assert.deepEqual(stored.input, input);
    assert.deepEqual(stored.runtimeInput, [input.at(-1)]);
  }
  const read = await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`);
  assert.equal(read.body.context_thread_id, initial.thread_id);
  assert.deepEqual(read.body.delivered_context_keys.sort(), context.map((item) => item.context_key).sort());
  assert.equal((await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`, undefined, "wrong")).status, 401);
  const retried = await f.request("/agents/start", body);
  assert.equal(retried.body.job_id, first.body.job_id);
  assert.equal(retried.body.deduplicated, true);
  const { prompt: _unused, ...changed } = f.turn("unused", "changed_context_new_key");
  assert.equal((await f.request("/agents/start", { ...changed,
    input: [{ ...context[0], text: "Different source under same key" }, body.input.at(-1)] })).status, 409);
  const other = { ...f.identity, session_id: crypto.randomUUID(), scope_id: "different-session-scope" };
  await f.request("/sessions/create", { ...f.create, ...other });
  const isolated = await f.request("/agents/start", { ...changed, ...other, input: body.input,
    gateway: { ...changed.gateway, ...other } });
  assert.equal(isolated.status, 202);
  assert.equal((await until(isolated.body.job_id)).state, "completed");
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse).filter((call) => call.method === "turn/start");
  const original = body.input.map(({ context_key: _key, ...item }) => item);
  assert.deepEqual(calls[0].params.input, original);
  assert.deepEqual(calls.at(-1).params.input, original);
  assert.ok(calls.slice(1, -1).every((call) => call.params.input.length === 1));
  assert.ok(calls.every((call) => call.params.input.every((item) => !Object.hasOwn(item, "context_key"))));
});

test("a created thread with rejected input does not suppress context on the next turn", async (t) => {
  const f = await fixture(t, { rejectFirstTurn: true });
  await f.request("/sessions/create", f.create);
  const input = [{ type: "text", text: "Original request", context_key: "original:0" },
    { type: "image", url: PNG, context_key: "original:1" }];
  const { prompt: _prompt, ...base } = f.turn();
  const first = await f.request("/agents/start", { ...base, input });
  const failed = await until(first.body.job_id);
  assert.equal(failed.state, "failed");
  const read = (await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`)).body;
  assert.equal(read.context_thread_id, failed.thread_id);
  assert.deepEqual(read.delivered_context_keys, []);
  const { prompt: _next, ...next } = f.turn("unused", "retry_after_rejected_input");
  const second = await f.request("/agents/start", { ...next, input });
  assert.equal((await until(second.body.job_id)).state, "completed");
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse).filter((call) => call.method === "turn/start");
  assert.deepEqual(calls[0].params.input, calls[1].params.input);
  assert.equal((await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`)).body.delivered_context_keys.length, 2);
});

test("invalid typed input is rejected before creating a job or calling the runtime", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const { prompt: _prompt, ...base } = f.turn();
  const text = { type: "text", text: "original" }, image = { type: "image", url: PNG };
  const largeImage = (size) => ({ type: "image", url: "data:image/png;base64," + Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(size - 8),
  ]).toString("base64") });
  const invalid = [null, [], {}, [null], [{ ...text, role: "system" }], [{ type: "localImage", path: "/private.png" }],
    [{ ...text, context_key: "" }], [{ ...text, context_key: "x".repeat(161) }], [{ ...text, context_key: "has space" }],
    [{ ...text, context_key: "same" }, { ...image, context_key: "same" }],
    [text, { ...image, detail: "high" }], [{ type: "text", text: 1 }], [{ type: "text", text: "  " }],
    Array(65).fill(text), Array(5).fill(image), [{ type: "text", text: "é".repeat(32769) }],
    [largeImage(65537)], [largeImage(40000), largeImage(40000)],
    [{ type: "text", text: "x".repeat(65536) }, largeImage(50000)],
    [{ type: "image", url: PNG.replace("image/png", "image/jpeg") }],
    [{ type: "image", url: PNG + "=" }], [{ type: "image", url: PNG.replace("base64,", "base64,\n") }],
    ...["https://files.example.test/a.png", "http://files.example.test/a.png", "file:///private.png", "data:image/png;base64,eA==", "https://user:pass@files.example.test/a.png",
      "https://files.example.test/a.png#", "https://files.example.test/a.png#part", "https://files.example.test/a b.png",
      "https://files.example.test/" + "x".repeat(4096)].map((url) => [{ type: "image", url }])];
  for (const input of invalid) assert.equal((await f.request("/agents/start", { ...base, input })).status, 400, JSON.stringify(input).slice(0, 200));
  assert.equal((await f.request("/agents/start", { ...base, prompt: "duplicate", input: [text] })).status, 400);
  assert.equal((await f.request("/agents/start", base)).status, 400);
  assert.equal(fs.existsSync(f.calls), false);
  assert.deepEqual((await f.request("/agents/jobs")).body.jobs, []);
  assert.equal((await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`)).body.turn_count, 0);
});

test("image-only session input remains image input and uses a text-only preview", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const { prompt: _prompt, ...base } = f.turn();
  const input = Array.from({ length: 4 }, () => ({ type: "image", url: PNG }));
  const start = await f.request("/agents/start", { ...base, input });
  assert.equal(start.status, 202);
  assert.equal((await until(start.body.job_id)).state, "completed");
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.find((call) => call.method === "turn/start").params.input, input);
  assert.equal((await f.request(`/agents/jobs?request_key=${base.request_key}`)).body.jobs[0].task_preview, "Image attachment");
});

test("typed image turns retain existing cancellation and allow a later legacy prompt", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const { prompt: _prompt, ...base } = f.turn();
  const start = await f.request("/agents/start", { ...base, input: [{ type: "text", text: "wait" },
    { type: "image", url: PNG }] });
  await until(start.body.job_id, (value) => value.state === "waiting_on_user");
  assert.equal((await f.request("/agents/cancel", { job_id: start.body.job_id })).status, 200);
  const cancelled = await until(start.body.job_id);
  assert.equal(cancelled.state, "cancelled");
  await f.restart();
  const next = await f.request("/agents/start", f.turn("legacy followup", "legacy_after_image_key"));
  assert.equal((await until(next.body.job_id)).thread_id, cancelled.thread_id);
});

test("HTTP session cancellation reaches a durable terminal receipt despite escaped pipes", async (t) => {
  const f = await fixture(t);
  let escaped;
  t.after(() => { if (escaped) try { process.kill(-escaped, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  await f.request("/sessions/create", f.create);
  const started = await f.request("/agents/start", f.turn("detached-pipe"));
  const id = started.body.job_id;
  for (let i = 0; i < 100 && !fs.existsSync(path.join(f.directory, "escaped.pid")); i++) await new Promise((r) => setTimeout(r, 10));
  escaped = Number(fs.readFileSync(path.join(f.directory, "escaped.pid"), "utf8"));
  const since = Date.now();
  assert.equal((await f.request("/agents/cancel", { job_id: id })).body.cancel_requested, true);
  const result = await until(id);
  assert.equal(result.state, "cancelled");
  assert.ok(Date.now() - since < 2500);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.jobs, id, "state.json"))).status, "cancelled");
  assert.doesNotThrow(() => process.kill(escaped, 0));
  await f.restart();
  const restored = await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`);
  assert.equal(restored.body.latest_job.state, "cancelled");
  assert.equal(restored.body.state, "idle");
});

test("late HTTP cancel preserves a settled gateway failure or completion and permits the next turn", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  let threadId;
  // Simulates the app-server failure after the gateway's Stop fence wins the
  // race. A later authenticated cancel must not rewrite that audit outcome,
  // and the same no-op contract must preserve work that already completed.
  for (const [prompt, expected] of [["gatewayStopped", "failed"], ["completed", "completed"]]) {
    const started = await f.request("/agents/start", f.turn(prompt, `late_cancel_${prompt}`));
    assert.equal(started.status, 202);
    const id = started.body.job_id, settled = await until(id);
    assert.equal(settled.state, expected);
    if (threadId) assert.equal(settled.thread_id, threadId);
    threadId = settled.thread_id;
    if (expected === "failed") {
      assert.equal(settled.error_type, "agent_error");
      assert.match(settled.error, /403 Forbidden/);
    }
    const receipt = path.join(f.jobs, id, "state.json");
    const before = fs.readFileSync(receipt, "utf8");
    assert.equal((await f.request("/agents/cancel", { job_id: id }, "wrong")).status, 401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const cancelled = await f.request("/agents/cancel", { job_id: id });
      assert.equal(cancelled.status, 200);
      assert.deepEqual(cancelled.body, { job_id: id, state: expected, agent: "codex", cancel_requested: false });
    }
    assert.equal(fs.readFileSync(receipt, "utf8"), before);
    assert.equal(fs.existsSync(path.join(f.jobs, id, "cancel")), false);
    await f.restart();
    const restored = await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`);
    assert.equal(restored.body.latest_job.state, expected);
    assert.equal(restored.body.state, "idle");
  }
  const followup = await f.request("/agents/start", f.turn("continue", "late_cancel_followup"));
  const completed = await until(followup.body.job_id);
  assert.equal(completed.state, "completed");
  assert.equal(completed.thread_id, threadId);
});

test("bundled job recovers a cold initialization timeout with one turn and durable phase diagnostics", async (t) => {
  const f = await fixture(t, { stallFirstInitialize: true });
  await f.request("/sessions/create", f.create);
  const result = await f.request("/agents/start", f.turn("recovered"));
  assert.equal(result.status, 202);
  const status = await until(result.body.job_id, (value) => terminal.has(value.state), 1100);
  assert.equal(status.state, "completed");
  assert.equal(status.final, "Completed recovered");
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((m) => m.method === "initialize").length, 2);
  assert.equal(calls.filter((m) => m.method === "turn/start").length, 1);
  const directory = path.join(f.jobs, result.body.job_id);
  const state = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
  assert.equal(state.runtimeStartup.attempt, 2);
  assert.equal(state.runtimeStartup.phase, "running");
  const events = fs.readFileSync(path.join(directory, "events.jsonl"), "utf8");
  assert.ok(events.includes('"failure":"timeout"'));
  assert.ok(events.includes('"phase":"initialize"'));
  assert.equal(events.includes(f.turn().gateway.token), false);
  assert.throws(() => process.kill(state.agentPid, 0), { code: "ESRCH" });
});

test("turn retry, events, restart, and followup reuse durable jobs and one native thread", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const body = f.turn(), start = await f.request("/agents/start", body);
  assert.equal(start.status, 202);
  assert.equal(start.body.agent, "codex");
  assert.equal(start.body.funding, "shapes_credits");
  const first = await until(start.body.job_id);
  assert.equal(first.state, "completed");
  assert.equal(first.final, "Completed first");
  assert.equal(first.usage.input_tokens, 100);
  const repeat = await f.request("/agents/start", body);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.job_id, start.body.job_id);
  const recovered = await f.request(`/agents/jobs?request_key=${body.request_key}`);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.jobs.length, 1);
  assert.equal(recovered.body.jobs[0].job_id, start.body.job_id, "the original request key recovers a lost start receipt");
  assert.equal((await f.request("/agents/start", { ...body, prompt: "changed" })).status, 409);
  await f.restart();
  const query = new URLSearchParams(f.identity);
  assert.equal((await f.request(`/sessions/read?${query}`)).body.turn_count, 1);
  const events = await f.request(`/sessions/events?${query}`);
  assert.ok(events.body.events.some((event) => event.type === "item.completed" && event.item.text === "Completed first"));
  assert.ok(events.body.events.some((event) => event.type === "job.finished" && event.state === "completed"));
  assert.equal((await f.request(`/sessions/events?${query}&cursor=${events.body.cursor}`)).body.events.length, 0);
  assert.equal((await f.request(`/sessions/events?${query}&cursor=999:0`)).status, 400);
  assert.equal((await f.request(`/sessions/read?session_id=${f.identity.session_id}&scope_id=other`)).status, 403);
  const next = await f.request("/agents/start", f.turn("followup", "stable_request_key_followup"));
  const second = await until(next.body.job_id);
  assert.equal(second.state, "completed");
  assert.equal(second.thread_id, first.thread_id);
  assert.equal(second.usage.input_tokens, 100, "previous turn usage must not be charged again in receipts");
  assert.equal(second.usage.output_tokens, 20);
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 1);
  assert.equal(calls.filter((call) => call.method === "thread/resume").length, 1);
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 2);
});

test("funding grants bind scope, session, request, expiry, and secure transport before launching", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  for (const patch of [{ scope_id: "other" }, { session_id: crypto.randomUUID() }, { request_key: "other_request_key" },
    { expires_at: Math.floor(Date.now() / 1000) - 1 }, { token: "" }, { base_url: "http://provider.example/v1" }]) {
    const body = f.turn();
    assert.equal((await f.request("/agents/start", { ...body, gateway: { ...body.gateway, ...patch } })).status, 400);
  }
  assert.equal((await f.request("/agents/start", { ...f.turn(), cwd: f.directory })).status, 400);
  assert.equal(fs.existsSync(f.calls), false);
  assert.equal((await f.request(`/sessions/read?${new URLSearchParams(f.identity)}`)).body.turn_count, 0);
});

test("cancellation closes a pending request without permission and allows the next turn", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  const body = f.turn("wait"), start = await f.request("/agents/start", body);
  const waiting = await until(start.body.job_id, (value) => value.state === "waiting_on_user");
  assert.equal((await f.request("/agents/start", f.turn("another", "another_request_key"))).status, 409);
  assert.equal((await f.request("/agents/start", body)).body.job_id, start.body.job_id);
  assert.equal((await f.request("/agents/cancel", { job_id: start.body.job_id }, "wrong")).status, 401);
  assert.equal(getStatus(start.body.job_id).state, "waiting_on_user");
  assert.equal((await f.request("/agents/cancel", { job_id: start.body.job_id })).status, 200);
  const cancelled = await until(start.body.job_id);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(cancelled.pending_requests, []);
  assert.equal((await f.request("/agents/respond", { job_id: start.body.job_id, request_id: waiting.pending_requests[0].id,
    response: { decision: "accept", values: { answer: "Yes" } } })).status, 409);
  const after = await f.request("/agents/start", f.turn("after cancel", "after_cancel_request_key"));
  assert.equal((await until(after.body.job_id)).state, "completed");
  const state = JSON.parse(fs.readFileSync(path.join(f.jobs, start.body.job_id, "state.json")));
  assert.throws(() => process.kill(state.agentPid, 0), { code: "ESRCH" });
});

test("provider and runtime failures settle, and the grant never enters durable receipts or logs", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  for (const prompt of ["leak", "fail", "exit", "recovered"]) {
    const body = f.turn(prompt, `request_key_for_${prompt}`), start = await f.request("/agents/start", body);
    assert.equal(start.status, 202);
    const status = await until(start.body.job_id);
    assert.equal(status.state, ["leak", "recovered"].includes(prompt) ? "completed" : "failed");
    if (prompt === "recovered") assert.equal(status.usage.input_tokens, 100, "a failed resume without usage must preserve the previous baseline");
    if (prompt === "leak") assert.equal(status.final, "Result [redacted]");
    assert.equal(JSON.stringify(status).includes(body.gateway.token), false);
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else assert.equal(fs.readFileSync(file, "utf8").includes(f.turn().gateway.token), false, file);
    }
  };
  visit(f.state); visit(f.jobs);
});

test("funded provider failures preserve the cause without personal account advice", async (t) => {
  const f = await fixture(t);
  await f.request("/sessions/create", f.create);
  for (const code of [401, 429]) {
    const body = f.turn(`provider${code}`, `provider_failure_key_${code}`);
    const started = await f.request("/agents/start", body);
    assert.equal(started.status, 202);
    const status = await until(started.body.job_id);
    assert.equal(status.state, "failed");
    assert.equal(status.funding, "shapes_credits");
    assert.match(status.error, new RegExp(`HTTP ${code}`));
    assert.match(status.error, /shapes\.inc/);
    assert.doesNotMatch(status.error, /Sign in|account on this computer|check its plan|Open Codex|Codex.*settings/);
    assert.equal(status.final, "");
    assert.equal(status.usage, null);
    const stored = JSON.parse(fs.readFileSync(path.join(f.jobs, started.body.job_id, "state.json")));
    assert.equal(stored.status, "failed");
    assert.equal(stored.error, status.error);
    const repeated = await f.request("/agents/start", body);
    assert.equal(repeated.body.job_id, started.body.job_id);
  }
});
