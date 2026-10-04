"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startJob, getStatus, cancelJob, respondJob } = require("../src/codex");
const { startServer } = require("../src/server");
const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);

async function until(id, condition) {
  for (let index = 0; index < 150; index++) {
    const result = getStatus(id);
    if (condition(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Job did not reach expected state: ${JSON.stringify(getStatus(id))}`);
}

async function fixture(t, { unsupported = false, asyncQuestion = false, interactiveSupported = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-interactive-test-"));
  const previous = { SHAPES_CODEX_JOB_DIR: process.env.SHAPES_CODEX_JOB_DIR, SHAPES_CODEX_BINARY: process.env.SHAPES_CODEX_BINARY };
  process.env.SHAPES_CODEX_JOB_DIR = path.join(directory, "jobs");
  process.env.SHAPES_CODEX_BINARY = path.join(directory, "codex");
  fs.writeFileSync(process.env.SHAPES_CODEX_BINARY, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
if(process.argv.includes('--help')) { console.log(${JSON.stringify("--json --sandbox --ephemeral" + (interactiveSupported ? " --listen" : ""))}); process.exit(0); }
if(process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const threadId='019f1234-abcd-7123-8123-0123456789ab',turnId='turn-1';
let turns=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);
 if(value.method==='initialize') send({id:value.id,result:{userAgent:'test'}});
 if(value.method==='thread/start') {fs.appendFileSync(${JSON.stringify(path.join(directory, "starts"))},'start\\n');send({id:value.id,result:{thread:{id:threadId},approvalPolicy:'on-request',approvalsReviewer:'user'}});}
 if(value.method==='turn/start') {
   turns++;
   fs.appendFileSync(${JSON.stringify(path.join(directory, "turns"))},JSON.stringify(value.params.input)+'\\n');
   if(turns===2) {
     if(!JSON.stringify(value.params.input).includes('Small') || JSON.stringify(value.params.input).includes('Complete the controlled test.')) process.exit(4);
     send({id:value.id,result:{turn:{id:'turn-2',status:'inProgress'}}});
     send({method:'turn/started',params:{threadId,turn:{id:'turn-2',status:'inProgress'}}});
     send({method:'item/completed',params:{threadId,turnId:'turn-2',item:{id:'answer-2',type:'agentMessage',text:'Confirmed test task completed.',phase:'final_answer'}}});
     send({method:'turn/completed',params:{threadId,turn:{id:'turn-2',status:'completed',error:null}}});
     return;
   }
   send({id:value.id,result:{turn:{id:turnId,status:'inProgress'}}});
   send({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});
   send({id:0,method:'mcpServer/elicitation/request',params:{threadId,turnId,serverName:'cua_repl',mode:${JSON.stringify(unsupported ? "openai/userVerification" : "form")},message:'Allow access to https://example.org?',_meta:{secret:'private-native-metadata'},requestedSchema:{type:'object',properties:{}}}});
 }
 if(value.id===0 && value.result) {
   if(value.result.action!=='accept') {send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'failed',error:{message:'Permission declined'}}}});return;}
   if(${asyncQuestion}) {
     send({method:'item/completed',params:{threadId,turnId,item:{id:'async-question',type:'agentMessage',text:'Which size?',delivery:'async',questions:[{title:'Which size?',options:['Small','Large']}]}}});
     send({method:'item/completed',params:{threadId,turnId,item:{id:'waiting-answer',type:'agentMessage',text:'Waiting for your answer.',phase:'final_answer'}}});
     send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}});
   } else send({id:'question-1',method:'item/tool/requestUserInput',params:{threadId,turnId,itemId:'input-1',isBlocking:true,questions:[{id:'size',header:'Size',question:'Which size?',options:[{label:'Small',description:'One serving'}]}]}});
 }
 if(value.id==='question-1' && value.result) {
   if(value.result.answers.size.answers[0]!=='Small') process.exit(3);
   send({method:'item/completed',params:{threadId,turnId,item:{id:'answer',type:'agentMessage',text:'Confirmed test task completed.',phase:'final_answer'}}});
   send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',error:null}}});
 }
 if(value.method==='turn/interrupt') {send({id:value.id,result:{}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'interrupted'}}});}
}).on('close',()=>process.exit(0));
`, { mode: 0o700 });
  const jobs = [];
  const server = await startServer({ port: 0, token: "interactive-test-token" });
  t.after(async () => {
    for (const job of jobs) {
      if (!terminal.has(getStatus(job).state)) { cancelJob(job); await until(job, (value) => terminal.has(value.state)); }
    }
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, async start(timeoutSeconds = 30) {
    const job = await startJob({ prompt: "Complete the controlled test.", cwd: directory, interactive: true, timeoutSeconds });
    jobs.push(job.job_id); return job.job_id;
  }, async request(route, body, token = "interactive-test-token") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: body ? "POST" : "GET",
      headers: { "x-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  } };
}

test("authenticated answer resumes the same pending job through native input and final result", async (t) => {
  const f = await fixture(t), id = await f.start();
  const waiting = await until(id, (value) => value.state === "waiting_on_user");
  assert.equal(waiting.thread_id, "019f1234-abcd-7123-8123-0123456789ab");
  assert.equal(waiting.interactive, true);
  assert.equal(JSON.stringify(waiting).includes("private-native-metadata"), false);
  const requestId = waiting.pending_requests[0].id;
  const payload = { job_id: id, request_id: requestId, response: { decision: "accept", values: {} } };
  assert.equal((await f.request("/agents/respond", payload, "wrong-token")).status, 401);
  assert.equal(getStatus(id).state, "waiting_on_user");
  assert.equal((await f.request("/agents/status?wait=0&job_id=" + id)).body.state, "waiting_on_user");
  assert.equal((await f.request("/agents/respond", payload)).status, 200);
  assert.equal((await f.request("/agents/respond", payload)).status, 409);
  const question = await until(id, (value) => value.pending_requests?.[0]?.kind === "input");
  assert.equal(question.thread_id, waiting.thread_id);
  assert.throws(() => respondJob(id, question.pending_requests[0].id, { decision: "accept", values: { size: "Large" } }));
  respondJob(id, question.pending_requests[0].id, { decision: "accept", values: { size: "Small" } });
  const result = await until(id, (value) => terminal.has(value.state));
  assert.equal(result.state, "completed");
  assert.equal(result.final, "Confirmed test task completed.");
  assert.deepEqual(result.pending_requests, []);
  assert.equal(fs.readFileSync(path.join(f.directory, "starts"), "utf8"), "start\n");
  assert.throws(() => respondJob(id, requestId, payload.response), (error) => error.statusCode === 409);
  const state = JSON.parse(fs.readFileSync(path.join(f.directory, "jobs", id, "state.json"), "utf8"));
  assert.throws(() => process.kill(state.agentPid, 0), (error) => error.code === "ESRCH");
});

test("headless-only Codex is rejected with an update instruction before creating an interactive job", async (t) => {
  const f = await fixture(t, { interactiveSupported: false });
  await assert.rejects(f.start(), (error) => error.errorType === "agent_unavailable" && error.agents[0].status === "unsupported" && /Update Codex/.test(error.message));
  assert.equal(fs.existsSync(path.join(f.directory, "jobs")), false);
  assert.equal(fs.existsSync(path.join(f.directory, "starts")), false);
});

test("cancel and deadline invalidate a live prompt without granting permission", async (t) => {
  for (const operation of ["cancel", "timeout"]) await t.test(operation, async (t) => {
    const f = await fixture(t), id = await f.start(operation === "timeout" ? 1 : 30);
    const waiting = await until(id, (value) => value.state === "waiting_on_user");
    if (operation === "cancel") respondJob(id, waiting.pending_requests[0].id, { decision: "cancel" });
    const result = await until(id, (value) => terminal.has(value.state));
    assert.equal(result.state, operation === "timeout" ? "timed_out" : "cancelled");
    assert.deepEqual(result.pending_requests, []);
    assert.equal(result.final, "");
  });
});

test("device verification is not represented as ordinary consent or false success", async (t) => {
  const f = await fixture(t, { unsupported: true }), id = await f.start();
  const result = await until(id, (value) => terminal.has(value.state));
  assert.equal(result.state, "failed");
  assert.equal(result.error_type, "unsupported_approval");
  assert.deepEqual(result.pending_requests, []);
  assert.equal(result.final, "");
});

test("a question after the native turn ends waits for a human and continues the same task once", async (t) => {
  const f = await fixture(t, { asyncQuestion: true }), id = await f.start();
  const permission = await until(id, (value) => value.state === "waiting_on_user");
  respondJob(id, permission.pending_requests[0].id, { decision: "accept", values: {} });
  const question = await until(id, (value) => value.pending_requests?.[0]?.kind === "input");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(getStatus(id).state, "waiting_on_user");
  assert.equal(fs.readFileSync(path.join(f.directory, "turns"), "utf8").trim().split("\n").length, 1);
  const request = question.pending_requests[0];
  respondJob(id, request.id, { decision: "accept", values: { [request.fields[0].id]: "Small" } });
  const result = await until(id, (value) => terminal.has(value.state));
  assert.equal(result.state, "completed");
  assert.equal(result.final, "Confirmed test task completed.");
  assert.equal(result.thread_id, question.thread_id);
  assert.equal(fs.readFileSync(path.join(f.directory, "starts"), "utf8"), "start\n");
  assert.equal(fs.readFileSync(path.join(f.directory, "turns"), "utf8").trim().split("\n").length, 2);
});
