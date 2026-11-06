"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startServer } = require("../src/server");
const { localEnvironment, expandHome } = require("../src/local-workspace");

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-local-workspace-"));
  const home = path.join(directory, "home"), bin = path.join(home, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "bridge-fixture-tool"), "#!/bin/sh\nprintf local-tool-ok\n", { mode: 0o700 });
  fs.symlinkSync(process.execPath, path.join(bin, "bridge-fixture-node"));
  const env = { HOME: home, PATH: SYSTEM_PATH, SHAPES_CODEX_BINARY: path.join(directory, "missing-codex"),
    SHAPES_CLAUDE_BINARY: path.join(bin, "claude"), SHAPES_CODEX_JOB_DIR: path.join(directory, "jobs") };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  const server = await startServer({ port: 0, token: "fixture-secret" });
  const jobs = [];
  async function request(route, body, token = "fixture-secret") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? "GET" : "POST", headers: { "x-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() };
    if (result.status === 202) jobs.push(result.body.job_id);
    return result;
  }
  async function settled(id) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await request(`/agents/status?job_id=${id}&wait=0`);
      if (TERMINAL.has(result.body.state)) return result.body;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Fixture job did not settle.");
  }
  t.after(async () => {
    for (const id of jobs) {
      await request("/agents/cancel", { job_id: id });
      await settled(id);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, home, bin, request, settled };
}

test("local environment preserves caller order, variables, and non-macOS behavior", () => {
  const env = { PATH: "/custom/bin:/usr/bin:/custom/bin", HOME: "/custom/home", LANG: "en_US.UTF-8" };
  const result = localEnvironment({ env, platform: "darwin", home: env.HOME });
  assert.ok(result.PATH.startsWith("/custom/bin:/usr/bin:"));
  for (const directory of ["/custom/home/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]) {
    assert.ok(result.PATH.split(":").includes(directory));
  }
  assert.equal(result.LANG, env.LANG);
  assert.deepEqual(localEnvironment({ env, platform: "linux", home: env.HOME }), env);
  assert.equal(env.PATH, "/custom/bin:/usr/bin:/custom/bin");
  assert.equal(expandHome("~/notes/file.txt", "/home/person"), "/home/person/notes/file.txt");
  assert.equal(expandHome("~", "/home/person"), "/home/person");
  assert.equal(expandHome("~literal/file.txt", "/home/person"), "~literal/file.txt");
  assert.equal(expandHome("~\\Desktop\\file.txt", "C:\\Users\\fixture", "win32"), path.win32.join("C:\\Users\\fixture", "Desktop", "file.txt"));
  assert.equal(expandHome("~/Desktop/file.txt", "C:\\Users\\fixture", "win32"), path.win32.join("C:\\Users\\fixture", "Desktop", "file.txt"));
  assert.equal(expandHome("~\\Desktop\\file.txt", "/home/person", "darwin"), "~\\Desktop\\file.txt");
  assert.equal(expandHome("~literal\\file.txt", "C:\\Users\\fixture", "win32"), "~literal\\file.txt");
});

test("HTTP commands use installed local tools under the macOS app's minimal PATH", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  const result = await f.request("/run", { cmd: "bridge-fixture-tool", cwd: "~" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { exit_code: 0, stdout: "local-tool-ok", stderr: "", shell: "sh", output_truncated: false });
  assert.equal(process.env.PATH, SYSTEM_PATH, "requests must not mutate the daemon environment");
  const defaultDirectory = await f.request("/run", { cmd: "pwd" });
  assert.equal(defaultDirectory.body.stdout.trim(), fs.realpathSync(process.cwd()), "CLI launch directory is preserved");
});

test("file and shell primitives compose in a home workspace with spaces", async (t) => {
  const f = await fixture(t);
  const wrote = await f.request("/write", { path: "~/Project with spaces/notes.txt", content: "first\n" });
  assert.equal(wrote.status, 200);
  const appended = await f.request("/run", { cwd: "~/Project with spaces", cmd: "printf 'second\\n' >> notes.txt" });
  assert.equal(appended.body.exit_code, 0);
  const read = await f.request(`/read?path=${encodeURIComponent("~/Project with spaces/notes.txt")}`);
  assert.equal(read.body.content, "first\nsecond\n");
  const listed = await f.request(`/ls?path=${encodeURIComponent("~/Project with spaces")}`);
  assert.deepEqual(listed.body.entries.map((entry) => entry.name), ["notes.txt"]);
  assert.equal(fs.readFileSync(path.join(f.home, "Project with spaces/notes.txt"), "utf8"), read.body.content);
});

test("unauthorized commands and writes have no side effects; invalid paths explain failure", async (t) => {
  const f = await fixture(t), file = path.join(f.directory, "must-not-exist");
  assert.equal((await f.request("/run", { cmd: `touch ${quote(file)}` }, "wrong")).status, 401);
  assert.equal((await f.request("/write", { path: file, content: "no" }, "wrong")).status, 401);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await f.request("/run", { cmd: "pwd", cwd: path.join(f.directory, "missing") })).body.exit_code, -1);
  assert.match((await f.request("/run", { cmd: "pwd", cwd: file })).body.stderr, /cwd does not exist/);
  assert.equal((await f.request("/read")).status, 400);
  assert.match((await f.request(`/read?path=${encodeURIComponent(file)}`)).body.error, /ENOENT/);
  for (const body of [null, {}, { cmd: 1 }, { cmd: "pwd", cwd: [] }]) assert.equal((await f.request("/run", body)).status, 400);
  const failed = await f.request("/run", { cmd: "printf intentional-error >&2; exit 7", cwd: f.directory });
  assert.deepEqual(failed.body, { exit_code: 7, stdout: "", stderr: "intentional-error", shell: "sh", output_truncated: false });
});

test("command timeout stops descendants before reporting, without late file writes", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t), script = path.join(f.directory, "child.js"), late = path.join(f.directory, "late.txt");
  fs.writeFileSync(script, `require('fs').writeFileSync('child.pid',String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'late'),1400);`);
  const result = await f.request("/run", { cmd: `${quote(process.execPath)} ${quote(script)} & wait`, cwd: f.directory, timeout: 1 });
  assert.equal(result.body.exit_code, -1);
  assert.match(result.body.stderr, /timed out after 1s/);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(fs.existsSync(late), false);
  const pid = Number(fs.readFileSync(path.join(f.directory, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
  const completed = await f.request("/run", { cmd: `${quote(process.execPath)} -e 'console.log("child finished")' & wait`, cwd: f.directory });
  assert.equal(completed.body.exit_code, 0);
  assert.equal(completed.body.stdout, "child finished\n");
});

test("timeouts escalate for children that ignore termination and command output remains bounded", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t), script = path.join(f.directory, "stubborn.js"), late = path.join(f.directory, "late.txt");
  fs.writeFileSync(script, `process.on('SIGTERM',()=>{});require('fs').writeFileSync('child.pid',String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(late)},'late'),3000);setInterval(()=>{},1000);`);
  const before = Date.now();
  const result = await f.request("/run", { cmd: `${quote(process.execPath)} ${quote(script)} & wait`, cwd: f.directory, timeout: 1 });
  assert.equal(result.body.exit_code, -1);
  assert.match(result.body.stderr, /timed out after 1s/);
  assert.ok(Date.now() - before < 4000, "SIGKILL must bound a stuck child");
  const pid = Number(fs.readFileSync(path.join(f.directory, "child.pid"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
  assert.equal(fs.existsSync(late), false);
  const noisy = await f.request("/run", { cmd: `${quote(process.execPath)} -e 'process.stdout.write("x".repeat(5*1024*1024))'`, cwd: f.directory });
  assert.equal(noisy.body.exit_code, -1);
  assert.equal(noisy.body.stdout.length, 20000);
  assert.match(noisy.body.stderr, /exceeded the command output limit/);
});

test("detached descendants holding inherited pipes cannot extend the HTTP timeout", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t), script = path.join(f.directory, "detach.js"), pidFile = path.join(f.directory, "detached.pid");
  fs.writeFileSync(script, `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>console.log("detached fixture"),10000)'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();`);
  let deadline, detachedPid;
  try {
    const before = Date.now();
    const result = await Promise.race([
      f.request("/run", { cmd: `${quote(process.execPath)} ${quote(script)}`, cwd: f.directory, timeout: 1 }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("HTTP command exceeded its timeout grace")), 5000); }),
    ]);
    clearTimeout(deadline);
    assert.equal(result.body.exit_code, -1);
    assert.match(result.body.stderr, /timed out after 1s/);
    assert.ok(Date.now() - before < 4000, "receipt must not wait for an escaped descendant to close its pipes");
    detachedPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.doesNotThrow(() => process.kill(detachedPid, 0), "arbitrary detached daemons are outside process-group cancellation");
  } finally {
    clearTimeout(deadline);
    // This fixture deliberately escapes the command group. Its recorded PID is
    // test-owned; clean it explicitly without touching any other process.
    detachedPid ||= fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : undefined;
    if (detachedPid) {
      try { process.kill(detachedPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(detachedPid, 0); }
        catch (error) { if (error.code === "ESRCH") break; throw error; }
        assert.ok(attempt < 99, "owned detached fixture must exit during cleanup");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
});

test("native agent discovery, execution, retry, status and cancellation share the local environment", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.bin, "claude"), `#!/usr/bin/env bridge-fixture-node
if(process.argv.includes('--version')) { console.log('2.1.286 (Claude Code)'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('--print --output-format --verbose --permission-prompts --permission-mode --tools --strict-mcp-config --mcp-config --disallowedTools'); process.exit(0); }
if(process.argv.includes('auth')) { console.log('{"loggedIn":true}'); process.exit(0); }
let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{
 if(prompt==='wait') { setInterval(()=>{},1000); return; }
 const result=require('child_process').spawnSync('bridge-fixture-tool',{encoding:'utf8'});
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:result.stdout,permission_denials:[]}));
});
`, { mode: 0o700 });
  const discovered = await f.request("/agents");
  assert.equal(discovered.body.default_agent, "claude");
  const body = { prompt: "run fixture tool", cwd: "~", agent: "claude", request_key: "local-fixture-retry-01" };
  const started = await f.request("/agents/start", body);
  assert.equal(started.status, 202);
  const retry = await f.request("/agents/start", body);
  assert.equal(retry.body.job_id, started.body.job_id);
  assert.equal(retry.body.deduplicated, true);
  const finished = await f.settled(started.body.job_id);
  assert.equal(finished.state, "completed");
  assert.equal(finished.final, "local-tool-ok");
  const listed = await f.request("/agents/jobs?request_key=local-fixture-retry-01");
  assert.equal(listed.body.jobs[0].state, "completed");
  const running = await f.request("/agents/start", { prompt: "wait", cwd: "~", agent: "claude" });
  assert.equal(running.status, 202);
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await f.request(`/agents/status?job_id=${running.body.job_id}&wait=0`);
    if (status.body.state === "running") break;
    assert.ok(attempt < 99, "fixture agent must actually start before cancellation");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await f.request("/agents/cancel", { job_id: running.body.job_id })).body.cancel_requested, true);
  assert.equal((await f.settled(running.body.job_id)).state, "cancelled");
});
