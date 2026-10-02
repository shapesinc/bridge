"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../src/server");

const TOKEN = "native-codex-test-token";

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-native-codex-"));
  const executable = path.join(dir, "fake-codex");
  fs.writeFileSync(executable, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli 0.200.0'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('--json --sandbox --ephemeral'); process.exit(0); }
if(process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
  if(prompt==='wait') { setInterval(()=>{},1000); return; }
  if(prompt==='fail') { process.stderr.write('private diagnostic'); process.exit(2); }
  setTimeout(()=>{
    console.log(JSON.stringify({type:'thread.started',thread_id:'native-test-thread'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({prompt,args:process.argv.slice(2)})}}));
    console.log(JSON.stringify({type:'turn.completed'}));
  },500);
});`, { mode: 0o700 });
  const previous = { binary: process.env.SHAPES_CODEX_BINARY, root: process.env.SHAPES_CODEX_JOB_DIR };
  process.env.SHAPES_CODEX_BINARY = executable;
  process.env.SHAPES_CODEX_JOB_DIR = path.join(dir, "jobs");
  const server = await startServer({ port: 0, token: TOKEN });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    for (const [key, value] of Object.entries({ SHAPES_CODEX_BINARY: previous.binary, SHAPES_CODEX_JOB_DIR: previous.root })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(route, body, token = TOKEN) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { dir, request };
}

test("native Codex actions require authentication before starting or reading jobs", async (t) => {
  const f = await fixture(t);
  for (const [route, body] of [["/codex/start", { prompt: "hello" }], ["/codex/status?job_id=anything"], ["/codex/cancel", { job_id: "anything" }]]) {
    assert.equal((await f.request(route, body, "wrong")).status, 401);
  }
  assert.equal(fs.existsSync(path.join(f.dir, "jobs")), false);
  const capabilities = (await f.request("/capabilities")).body;
  for (const action of ["codex_start", "codex_status", "codex_cancel"]) assert.equal(typeof capabilities.actions[action], "string");
});

test("native start submits literal text and one status request waits for completion", async (t) => {
  const f = await fixture(t);
  const prompt = "Please say bye. $(touch NEVER) `whoami`\n";
  const started = await f.request("/codex/start", { prompt, cwd: f.dir });
  assert.equal(started.status, 202);
  assert.equal(started.body.state, "queued");
  assert.equal(started.body.sandbox, "read-only");
  const result = await f.request(`/codex/status?job_id=${started.body.job_id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "completed");
  assert.equal(result.body.thread_id, "native-test-thread");
  const final = JSON.parse(result.body.final);
  assert.equal(final.prompt, prompt);
  assert.equal(final.args[final.args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(fs.existsSync(path.join(f.dir, "NEVER")), false);
  for (const field of ["stdout_tail", "stderr_tail", "diagnostics_directory", "diagnostics_available"]) assert.equal(result.body[field], undefined);
});

test("native cancellation and failures retain actual terminal states", async (t) => {
  const f = await fixture(t);
  const started = await f.request("/codex/start", { prompt: "wait", cwd: f.dir });
  const cancelled = await f.request("/codex/cancel", { job_id: started.body.job_id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancel_requested, true);
  assert.equal((await f.request(`/codex/status?job_id=${started.body.job_id}`)).body.state, "cancelled");
  const failed = await f.request("/codex/start", { prompt: "fail", cwd: f.dir });
  const result = (await f.request(`/codex/status?job_id=${failed.body.job_id}`)).body;
  assert.equal(result.state, "failed");
  assert.equal(result.exit_code, 2);
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes("private diagnostic"));
});

test("native start validates input and status cannot traverse the jobs directory", async (t) => {
  const f = await fixture(t);
  for (const body of [null, [], { prompt: "" }, { prompt: "hi", workspace_write: "true" }, { prompt: "hi", model: "override" }, { prompt: "hi", cwd: "relative" }, { prompt: "x".repeat(65537) }, { prompt: "🦊".repeat(17000) }]) {
    assert.equal((await f.request("/codex/start", body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  for (const id of ["", "../request.json", "not-a-job"]) {
    assert.equal((await f.request(`/codex/status?job_id=${encodeURIComponent(id)}`)).status, 400);
    assert.equal((await f.request("/codex/cancel", { job_id: id })).status, 400);
  }
  assert.equal((await f.request("/codex/cancel", { job_id: "x", extra: true })).status, 400);
  assert.equal(fs.existsSync(path.join(f.dir, "jobs")), false);
});
