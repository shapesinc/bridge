"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCodexRpcSession } = require("../src/codex-rpc");

function fixture(t, body, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-codex-rpc-"));
  const executable = path.join(dir, "fake-codex");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs'); const input=[];
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const reply=(m,result)=>send({id:m.id,result});
const done=(status='completed',items=[])=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status,items}}});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); input.push(m);fs.writeFileSync(${JSON.stringify(path.join(dir, "input.json"))},JSON.stringify(input));
  if(m.method==='initialize'){reply(m,{});return;}
  if(m.method==='thread/start'){reply(m,{thread:{id:'thread-1'},approvalPolicy:'on-request',approvalsReviewer:'user'});send({method:'thread/started',params:{thread:{id:'thread-1'}}});return;}
  ${body}
});`, { mode: 0o700 });
  const events = [], requests = [], resolved = [];
  const session = createCodexRpcSession({ executable, cwd: dir,
    onEvent: (event) => events.push(event), onServerRequest: (request) => requests.push(request),
    onRequestResolved: (request) => resolved.push(request), shutdownTimeoutMs: 100,
    ...options });
  t.after(async () => { await session.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, executable, session, events, requests, resolved,
    input: () => JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8")) };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected protocol event was not received.");
}

test("native browser request waits for an explicit response and resumes the same turn", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1',status:'inProgress'}});
      send({method:'mcpServer/elicitation/request',id:0,params:{threadId:'thread-1',turnId:'turn-1',serverName:'cua_repl',mode:'form',message:'Allow Browser Use to access https://example.invalid?',requestedSchema:{type:'object',properties:{}},_meta:{connector_id:'browser-use',tool_name:'access_browser_origin'}}});return;
    }
    if(m.id===0&&!m.method){
      if(m.result.action!=='accept')process.exit(9);
      send({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:0}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'turn-1',tokenUsage:{last:{inputTokens:10,cachedInputTokens:3,outputTokens:2,totalTokens:12}}}});
      const item={id:'answer',type:'agentMessage',text:'Verified result.'};
      send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item}});done('completed',[item]);
    }
  `);
  let finished = false;
  const running = f.session.start("Task literal $(touch NEVER)").then((result) => { finished = true; return result; });
  assert.ok(f.session.child.pid);
  await until(() => f.requests.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(finished, false);
  assert.equal(f.input().some((message) => message.id === 0), false);
  assert.equal(f.requests[0].params._meta.tool_name, "access_browser_origin");
  assert.throws(() => f.session.respond("0", { action: "accept" }), /no longer pending/);
  f.session.respond(0, { action: "accept", content: {} });
  assert.throws(() => f.session.respond(0, { action: "accept" }), /no longer pending/);
  const result = await running;
  assert.equal(result.status, "completed");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(f.events.filter((event) => event.type === "thread.started").length, 1);
  assert.equal(f.events.filter((event) => event.type === "item.completed").length, 1);
  assert.equal(f.events.find((event) => event.type === "item.completed").item.type, "agent_message");
  assert.deepEqual(f.resolved, [{ id: 0, reason: "answered" }]);
  const thread = f.input().find((message) => message.method === "thread/start").params;
  assert.equal(thread.approvalPolicy, "on-request");
  assert.equal(thread.approvalsReviewer, "user");
  assert.equal(thread.sandbox, "read-only");
  assert.equal(Object.hasOwn(thread, "model"), false);
  assert.equal(f.input().filter((message) => message.method === "turn/start").length, 1);
  assert.equal(f.input().find((message) => message.method === "turn/start").params.input[0].text, "Task literal $(touch NEVER)");
  await assert.rejects(f.session.start("duplicate"), /only one task/);
  assert.throws(() => process.kill(f.session.child.pid, 0), { code: "ESRCH" });
});

test("questions preserve exact IDs and native failed tool results survive normalization", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'item/tool/requestUserInput',id:'question:7',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1',isBlocking:true,questions:[{id:'delivery',header:'Delivery',question:'Where?',options:[{label:'Home',description:'Saved home'}]}]}});return;
    }
    if(m.id==='question:7'&&!m.method){
      if(m.result.answers.delivery.answers[0]!=='Home')process.exit(10);
      send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'denied',type:'mcpToolCall',server:'cua_repl',tool:'js',status:'failed',result:{content:[{type:'text',text:'Browser Use rejected this action due to browser security policy.'}]}}}});
      done();
    }
  `);
  const running = f.session.start("Ask a question");
  await until(() => f.requests.length === 1);
  f.session.respond("question:7", { answers: { delivery: { answers: ["Home"] } } });
  await running;
  const item = f.events.find((event) => event.type === "item.completed").item;
  assert.equal(item.type, "mcp_tool_call");
  assert.equal(item.status, "failed");
  assert.equal(item.result.content[0].text, "Browser Use rejected this action due to browser security policy.");
});

test("server-resolved requests cannot be answered later", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'mcpServer/elicitation/request',id:'expired',params:{threadId:'thread-1',mode:'form'}});
      send({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:'expired'}});
      setTimeout(()=>done(),100);
    }
  `);
  const running = f.session.start("test expiry");
  await until(() => f.resolved.length === 1);
  assert.throws(() => f.session.respond("expired", { action: "accept" }), /no longer pending/);
  assert.deepEqual(f.resolved, [{ id: "expired", reason: "server_resolved" }]);
  await running;
});

test("command approvals require an explicit one-time response", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'item/commandExecution/requestApproval',id:'command',params:{threadId:'thread-1',turnId:'turn-1',itemId:'command-1',command:'pwd',availableDecisions:['accept','decline','cancel']}});return;
    }
    if(m.id==='command'&&!m.method){
      if(m.result.decision!=='decline')process.exit(11);
      done();
    }
  `);
  const running = f.session.start("Test command consent");
  await until(() => f.requests.length === 1);
  assert.equal(f.input().some((message) => message.id === "command"), false);
  f.session.respond("command", { decision: "decline" });
  assert.equal((await running).status, "completed");
});

test("nonblocking questions stay pending while other work continues", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'item/tool/requestUserInput',id:4,params:{threadId:'thread-1',turnId:'turn-1',itemId:'question',isBlocking:false,questions:[{id:'preference',header:'Preference',question:'Which?',isOther:true,options:[{label:'First',description:'First choice'}]}]}});
      send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'progress',type:'agentMessage',text:'Working on independent steps.'}}});return;
    }
    if(m.id===4&&!m.method){done();}
  `);
  const running = f.session.start("Ask while working");
  await until(() => f.events.some((event) => event.item?.id === "progress"));
  assert.equal(f.requests[0].params.isBlocking, false);
  assert.equal(f.session.pendingRequests.length, 1);
  f.session.respond(4, { answers: { preference: { answers: ["First"] } } });
  assert.equal((await running).status, "completed");
});

function asyncQuestionFixture(t, { early = false, multiple = false } = {}) {
  return fixture(t, `
    if(m.method==='turn/start'){
      const starts=input.filter(x=>x.method==='turn/start');
      if(starts.length===1){
        reply(m,{turn:{id:'turn-1'}});
        const question=id=>({id,type:'agentMessage',text:'Which fixture word?',phase:'final_answer',delivery:'async',questions:[{title:'Which fixture word?',options:['Alpha','Beta']}]});
        const items=[question('question-1')${multiple ? ",question('question-2')" : ""}];
        for(const item of items)send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item}});
        send({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'turn-1',tokenUsage:{last:{inputTokens:10,outputTokens:2},total:{inputTokens:30,outputTokens:5,totalTokens:35}}}});
        const finish=()=>done('completed',[...items,{id:'waiting',type:'agentMessage',text:'Waiting for fixture response.'}]);
        ${early ? "setTimeout(finish,150);" : "finish();"}return;
      }
      if(starts.length>2)process.exit(12);
      reply(m,{turn:{id:'turn-2'}});
      send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-2',status:'inProgress'}}});
      send({method:'thread/tokenUsage/updated',params:{threadId:'thread-1',turnId:'turn-2',tokenUsage:{last:{inputTokens:15,outputTokens:3},total:{inputTokens:45,outputTokens:8,totalTokens:53}}}});
      send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-2',status:'completed',items:[{id:'final',type:'agentMessage',text:'Fixture completed.'}]}}});
    }
  `);
}

test("native async question survives final text and resumes once after a late answer", async (t) => {
  const f = asyncQuestionFixture(t);
  let finished = false;
  const running = f.session.start("Original task, never replay").then((value) => { finished = true; return value; });
  await until(() => f.events.some((event) => event.item?.id === "waiting"));
  assert.equal(f.requests.length, 1);
  assert.equal(finished, false);
  assert.equal(f.events.some((event) => event.type === "turn.completed"), false);
  assert.equal(f.session.pendingRequests.length, 1);
  const request = f.requests[0];
  assert.equal(request.method, "item/tool/requestUserInput");
  assert.equal(request.params.questions[0].id, "question-1");
  assert.equal(request.params.questions[0].isOther, true);
  f.session.respond(request.id, { answers: { "question-1": { answers: ["Alpha"] } } });
  assert.throws(() => f.session.respond(request.id, { answers: {} }), /no longer pending/);
  const result = await running;
  assert.equal(result.status, "completed");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.turnId, "turn-2");
  assert.equal(result.usage.input_tokens, 45);
  assert.equal(result.usage.output_tokens, 8);
  const starts = f.input().filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.threadId, "thread-1");
  assert.match(starts[1].params.input[0].text, /Alpha/);
  assert.doesNotMatch(starts[1].params.input[0].text, /Original task/);
  assert.equal(f.input().some((message) => message.id === request.id), false);
  assert.equal(f.events.filter((event) => event.type === "turn.completed").length, 1);
});

test("an early async answer waits for the active turn to finish", async (t) => {
  const f = asyncQuestionFixture(t, { early: true });
  const running = f.session.start("Original task");
  await until(() => f.requests.length === 1);
  f.session.respond(f.requests[0].id, { answers: { "question-1": { answers: ["Beta"] } } });
  assert.equal(f.input().filter((message) => message.method === "turn/start").length, 1);
  assert.equal((await running).turnId, "turn-2");
  assert.equal(f.input().filter((message) => message.method === "turn/start").length, 2);
});

test("multiple async prompts collect explicit answers before one continuation", async (t) => {
  const f = asyncQuestionFixture(t, { multiple: true });
  const running = f.session.start("Original task");
  await until(() => f.events.some((event) => event.item?.id === "waiting"));
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.requests[0].id, f.requests[1].id);
  f.session.respond(f.requests[0].id, { answers: { "question-1": { answers: ["Alpha"] } } });
  assert.equal(f.session.pendingRequests.length, 1);
  assert.equal(f.input().filter((message) => message.method === "turn/start").length, 1);
  f.session.respond(f.requests[1].id, { answers: { "question-1": { answers: ["Beta"] } } });
  await running;
  const starts = f.input().filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.match(starts[1].params.input[0].text, /Alpha/);
  assert.match(starts[1].params.input[0].text, /Beta/);
});

test("cancelling an unanswered async question never starts a continuation", async (t) => {
  const f = asyncQuestionFixture(t);
  const running = f.session.start("Original task");
  await until(() => f.events.some((event) => event.item?.id === "waiting"));
  await f.session.close();
  await assert.rejects(running, /closed before turn completion/);
  assert.equal(f.input().filter((message) => message.method === "turn/start").length, 1);
  assert.equal(f.events.some((event) => event.type === "turn.completed"), false);
  assert.throws(() => f.session.respond(f.requests[0].id, { answers: {} }), /no longer pending/);
});

test("ordinary question-like prose does not synthesize user requests", async (t) => {
  const f = fixture(t, `if(m.method==='turn/start'){reply(m,{turn:{id:'turn-1'}});done('completed',[{id:'prose',type:'agentMessage',text:'Where should I deliver?',delivery:null,questions:null}]);}`);
  assert.equal((await f.session.start("No synthetic prose questions")).status, "completed");
  assert.equal(f.requests.length, 0);
});

test("late start responses cannot overwrite a newer continuation turn", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      const starts=input.filter(x=>x.method==='turn/start');
      if(starts.length===1){
        global.firstStart=m;
        send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
        done('completed',[{id:'late-question',type:'agentMessage',text:'Choose?',delivery:'async',questions:[{title:'Choose?',options:['Alpha']}]}]);return;
      }
      reply(m,{turn:{id:'turn-2'}});
      send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-2'}}});
      reply(global.firstStart,{turn:{id:'turn-1'}});
      setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-2',status:'completed',items:[]}}}),30);
    }
  `);
  const running = f.session.start("Original task");
  await until(() => f.requests.length === 1);
  f.session.respond(f.requests[0].id, { answers: { "question-1": { answers: ["Alpha"] } } });
  assert.equal((await running).turnId, "turn-2");
  assert.equal(f.input().filter((message) => message.method === "turn/start").length, 2);
});

test("closing during pending callbacks is idempotent and cannot restart", async (t) => {
  let session;
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'mcpServer/elicitation/request',id:9,params:{threadId:'thread-1',mode:'form'}});
    }
  `, { onRequestResolved: () => { void session.close(); } });
  session = f.session;
  const running = session.start("Close safely");
  await until(() => f.requests.length === 1);
  await session.close();
  await assert.rejects(running, /closed before turn completion/);
  assert.equal(session.pendingRequests.length, 0);
  assert.equal(f.input().some((message) => message.id === 9), false);
  await assert.rejects(session.start("restart"), /only one task/);
});

test("a session closed before start cannot launch a child", async (t) => {
  const f = fixture(t, "");
  await f.session.close();
  await assert.rejects(f.session.start("late start"), /closed/);
  assert.equal(f.session.child, undefined);
});

test("interrupting clears pending approval without granting it", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'mcpServer/elicitation/request',id:8,params:{threadId:'thread-1',mode:'form'}});return;
    }
    if(m.method==='turn/interrupt'){reply(m,{});done('interrupted');}
  `);
  const running = f.session.start("test interruption");
  await until(() => f.requests.length === 1);
  await f.session.interrupt();
  assert.equal((await running).status, "interrupted");
  assert.equal(f.input().some((message) => message.id === 8), false);
  assert.equal(f.session.pendingRequests.length, 0);
  assert.equal(f.events.at(-1).type, "turn.interrupted");
});

test("unrelated child-thread messages cannot finish the root task", async (t) => {
  const f = fixture(t, `
    if(m.method==='turn/start'){
      reply(m,{turn:{id:'turn-1'}});
      send({method:'thread/started',params:{thread:{id:'child'}}});
      send({method:'turn/completed',params:{threadId:'child',turn:{id:'child-turn',status:'completed',items:[{id:'child-answer',type:'agentMessage',text:'Wrong answer'}]}}});
      setTimeout(()=>done('failed'),40);
    }
  `);
  assert.equal((await f.session.start("root")).status, "failed");
  assert.equal(f.session.threadId, "thread-1");
  assert.equal(f.events.some((event) => event.item?.text === "Wrong answer"), false);
  assert.equal(f.events.at(-1).type, "turn.failed");
});

test("early exit, malformed streams and startup timeout fail closed and clean up", async (t) => {
  for (const [name, body, options] of [
    ["exit", "if(m.method==='turn/start')process.exit(0);", {}],
    ["malformed", "if(m.method==='turn/start')process.stdout.write('not-json\\n');", {}],
    ["oversized", "if(m.method==='turn/start')process.stdout.write('x'.repeat(4097));", { maxLineBytes: 4096 }],
    ["timeout", "", { startupTimeoutMs: 100, requestTimeoutMs: 1000 }],
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t, body, options);
      await assert.rejects(f.session.start("fail safely"));
      assert.equal(f.events.some((event) => event.type === "turn.completed"), false);
      assert.throws(() => process.kill(f.session.child.pid, 0), { code: "ESRCH" });
    });
  }
});
