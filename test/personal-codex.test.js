"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { personalConfiguration, createAccountClient, inspectBundledPersonal, createPersonalLoginManager, validLoginURL, openBrowser } = require("../src/personal-codex");
const { publicAgent, inspectAgent } = require("../src/agents");
const { createEmbeddedController } = require("../src/embedded");
const tick = () => new Promise(resolve => setImmediate(resolve));

function fakeClient({ account = { type: "chatgpt", email: "private@example.invalid" }, login = { type: "chatgpt", loginId: "owned-login", authUrl: "https://auth.openai.com/authorize?state=private" } } = {}) {
  const calls = []; let closed = 0, created;
  return { calls, get closed() { return closed; }, get created() { return created; },
    createClient(options) { created = options; return { ready: Promise.resolve(),
      request: async (method, params) => { calls.push([method, params]); return method === "account/read" ? { account } : login; },
      close: async () => { closed++; } }; } };
}

test("bundled personal discovery reads vendor status, sanitizes account metadata and closes without a turn", async () => {
  for (const [account, status] of [[{ type: "chatgpt", email: "secret" }, "ready"], [null, "auth_required"], [{ type: "apiKey" }, "auth_required"]]) {
    const fixture = fakeClient({ account });
    const selected = await inspectBundledPersonal({ runtime: { available: true, executable: "/private/bundled", version: "0.166.0" },
      profile: "/private/profile", createClient: fixture.createClient });
    assert.equal(selected.status, status); assert.equal(selected.transport, "bundled_personal");
    assert.equal(selected.profile, "/private/profile"); assert.equal(fixture.closed, 1);
    assert.deepEqual(fixture.calls, [["account/read", { refreshToken: false }]]);
    for (const secret of ["secret", "profile", "transport", "/private"]) assert.ok(!JSON.stringify(publicAgent(selected)).includes(secret));
  }
});

test("personal environment keeps vendor profile separate from credits and inherited provider keys", () => {
  const keys = ["OPENAI_API_KEY", "SHAPES_RUNTIME_TOKEN", "ANTHROPIC_API_KEY"], old = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "never-forward";
    const config = personalConfiguration("/private/personal-codex");
    assert.equal(config.environment.CODEX_HOME, "/private/personal-codex");
    for (const key of keys) assert.equal(config.environment[key], undefined);
    assert.equal(config.modelProvider, "openai"); assert.ok(!config.launchArgs.includes("app-server"));
    assert.throws(() => personalConfiguration("relative"));
  } finally { keys.forEach((key, i) => old[i] === undefined ? delete process.env[key] : process.env[key] = old[i]); }
});

test("browser login and cancel operate only the owned login, never logout or task APIs", async () => {
  const fixture = fakeClient(); const urls = [];
  const manager = createPersonalLoginManager({ createClient: fixture.createClient, open: async url => urls.push(url) });
  assert.deepEqual(await manager.start({ executable: "/bundled", profile: "/personal" }), { opened: true, cancellable: true });
  assert.equal(urls.length, 1); assert.deepEqual(manager.status(), { pending: true });
  assert.deepEqual(await manager.start({ executable: "/bundled", profile: "/personal" }), { opened: true, cancellable: true });
  assert.equal(urls.length, 1);
  assert.deepEqual(await manager.cancel(), { cancelled: true }); assert.equal(fixture.closed, 1);
  assert.deepEqual(await manager.cancel(), { cancelled: false });
  assert.deepEqual(fixture.calls, [["account/login/start", { type: "chatgpt" }], ["account/login/cancel", { loginId: "owned-login" }]]);
});

test("account revocation before browser handoff cancels the owned vendor operation", async () => {
  const fixture = fakeClient(); let checks = 0, opens = 0;
  const manager = createPersonalLoginManager({ createClient: fixture.createClient, open: async () => { opens++; } });
  await assert.rejects(manager.start({ executable: "/bundled" }, () => { if (++checks === 3) throw new Error("revoked"); }));
  assert.equal(opens, 0); assert.equal(fixture.closed, 1);
  assert.equal(fixture.calls.at(-1)[0], "account/login/cancel");
  assert.deepEqual(manager.status(), { pending: false });
});

test("concurrent starts share one receipt; cancellation before startup opens no browser", async () => {
  const fixture = fakeClient(); let opens = 0;
  const manager = createPersonalLoginManager({ createClient: fixture.createClient, open: async () => { opens++; } });
  const first = manager.start({ executable: "/bundled" });
  assert.equal(manager.start({ executable: "/bundled" }), first);
  await manager.cancel();
  await assert.rejects(first, /cancelled/);
  assert.equal(opens, 0); assert.equal(fixture.calls.length, 0);
});

test("cancel during browser opening cannot return a live pending-login receipt", async () => {
  const fixture = fakeClient(); let finishOpen;
  const manager = createPersonalLoginManager({ createClient: fixture.createClient, open: () => new Promise(resolve => { finishOpen = resolve; }) });
  const opening = manager.start({ executable: "/bundled" });
  await tick(); assert.equal(typeof finishOpen, "function");
  assert.deepEqual(await manager.cancel(), { cancelled: true });
  finishOpen(); await assert.rejects(opening, /cancelled/);
  assert.equal(manager.status().pending, false);
});

test("delayed discovery cannot start login after detach or an account ABA transition", async t => {
  for (const transition of ["detach", "account_aba"]) await t.test(transition, async () => {
    let release, starts = 0;
    const controller = createEmbeddedController({ read: () => null, remove: () => {},
      runtime: { running: () => false, pid: () => null, stop: async () => {} },
      inspectPersonalAgent: () => new Promise(resolve => { release = () => resolve({ id: "codex", status: "auth_required", executable: "/bundled", transport: "bundled_personal" }); }),
      personalLogin: { start: async () => { starts++; return { opened: true, cancellable: true }; }, cancel: async () => ({ cancelled: false }) },
    });
    await controller.updateAccount({ userId: "owner", deviceIds: [], verified: true });
    const opening = controller.openAgentLogin({ expectedUserId: "owner", agent: "codex" });
    if (transition === "detach") await controller.detach();
    else {
      await controller.updateAccount({ userId: "other", deviceIds: [], verified: true });
      await controller.updateAccount({ userId: "owner", deviceIds: [], verified: true });
    }
    release(); await assert.rejects(opening, { code: "account_changed" });
    assert.equal(starts, 0); await controller.dispose();
  });
});

test("absent external CLI discovery and task start use the same bundled personal profile", async t => {
  const { startJob, getStatus, cancelJob } = require("../src/codex");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-bundled-task-"));
  const executable = path.join(directory, "app-server"), profile = path.join(directory, "profile"), log = path.join(directory, "rpc.jsonl");
  const keys = ["SHAPES_CODEX_BINARY", "SHAPES_CLAUDE_BINARY", "SHAPES_BUNDLED_CODEX_BINARY", "SHAPES_CODEX_JOB_DIR", "CODEX_HOME"];
  const previous = keys.map(key => process.env[key]);
  let job;
  t.after(async () => {
    if (job) { try { if (getStatus(job.job_id).state === "running") cancelJob(job.job_id); } catch {} }
    keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(profile);
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.on('SIGTERM',()=>process.exit(0));const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>console.log(JSON.stringify(x));rl.on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:q.method,profile:process.env.CODEX_HOME,params:q.method==='thread/start'?q.params:undefined})+'\\n');
if(q.method==='initialize')send({id:q.id,result:{}});
else if(q.method==='account/read')send({id:q.id,result:{account:{type:'chatgpt'}}});
else if(q.method==='thread/start')send({id:q.id,result:{thread:{id:'personal-thread'},approvalPolicy:'never'}});
else if(q.method==='turn/start'){send({id:q.id,result:{turn:{id:'personal-turn'}}});send({method:'turn/completed',params:{threadId:'personal-thread',turn:{id:'personal-turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'Read-only fixture complete.'}]}}});}});\n`, { mode: 0o700 });
  Object.assign(process.env, { SHAPES_CODEX_BINARY: path.join(directory, "missing-codex"), SHAPES_CLAUDE_BINARY: path.join(directory, "missing-claude"),
    SHAPES_BUNDLED_CODEX_BINARY: executable, SHAPES_CODEX_JOB_DIR: path.join(directory, "jobs"), CODEX_HOME: profile });
  const selected = await inspectAgent("codex", directory);
  assert.equal(selected.available, true); assert.equal(selected.transport, "bundled_personal");
  assert.ok(!fs.readFileSync(log, "utf8").includes('turn/start'));
  job = await startJob({ prompt: "Read the disposable fixture only.", cwd: directory, agent: "codex", sandbox: "read-only" });
  let terminal;
  for (let i = 0; i < 100; i++) {
    terminal = getStatus(job.job_id);
    if (["completed", "failed", "cancelled", "timed_out"].includes(terminal.state)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(terminal.state, "completed"); assert.equal(terminal.exit_code, 0);
  const calls = fs.readFileSync(log, "utf8").trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(call => call.profile === profile));
  assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
  assert.equal(calls.find(call => call.method === "thread/start").params.sandbox, "read-only");
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "jobs", job.job_id, "request.json")));
  assert.equal(saved.personalProfile, profile); assert.equal(saved.executable, executable); assert.equal(saved.gateway, undefined);
});

test("invalid provider URLs never open; login completion closes only its auth process", async () => {
  for (const url of ["http://auth.openai.com/a", "https://auth.openai.com.evil.invalid/a", "file:///tmp/a", "https://user:secret@auth.openai.com/a"]) assert.equal(validLoginURL(url), false);
  const fixture = fakeClient(); let opens = 0;
  const manager = createPersonalLoginManager({ createClient: fixture.createClient, open: async () => { opens++; } });
  await manager.start({ executable: "/bundled" });
  fixture.created.onLogin({ loginId: "unrelated", success: true }); assert.equal(manager.status().pending, true);
  fixture.created.onLogin({ loginId: "owned-login", success: true }); await tick();
  assert.equal(manager.status().pending, false); assert.equal(fixture.closed, 1); assert.equal(opens, 1);
  const invalid = fakeClient({ login: { loginId: "owned-invalid", authUrl: "https://unrelated.invalid/login" } });
  const rejected = createPersonalLoginManager({ createClient: invalid.createClient, open: async () => { opens++; } });
  await assert.rejects(rejected.start({ executable: "/bundled" }), /Invalid provider/);
  assert.equal(opens, 1); assert.equal(invalid.closed, 1);
});

test("account transport enforces an account-only RPC allowlist on an actual child", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-account-rpc-"));
  const executable = path.join(directory, "account-server");
  fs.writeFileSync(executable, `#!${process.execPath}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(q.id)console.log(JSON.stringify({id:q.id,result:q.method==='account/read'?{account:{type:'chatgpt',email:'private@example.invalid'}}:{}}));});\n`, { mode: 0o700 });
  const client = createAccountClient({ executable, profile: directory });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.ready;
  assert.equal((await client.request("account/read", { refreshToken: false })).account.type, "chatgpt");
  await assert.rejects(client.request("turn/start", { prompt: "must not execute" }), /Unsupported/);
  const pid = client.pid; await client.close(); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("stalled account transport times out without inference and its owned child exits", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "personal-account-timeout-"));
  const executable = path.join(directory, "account-server");
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const client = createAccountClient({ executable, profile: directory, timeoutMs: 40 });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(client.ready, /timed out/);
  const pid = client.pid; await client.close(); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("native private cancellation requires current account and does not touch external login", async () => {
  let cancels = 0;
  const controller = createEmbeddedController({ read: () => null, remove: () => {},
    runtime: { running: () => false, pid: () => null, stop: async () => {} },
    personalLogin: { start: async () => ({ opened: true, cancellable: true }), cancel: async () => { cancels++; return { cancelled: true }; } },
  });
  await assert.rejects(controller.cancelAgentLogin({ expectedUserId: "owner", agent: "codex" }), { code: "account_unverified" });
  assert.equal(cancels, 0);
  await controller.updateAccount({ userId: "owner", deviceIds: [], verified: true }); const baseline = cancels;
  assert.deepEqual(await controller.cancelAgentLogin({ expectedUserId: "owner", agent: "claude" }), { cancelled: false });
  assert.equal(cancels, baseline);
  assert.deepEqual(await controller.cancelAgentLogin({ expectedUserId: "owner", agent: "codex" }), { cancelled: true });
  await assert.rejects(controller.cancelAgentLogin({ expectedUserId: "other", agent: "codex" }), { code: "account_changed" });
  await controller.dispose();
});


test("provider browser handoff preserves a literal URL on each platform and rejects other origins", async () => {
  const url = "https://auth.openai.com/authorize?state=quote'&literal=$value";
  for (const platform of ["darwin", "win32", "linux"]) {
    let launch;
    await openBrowser(url, { platform, execute: (file, args, options, done) => {
      launch = { file, args, options }; done(null);
    } });
    assert.equal(launch.options.timeout, 10000);
    if (platform === "win32") {
      assert.match(launch.file, /WindowsPowerShell.*powershell\.exe$/);
      assert.equal(launch.args.at(-2), "-EncodedCommand");
      assert.equal(Buffer.from(launch.args.at(-1), "base64").toString("utf16le"),
        "Start-Process -FilePath 'https://auth.openai.com/authorize?state=quote''&literal=$value'");
    } else assert.deepEqual(launch.args, [url]);
  }
  for (const url of ["https://other.invalid/", "https://user@auth.openai.com/", "file:///private"]) {
    await assert.rejects(openBrowser(url, { platform: "win32", execute: () => assert.fail("must not launch") }), /Invalid provider/);
  }
});
