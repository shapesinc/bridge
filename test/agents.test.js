"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { listAgents, desktopClaudeCandidates } = require("../src/agents");
const { startJob, getStatus, cancelJob, MAX_OUTPUT } = require("../src/codex");
const { startServer } = require("../src/server");

const TOKEN = "test-agent-token";
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const CLAUDE_HELP = "--print --output-format --verbose --permission-prompts --permission-mode --tools --strict-mcp-config --mcp-config --disallowedTools";
const COMPLETE = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Done',session_id:'claude-session',permission_denials:[]}));`;

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-agents-test-"));
  const keys = ["SHAPES_CODEX_BINARY", "SHAPES_CLAUDE_BINARY", "SHAPES_CODEX_JOB_DIR"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const jobs = [];
  for (const agent of ["codex", "claude"]) {
    const config = options[agent] || {};
    const executable = path.join(dir, agent);
    process.env[agent === "codex" ? keys[0] : keys[1]] = executable;
    if (config.missing) continue;
    const auth = config.auth ?? true;
    const body = config.body ?? (agent === "claude" ? COMPLETE : `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Codex done'}}));console.log(JSON.stringify({type:'turn.completed'}));`);
    fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')) { console.log(${JSON.stringify(config.version || (agent === "codex" ? "codex-cli 0.200.0" : "2.1.286 (Claude Code)"))}); process.exit(0); }
if(process.argv.includes('--help')) { console.log(${JSON.stringify(config.help ?? (agent === "codex" ? "--json --sandbox --ephemeral" : CLAUDE_HELP))}); process.exit(0); }
if(process.argv.includes(${JSON.stringify(agent === "codex" ? "login" : "auth")})) {
  console.log(${JSON.stringify(config.authOutput ?? (agent === "codex" ? (auth ? "Logged in using ChatGPT (private@example.invalid)" : "Not logged in") : JSON.stringify({ loggedIn: auth, email: "private@example.invalid", apiKey: "private-api-key" })))});
  process.exit(${config.authCode ?? (auth ? 0 : 1)});
}
fs.appendFileSync(${JSON.stringify(path.join(dir, `${agent}-runs`))}, 'run\\n');
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{${body}});
`, { mode: 0o700 });
  }
  process.env.SHAPES_CODEX_JOB_DIR = path.join(dir, "jobs");
  t.after(async () => {
    for (const id of jobs) { try { if (!TERMINAL.has(getStatus(id).state)) { cancelJob(id); await done(id); } } catch {} }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function start(options = {}) {
    const job = await startJob({ agent: "claude", prompt: "hello", cwd: dir, ...options });
    jobs.push(job.job_id);
    return job;
  }
  return { dir, start, jobs };
}

async function done(id) {
  for (let i = 0; i < 160; i++) {
    const result = getStatus(id);
    if (TERMINAL.has(result.state)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  cancelJob(id);
  throw new Error("Agent fixture did not stop");
}

async function serverFixture(t, options) {
  const f = fixture(t, options);
  const server = await startServer({ port: 0, token: TOKEN });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  async function request(route, body, token = TOKEN) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() };
    if (result.status === 202) f.jobs.push(result.body.job_id);
    return result;
  }
  return { ...f, request };
}

test("discovery checks prerequisites without inference or exposing authentication metadata", async (t) => {
  const f = fixture(t);
  const result = await listAgents(f.dir);
  assert.equal(result.default_agent, "codex");
  assert.deepEqual(result.agents.map(({ id, installed, authenticated, available, status }) => ({ id, installed, authenticated, available, status })),
    ["codex", "claude"].map((id) => ({ id, installed: true, authenticated: true, available: true, status: "ready" })));
  const encoded = JSON.stringify(result);
  for (const secret of ["private@example.invalid", "private-api-key", f.dir, "executable"]) assert.ok(!encoded.includes(secret));
  assert.equal(fs.existsSync(path.join(f.dir, "codex-runs")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "claude-runs")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "jobs")), false);
});

test("missing, signed-out, unsupported, and failed probes are distinct and never create a job", async (t) => {
  for (const [name, config, status] of [
    ["missing", { missing: true }, "not_installed"],
    ["signed out", { auth: false }, "auth_required"],
    ["old CLI", { help: "--print --output-format" }, "unsupported"],
    ["failed auth", { authCode: 2 }, "check_failed"],
    ["malformed auth", { authOutput: "private malformed output" }, "check_failed"],
  ]) await t.test(name, async (t) => {
    const f = fixture(t, { codex: { missing: true }, claude: config });
    const result = await listAgents(f.dir);
    assert.equal(result.default_agent, null);
    assert.equal(result.agents[1].status, status);
    await assert.rejects(f.start(), (error) => error.errorType === "agent_unavailable" && error.agents[0].status === status);
    assert.equal(fs.existsSync(path.join(f.dir, "jobs")), false);
  });
});

test("Codex negative auth wording never qualifies as a ready login", async (t) => {
  const f = fixture(t, { codex: { auth: false, authCode: 0 }, claude: { missing: true } });
  const result = await listAgents(f.dir);
  assert.equal(result.agents[0].authenticated, false);
  assert.equal(result.default_agent, null);
});

test("a stalled readiness probe is bounded and never creates a job", async (t) => {
  const f = fixture(t, { codex: { missing: true } });
  fs.writeFileSync(process.env.SHAPES_CLAUDE_BINARY, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const before = Date.now();
  const result = await listAgents(f.dir);
  assert.equal(result.agents[1].status, "check_failed");
  assert.ok(Date.now() - before < 7500);
  assert.equal(fs.existsSync(path.join(f.dir, "jobs")), false);
});

test("Claude Desktop discovery is bounded to version directories and chooses newest first", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-claude-discovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const version of ["2.1.9", "2.1.286", "2.1.285", "2.1.284", "credentials"]) {
    fs.mkdirSync(path.join(dir, "Library/Application Support/Claude/claude-code", version, "abc123"), { recursive: true });
  }
  const found = desktopClaudeCandidates(dir);
  assert.equal(found.length, 3);
  assert.ok(found[0].includes("2.1.286/abc123/claude.app/Contents/MacOS/claude"));
  assert.ok(found.every((file) => !file.includes("credentials") && !file.includes("2.1.9/")));
});

test("auto selects a ready agent before starting and never retries another agent after failure", async (t) => {
  await t.test("Codex signed out chooses Claude", async (t) => {
    const f = fixture(t, { codex: { auth: false } });
    const job = await f.start({ agent: "auto" });
    assert.equal(job.agent, "claude");
    assert.equal((await done(job.job_id)).state, "completed");
    assert.equal(fs.existsSync(path.join(f.dir, "codex-runs")), false);
  });
  await t.test("started Codex fails without Claude fallback", async (t) => {
    const f = fixture(t, { codex: { body: "process.exit(2);" } });
    const job = await f.start({ agent: "auto" });
    assert.equal(job.agent, "codex");
    assert.equal((await done(job.job_id)).state, "failed");
    assert.equal(fs.existsSync(path.join(f.dir, "claude-runs")), false);
    assert.equal(fs.readFileSync(path.join(f.dir, "codex-runs"), "utf8"), "run\n");
  });
});

test("Claude receives literal stdin and restricted read-only tools without credential or rule overrides", async (t) => {
  const f = fixture(t, { claude: { body: `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'claude-session',apiKey:'private-startup-secret'}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({prompt,args:process.argv.slice(2)}),permission_denials:[]}));` } });
  const prompt = "Please help. $(touch NEVER) `whoami`\n";
  const job = await f.start({ prompt });
  assert.equal(job.permission_scope, "read-only-tools");
  const result = await done(job.job_id);
  assert.equal(result.state, "completed");
  assert.equal(result.thread_id, "claude-session");
  const final = JSON.parse(result.final);
  assert.equal(final.prompt, prompt);
  assert.deepEqual(final.args, ["--print", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "mcp__*"]);
  assert.equal(fs.existsSync(path.join(f.dir, "NEVER")), false);
  assert.ok(!JSON.stringify(result).includes("private-startup-secret"));
  const jobDir = path.join(f.dir, "jobs", job.job_id);
  assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(jobDir)) assert.equal(fs.statSync(path.join(jobDir, file)).mode & 0o777, 0o600);
});

test("Claude write mode requires a Git worktree and enables per-run edits without overriding rules", async (t) => {
  const f = fixture(t, { claude: { body: `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify(process.argv.slice(2))}));` } });
  const git = (...args) => execFileSync("git", ["-C", f.dir, ...args], { stdio: "pipe" });
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  await assert.rejects(f.start({ sandbox: "workspace-write" }), /dedicated Git worktree/);
  const worktree = path.join(f.dir, "worktree");
  git("worktree", "add", "--detach", worktree);
  const settings = path.join(worktree, ".claude", "settings.json");
  const rules = JSON.stringify({ permissions: { defaultMode: "plan", deny: ["Read(.env)"], ask: ["Bash(git push *)"] } });
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, rules);
  const result = await done((await f.start({ sandbox: "workspace-write", cwd: worktree })).job_id);
  assert.equal(result.state, "completed");
  assert.equal(result.permission_scope, "accept-edits");
  assert.deepEqual(JSON.parse(result.final), ["--print", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--permission-mode", "acceptEdits"]);
  assert.equal(fs.readFileSync(settings, "utf8"), rules);
});

test("Claude requires an explicit successful result, exit zero, and no permission denial", async (t) => {
  for (const [name, body, errorType] of [
    ["assistant text only", `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Done'}]}}));`, "missing_completion"],
    ["tool events only", `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'private'}}]}}));`, "missing_completion"],
    ["empty result", `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:''}));`, "agent_error"],
    ["error flag", `console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'private error'}));`, "agent_error"],
    ["error subtype", `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:false,result:'private error'}));`, "agent_error"],
    ["nonzero exit", `${COMPLETE}process.exitCode=2;`, "process_error"],
    ["permission array", `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'private partial output',permission_denials:[{tool_name:'Bash',tool_input:{command:'private command'}}]}));`, "permission_denied"],
    ["permission event", `console.log(JSON.stringify({type:'system',subtype:'permission_denied',tool_name:'Bash'}));${COMPLETE}`, "permission_denied"],
    ["late permission event", `${COMPLETE}console.log(JSON.stringify({type:'system',subtype:'permission_denied',tool_name:'Bash'}));`, "permission_denied"],
  ]) await t.test(name, async (t) => {
    const f = fixture(t, { claude: { body } });
    const result = await done((await f.start()).job_id);
    assert.equal(result.state, "failed");
    assert.equal(result.error_type, errorType);
    if (errorType === "permission_denied") assert.equal(result.permission_denials, 1);
    assert.ok(!JSON.stringify(result).includes("private error"));
    assert.ok(!JSON.stringify(result).includes("private command"));
    assert.ok(!JSON.stringify(result).includes("private partial output"));
  });
});

test("Claude cancellation and timeout kill a process that ignores SIGTERM", async (t) => {
  for (const operation of ["cancel", "timeout"]) await t.test(operation, async (t) => {
    const f = fixture(t, { claude: { body: "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" } });
    const job = await f.start({ timeoutSeconds: operation === "timeout" ? 1 : 30 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (operation === "cancel") assert.equal(cancelJob(job.job_id).cancel_requested, true);
    assert.equal((await done(job.job_id)).state, operation === "timeout" ? "timed_out" : "cancelled");
  });
});

test("Claude output is bounded, raw errors remain private, and split UTF-8 is preserved", async (t) => {
  await t.test("large escaped output", async (t) => {
    const f = fixture(t, { claude: { body: `process.stderr.write('private diagnostic'.repeat(10000));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'\\u0000'.repeat(100000)}));` } });
    const job = await f.start();
    const result = await done(job.job_id);
    assert.equal(result.state, "completed");
    assert.equal(result.output_truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 12000);
    assert.ok(!JSON.stringify(result).includes("private diagnostic"));
    for (const file of ["stdout.log", "stderr.log", "result.txt"]) assert.ok(fs.statSync(path.join(f.dir, "jobs", job.job_id, file)).size <= MAX_OUTPUT);
  });
  await t.test("UTF-8", async (t) => {
    const f = fixture(t, { claude: { body: `const line=Buffer.from(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'café'}));const split=line.indexOf(Buffer.from('é'))+1;process.stdout.write(line.subarray(0,split));setTimeout(()=>process.stdout.write(line.subarray(split)),30);` } });
    assert.equal((await done((await f.start()).job_id)).final, "café");
  });
});

test("native agent endpoints require auth and return safe unavailable receipts before execution", async (t) => {
  const f = await serverFixture(t, { codex: { missing: true }, claude: { auth: false } });
  for (const [route, body] of [["/agents"], ["/agents/start", { prompt: "hello" }], ["/agents/status?job_id=x"], ["/agents/cancel", { job_id: "x" }]]) {
    assert.equal((await f.request(route, body, "wrong")).status, 401);
  }
  const discovery = await f.request("/agents");
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.agents[1].status, "auth_required");
  const result = await f.request("/agents/start", { prompt: "hello", cwd: f.dir, agent: "claude" });
  assert.equal(result.status, 409);
  assert.equal(result.body.error_type, "agent_unavailable");
  assert.equal(result.body.started, false);
  assert.equal(result.body.agents[0].status, "auth_required");
  assert.equal(result.body.job_id, undefined);
  for (const secret of ["private@example.invalid", "private-api-key", f.dir]) assert.ok(!JSON.stringify(result.body).includes(secret));
  assert.equal(fs.existsSync(path.join(f.dir, "jobs")), false);
});

test("native routes preserve agent identity and Codex-only compatibility", async (t) => {
  const f = await serverFixture(t);
  const capabilities = (await f.request("/capabilities")).body.actions;
  for (const name of ["agents", "agent_start", "agent_status", "agent_cancel"]) assert.equal(typeof capabilities[name], "string");
  for (const body of [{ prompt: "hello", agent: "other" }, { prompt: "hello", agent: null }, { prompt: "hello", skip_permissions: true }]) assert.equal((await f.request("/agents/start", body)).status, 400);
  const auto = await f.request("/agents/start", { prompt: "hello", cwd: f.dir });
  assert.equal(auto.status, 202);
  assert.equal(auto.body.agent, "codex");
  assert.equal((await f.request(`/codex/status?job_id=${auto.body.job_id}`)).body.state, "completed");
  const job = await f.request("/agents/start", { prompt: "hello", cwd: f.dir, agent: "claude" });
  assert.equal(job.status, 202);
  assert.equal(job.body.agent, "claude");
  const result = (await f.request(`/agents/status?job_id=${job.body.job_id}`)).body;
  assert.equal(result.state, "completed");
  assert.equal(result.agent, "claude");
  assert.equal(result.final, "Done");
  for (const key of ["diagnostics_directory", "diagnostics_available", "stdout_tail", "stderr_tail"]) assert.equal(result[key], undefined);
  assert.equal((await f.request(`/codex/status?job_id=${job.body.job_id}`)).status, 400);
  assert.equal((await f.request("/codex/cancel", { job_id: job.body.job_id })).status, 400);
  assert.equal((await f.request("/agents/cancel", { job_id: job.body.job_id })).body.cancel_requested, false);
  assert.equal((await f.request("/codex/start", { prompt: "hello", cwd: f.dir, agent: "claude" })).status, 400);
});

test("native Claude cancellation reports the selected agent and then a stopped job", async (t) => {
  const f = await serverFixture(t, { claude: { body: "setInterval(()=>{},1000);" } });
  const job = await f.request("/agents/start", { agent: "claude", prompt: "hello", cwd: f.dir });
  const result = await f.request("/agents/cancel", { job_id: job.body.job_id });
  assert.equal(result.status, 200);
  assert.equal(result.body.agent, "claude");
  assert.equal(result.body.cancel_requested, true);
  assert.equal((await f.request(`/agents/status?job_id=${job.body.job_id}`)).body.state, "cancelled");
});
