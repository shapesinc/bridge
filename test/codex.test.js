"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");
const { validateCwd, MAX_OUTPUT } = require("../src/codex");
const CLI = path.resolve(__dirname, "../bin/codex.js");
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

function fixture(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-codex-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "fake-codex");
  fs.writeFileSync(executable, `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('codex-cli test'); process.exit(0); }\nif(process.argv.includes('--help')) { console.log('--json --sandbox --ephemeral'); process.exit(0); }\n${body}`, { mode: 0o700 });
  const prompt = path.join(dir, "prompt.txt");
  fs.writeFileSync(prompt, "Please say hello. $(touch NEVER) `whoami`\n");
  const env = { ...process.env, SHAPES_CODEX_BINARY: executable, SHAPES_CODEX_JOB_DIR: path.join(dir, "jobs") };
  function command(...args) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { dir, prompt, env, command, start: (...args) => command("start", "--cwd", dir, "--prompt-file", prompt, ...args) };
}

async function untilDone(f, id) {
  for (let i = 0; i < 100; i++) {
    const status = f.command("status", id);
    if (TERMINAL.has(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  f.command("cancel", id);
  throw new Error("Job did not finish in time");
}

const COMPLETE = `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`;

test("async CLI passes prompt literally, preserves config, and reports successful turns", async (t) => {
  const f = fixture(t, `let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({prompt,args:process.argv.slice(2)})}}));
    ${COMPLETE}
  });`);
  const start = f.start();
  assert.equal(start.state, "queued");
  const status = await untilDone(f, start.job_id);
  assert.equal(status.state, "completed");
  assert.equal(status.thread_id, "test-thread");
  const result = JSON.parse(status.final);
  assert.equal(result.prompt, fs.readFileSync(f.prompt, "utf8"));
  assert.deepEqual(result.args.slice(0, 8), ["-a", "never", "exec", "--json", "--color", "never", "--sandbox", "read-only"]);
  assert.ok(!result.args.some((arg) => /bypass|ignore|model/.test(arg)));
  assert.ok(result.args.includes("sandbox_workspace_write.writable_roots=[]"));
  assert.equal(result.args.at(-1), "-");
  assert.equal(fs.existsSync(path.join(f.dir, "NEVER")), false);
  const jobDir = path.join(f.env.SHAPES_CODEX_JOB_DIR, start.job_id);
  assert.equal(fs.statSync(jobDir).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(jobDir)) assert.equal(fs.statSync(path.join(jobDir, name)).mode & 0o777, 0o600);
});

test("nonzero exit and zero exit without turn completion are failures", async (t) => {
  for (const [name, body] of [["nonzero", "process.stderr.write('no auth');process.exit(2)"], ["no completion", "console.log('{}')"], ["failed turn", `console.log(JSON.stringify({type:'turn.failed'}));${COMPLETE}`]]) {
    await t.test(name, async (t) => {
      const f = fixture(t, body);
      const result = await untilDone(f, f.start().job_id);
      assert.equal(result.state, "failed");
      assert.ok(result.error);
    });
  }
});

test("cancel and timeout stop jobs even when Codex ignores SIGTERM", async (t) => {
  for (const operation of ["cancel", "timeout"]) {
    await t.test(operation, async (t) => {
      const f = fixture(t, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
      const started = f.start("--timeout-seconds", operation === "timeout" ? "1" : "30");
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (operation === "cancel") assert.equal(f.command("cancel", started.job_id).cancel_requested, true);
      const result = await untilDone(f, started.job_id);
      assert.equal(result.state, operation === "timeout" ? "timed_out" : "cancelled");
    });
  }
});

test("output and local log files are bounded", async (t) => {
  const f = fixture(t, `process.stdout.write('x'.repeat(200000)+'\\n');process.stderr.write('y'.repeat(200000));${COMPLETE}`);
  const id = f.start().job_id;
  const result = await untilDone(f, id);
  assert.equal(result.state, "completed");
  assert.equal(result.output_truncated, true);
  assert.equal(result.stdout_tail, undefined);
  assert.equal(result.stderr_tail, undefined);
  assert.equal(result.diagnostics_available, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
  for (const name of ["stdout.log", "stderr.log"]) assert.ok(fs.statSync(path.join(f.env.SHAPES_CODEX_JOB_DIR, id, name)).size <= MAX_OUTPUT);
});

test("status remains valid bounded JSON when final text requires escaping", async (t) => {
  const f = fixture(t, `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'\\0'.repeat(20000)}}));${COMPLETE}`);
  const result = await untilDone(f, f.start().job_id);
  assert.equal(result.state, "completed");
  assert.equal(result.output_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16000);
});

test("split UTF-8 characters survive streamed JSON events", async (t) => {
  const f = fixture(t, `const msg=Buffer.from(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'café'}})+'\\n');
    const split=msg.indexOf(Buffer.from('é'))+1;process.stdout.write(msg.subarray(0,split));setTimeout(()=>{process.stdout.write(msg.subarray(split));${COMPLETE}},50);`);
  const result = await untilDone(f, f.start().job_id);
  assert.equal(result.state, "completed");
  assert.equal(result.final, "café");
});

test("duplicate supervisors cannot repeat a job", async (t) => {
  const f = fixture(t, `require('node:fs').appendFileSync('runs.txt','run\\n');${COMPLETE}`);
  const id = f.start().job_id;
  assert.equal((await untilDone(f, id)).state, "completed");
  const retry = spawnSync(process.execPath, [CLI, "_supervise", id], { env: f.env, encoding: "utf8" });
  assert.equal(retry.status, 0);
  assert.equal(fs.readFileSync(path.join(f.dir, "runs.txt"), "utf8"), "run\n");
});

test("old Codex binaries are rejected before job creation", (t) => {
  const f = fixture(t, "");
  fs.writeFileSync(f.env.SHAPES_CODEX_BINARY, `#!${process.execPath}\nconsole.log(process.argv.includes('--version') ? 'codex-cli 0.34.0' : '--json --sandbox');`);
  const result = spawnSync(process.execPath, [CLI, "start", "--cwd", f.dir, "--prompt-file", f.prompt], { env: f.env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr).error, /older CLIs are unsupported/);
});

test("write mode rejects a primary checkout including subdirectories and symlinks", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-codex-git-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  fs.mkdirSync(path.join(repo, "subdir"));
  fs.symlinkSync(repo, path.join(dir, "alias"));
  for (const target of [repo, path.join(repo, "subdir"), path.join(dir, "alias")]) {
    assert.throws(() => validateCwd(target, "workspace-write"), /dedicated Git worktree/);
    assert.equal(validateCwd(target, "read-only"), fs.realpathSync(target));
  }
  const worktree = path.join(dir, "worktree");
  git("worktree", "add", "--detach", worktree);
  assert.equal(validateCwd(worktree, "workspace-write"), fs.realpathSync(worktree));
  assert.equal(validateCwd(dir, "workspace-write"), fs.realpathSync(dir));
});

test("invalid job IDs and unsafe inputs fail without starting Codex", (t) => {
  const f = fixture(t, "throw new Error('should not run')");
  for (const args of [["status", "../../auth"], ["start", "--cwd", ".", "--prompt-file", f.prompt], ["start", "--cwd", f.dir, "--prompt-file", f.prompt, "--timeout-seconds", "0"]]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: f.env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stderr).error);
  }
});
