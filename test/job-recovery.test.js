"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../src/server");
const { failureReason } = require("../src/codex");

const TOKEN = "job-recovery-test-token";
const KEY = "retry-key-0123456789abcdef";

async function fixture(t, script = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-job-recovery-"));
  const executable = path.join(dir, "fake-codex");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('fs');
if(process.argv.includes('--version')) { console.log('codex-cli 0.200.0'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('--json --sandbox --ephemeral'); process.exit(0); }
if(process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
  fs.appendFileSync(${JSON.stringify(path.join(dir, "runs"))}, prompt + '\\n');
  ${script}
  if(prompt==='wait') { setInterval(()=>{},1000); return; }
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
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
  async function request(route, body) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-token": TOKEN, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const runs = () => fs.existsSync(path.join(dir, "runs")) ? fs.readFileSync(path.join(dir, "runs"), "utf8").trim().split("\n") : [];
  return { dir, request, runs };
}

test("a retried start with the same request_key returns the queued job instead of running it twice", async (t) => {
  const f = await fixture(t);
  const body = { prompt: "wait", cwd: f.dir, request_key: KEY };
  const [first, second] = await Promise.all([f.request("/agents/start", body), f.request("/agents/start", body)]);
  const ids = new Set([first.body.job_id, second.body.job_id]);
  assert.equal(ids.size, 1);
  assert.deepEqual([first.status, second.status].sort(), [200, 202]);
  const retry = await f.request("/agents/start", body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduplicated, true);
  assert.equal(retry.body.job_id, first.body.job_id);
  assert.ok(["queued", "running"].includes(retry.body.state));
  assert.equal(retry.body.diagnostics_directory, undefined);
  const listed = await f.request(`/agents/jobs?request_key=${KEY}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.jobs.map((job) => job.job_id), [first.body.job_id]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(f.runs(), ["wait"]);
  await f.request("/agents/cancel", { job_id: first.body.job_id });
  assert.equal((await f.request(`/agents/status?job_id=${first.body.job_id}`)).body.state, "cancelled");
  const afterCancel = await f.request("/agents/start", body);
  assert.equal(afterCancel.body.job_id, first.body.job_id);
  assert.equal(afterCancel.body.state, "cancelled");
  assert.deepEqual(f.runs(), ["wait"]);
});

test("a request_key cannot be reused for a different task and must be well formed", async (t) => {
  const f = await fixture(t);
  const started = await f.request("/codex/start", { prompt: "first", cwd: f.dir, request_key: KEY });
  assert.equal(started.status, 202);
  const other = await f.request("/codex/start", { prompt: "second", cwd: f.dir, request_key: KEY });
  assert.equal(other.status, 409);
  assert.match(other.body.error, /different task/);
  for (const request_key of ["short", "x".repeat(129), "has spaces in it!!", 12345]) {
    assert.equal((await f.request("/codex/start", { prompt: "hi", cwd: f.dir, request_key })).status, 400);
  }
  assert.equal((await f.request("/codex/jobs?request_key=bad")).status, 400);
  assert.equal((await f.request("/codex/jobs?limit=0")).status, 400);
  assert.equal((await f.request("/codex/jobs?other=1")).status, 400);
});

test("recent jobs are listed newest first without private diagnostics", async (t) => {
  const f = await fixture(t);
  const first = await f.request("/agents/start", { prompt: "first   task\nwith detail", cwd: f.dir });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await f.request("/codex/start", { prompt: "wait", cwd: f.dir });
  const listed = await f.request("/agents/jobs");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.jobs.map((job) => job.job_id), [second.body.job_id, first.body.job_id]);
  const [newest, older] = listed.body.jobs;
  assert.equal(newest.agent, "codex");
  assert.equal(older.task_preview, "first task with detail");
  assert.equal(typeof newest.created_at, "string");
  for (const field of ["diagnostics_directory", "final", "stdout_tail", "stderr_tail"]) assert.equal(newest[field], undefined);
  assert.deepEqual((await f.request("/agents/jobs?limit=1")).body.jobs.map((job) => job.job_id), [second.body.job_id]);
  assert.deepEqual((await f.request(`/codex/jobs?request_key=${KEY}`)).body.jobs, []);
  const capabilities = (await f.request("/capabilities")).body;
  assert.equal(typeof capabilities.actions.agent_jobs, "string");
  assert.equal(capabilities.features.idempotent_start, true);
  assert.equal(capabilities.features.job_list, true);
  await f.request("/codex/cancel", { job_id: second.body.job_id });
});

test("the first failure explains the agent's reported reason with an action", async (t) => {
  const f = await fixture(t, `if(prompt==='limit') { console.log(JSON.stringify({type:'error',message:"You've hit your usage limit. Try again later."}));
    console.log(JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again later."}})); process.exit(1); }
  if(prompt==='crash') { process.stderr.write('private stack trace'); process.exit(3); }`);
  const limited = await f.request("/codex/start", { prompt: "limit", cwd: f.dir });
  const limit = (await f.request(`/codex/status?job_id=${limited.body.job_id}`)).body;
  assert.equal(limit.state, "failed");
  assert.match(limit.error, /usage limit/);
  assert.match(limit.error, /Wait for it to reset/);
  assert.doesNotMatch(limit.error, /diagnostics/);
  const crashed = await f.request("/codex/start", { prompt: "crash", cwd: f.dir });
  const crash = (await f.request(`/codex/status?job_id=${crashed.body.job_id}`)).body;
  assert.equal(crash.state, "failed");
  assert.match(crash.error, /exited with code 3/);
  assert.match(crash.error, /signed in and up to date/);
  assert.ok(!JSON.stringify(crash).includes("private stack trace"));
});

test("failure reasons classify common causes and never quote credentials or Claude prose", () => {
  const auth = failureReason({ agent: "codex", agentError: "401 Unauthorized: token sk-abcdefghijklmnop expired" });
  assert.match(auth.error, /Sign in to Codex/);
  assert.ok(!auth.error.includes("sk-abcdefghijklmnop"));
  assert.match(failureReason({ agent: "codex", agentError: "stream disconnected before completion" }).error, /internet connection/);
  assert.match(failureReason({ agent: "codex", agentError: "The model 'gpt-x' does not exist" }).error, /supported model/);
  const claude = failureReason({ agent: "claude", agentError: "private prose about rate limit" });
  assert.match(claude.error, /usage or rate limit/);
  assert.ok(!claude.error.includes("private prose"));
  assert.equal(failureReason({ agent: "claude", agentError: "private error", errorType: "agent_error" }).errorType, "agent_error");
  assert.match(failureReason({ agent: "codex", signal: "SIGKILL" }).error, /SIGKILL/);
  // Redaction must neither hide the cause from the hints nor garble ordinary words.
  assert.match(failureReason({ agent: "codex", agentError: "Your access token has expired" }).error, /Sign in to Codex/);
  assert.match(failureReason({ agent: "codex", agentError: "Input exceeds 200000 tokens" }).error, /200000 tokens/);
  assert.match(failureReason({ agent: "codex", agentError: "Your refresh token has expired" }).error, /refresh token has expired/);
  const local = failureReason({ agent: "codex", agentError: "Bad config at /Users/dana/.codex/config.toml for dana@example.com, api_key: abc123" }).error;
  assert.ok(!/dana|abc123/.test(local), local);
  assert.doesNotMatch(failureReason({ agent: "codex", agentError: "network access is disabled in this sandbox" }).error, /internet connection/);
  assert.match(failureReason({ agent: "codex", agentError: "Network request failed" }).error, /internet connection/);
  for (const secret of ["OPENAI_API_KEY=abc123 is invalid", "PGPASSWORD=hunter2 rejected", '{"password": "hunter2"}']) {
    assert.ok(!/abc123|hunter2/.test(failureReason({ agent: "codex", agentError: secret }).error), secret);
  }
  for (const prose of ["Install @openai/codex@0.45.0 to continue", "Basic plan does not include this model"]) {
    assert.ok(failureReason({ agent: "codex", agentError: prose }).error.includes(prose), prose);
  }
});
