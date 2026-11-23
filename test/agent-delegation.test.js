"use strict";

// The person's own Claude Code / Codex, run the way they run it: their images
// with the task, their permission mode, any folder they point at
// (2026-11-22: "make it not set extra boundaries").
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("wireframe-bytes")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("photo")]);
const image = (bytes, media_type, name) => ({ media_type, data: bytes.toString("base64"), ...(name ? { name } : {}) });

// A fake Claude Code that reads the stream-json user message and reports its
// mode in the init event, as the real CLI does.
function claudeFixture(t, { hostPrompts = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shapes-delegation-")));
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const executable = path.join(dir, "fake-claude");
  const help = ["Options:", "  -p, --print   Print", "  --output-format <f>  Output", "  --verbose  Verbose",
    "  --permission-mode <mode>  Mode", '        (choices: "acceptEdits", "auto", "manual", "plan")',
    ...(hostPrompts ? ["  --permission-prompts <target>  Who answers", '        --print: "host" (the SDK host) or "none"']
      : ["  --permission-prompts <target>  Who answers"]),
    "  --tools <tools...>  Tools", "  --strict-mcp-config  Strict", "  --mcp-config <c>  MCP", "  --disallowedTools <t>  Deny"];
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);
if(a.includes('--version')){console.log('2.1.300 (Claude Code)');process.exit(0);}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
if(a[0]==='agents'){console.log('[]');process.exit(0);}
if(a.includes('--help')){console.log(${JSON.stringify(help.join("\n"))});process.exit(0);}
const mode=a.includes('--permission-mode')?a[a.indexOf('--permission-mode')+1]:'default';
let raw='';process.stdin.on('data',b=>{raw+=b;const line=raw.split('\\n')[0];if(raw.includes('\\n'))finish(line);});
process.stdin.on('end',()=>finish(raw.trim()));
let done=false;function finish(line){if(done)return;done=true;
  fs.writeFileSync(process.env.FAKE_LOG,JSON.stringify({args:a,stdin:line}));
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'s-1',permissionMode:mode}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Made five directions.'}));
  process.exit(0);}`, { mode: 0o700 });
  const env = { SHAPES_CLAUDE_BINARY: executable, SHAPES_CODEX_JOB_DIR: path.join(dir, "jobs"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    FAKE_LOG: path.join(dir, "run.json"), HOME: home };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = () => JSON.parse(fs.readFileSync(env.FAKE_LOG, "utf8"));
  return { dir, work, home, run, codex: require("../src/codex") };
}

async function finished(codex, id) {
  for (let i = 0; i < 400; i++) {
    const status = codex.publicStatus(id);
    if (TERMINAL.has(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The job did not finish in time.");
}

test("the person's attached image reaches Claude Code in the task's own message, with a private copy", async (t) => {
  const f = claudeFixture(t);
  const { normalizeImages } = require("../src/agent-images");
  const start = await f.codex.startJob({ prompt: "Design the shape page", cwd: f.work, agent: "claude", sandbox: "workspace-write",
    images: normalizeImages([image(PNG, "image/png", "wireframe.png")]) });
  assert.equal(start.images, 1);
  const done = await finished(f.codex, start.job_id);
  assert.deepEqual([done.state, done.images, done.permission_mode], ["completed", 1, "auto"]);
  const { args, stdin } = f.run();
  assert.ok(args.includes("--input-format") && args.includes("--permission-prompt-tool"));
  const message = JSON.parse(stdin);
  const [text, block] = message.message.content;
  assert.equal(text.type, "text");
  assert.match(text.text, /^Design the shape page/);
  assert.deepEqual(block, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  const copy = path.join(f.dir, "jobs", start.job_id, "images", "1.png");
  assert.ok(text.text.includes(copy), "the prompt names the saved copy");
  assert.deepEqual(fs.readFileSync(copy), PNG);
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
});

test("a read-only Claude run (asked for by the person) still gets the image through stream-json", async (t) => {
  const f = claudeFixture(t);
  const start = await f.codex.startJob({ prompt: "Just look at this", cwd: f.work, agent: "claude", sandbox: "read-only",
    images: [image(JPEG, "image/jpeg")] });
  assert.equal((await finished(f.codex, start.job_id)).state, "completed");
  const { args, stdin } = f.run();
  assert.deepEqual(args.slice(args.indexOf("--input-format"), args.indexOf("--input-format") + 2), ["--input-format", "stream-json"]);
  assert.equal(JSON.parse(stdin).message.content[1].source.media_type, "image/jpeg");
});

test("a run with no images keeps the plain prompt", async (t) => {
  const f = claudeFixture(t, { hostPrompts: false });
  const start = await f.codex.startJob({ prompt: "Plain task", cwd: f.work, agent: "claude", sandbox: "workspace-write" });
  assert.equal(start.images, undefined);
  assert.equal((await finished(f.codex, start.job_id)).state, "completed");
  const { args, stdin } = f.run();
  assert.equal(stdin, "Plain task");
  assert.ok(!args.includes("--input-format"));
});

test("images are checked: type, signature, count and size; a retry with other images is a different request", async (t) => {
  const { normalizeImages } = require("../src/agent-images");
  assert.deepEqual(normalizeImages(undefined), []);
  assert.throws(() => normalizeImages([image(JPEG, "image/png")]), /does not match/);
  assert.throws(() => normalizeImages([image(PNG, "image/svg+xml")]), /PNG, JPEG, WebP or GIF/);
  assert.throws(() => normalizeImages(Array(5).fill(image(PNG, "image/png"))), /at most 4/);
  assert.throws(() => normalizeImages([{ media_type: "image/png", data: "not base64!" }]), /base64/);
  assert.throws(() => normalizeImages([{ ...image(PNG, "image/png"), path: "/etc/passwd" }]), /media_type/);
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  assert.throws(() => normalizeImages([image(big, "image/png")]), /at most 5 MB/);
  const f = claudeFixture(t);
  const key = "delegation-request-key-1";
  const first = await f.codex.startJob({ prompt: "Same words", cwd: f.work, agent: "claude", sandbox: "workspace-write", requestKey: key,
    images: [image(PNG, "image/png")] });
  const retry = await f.codex.startJob({ prompt: "Same words", cwd: f.work, agent: "claude", sandbox: "workspace-write", requestKey: key,
    images: [image(PNG, "image/png")] });
  assert.equal(retry.job_id, first.job_id);
  await assert.rejects(f.codex.startJob({ prompt: "Same words", cwd: f.work, agent: "claude", sandbox: "workspace-write", requestKey: key,
    images: [image(JPEG, "image/jpeg")] }));
  await finished(f.codex, first.job_id);
});

test("Claude Code runs in the person's own mode: settings, then their Claude app folder choice, then auto", (t) => {
  const { claudePermissionMode, claudeAppFolderMode } = require("../src/agents");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shapes-claude-mode-")));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const app = path.join(home, "Library", "Application Support", "Claude");
  fs.mkdirSync(app, { recursive: true });
  const prefs = (folders) => fs.writeFileSync(path.join(app, "claude_desktop_config.json"), JSON.stringify({ preferences: { epitaxyPrefs: {
    "epitaxy-folder-permission-mode-v2.account-1": folders, "epitaxy-folder-permission-mode.account-1": { "/repos": "plan" } } } }));
  const opts = { home, platform: "darwin" };
  assert.equal(claudePermissionMode("/repos/app", { ...opts, autoMode: true }), "auto", "no settings, no app choice: auto");
  prefs({ "/repos": "auto", "/repos/app": "acceptEdits", "/repos/app-other": "default" });
  assert.equal(claudeAppFolderMode("/repos/app/src", opts), "acceptEdits", "the nearest folder they chose wins");
  assert.equal(claudeAppFolderMode("/repos/shapes-chat", opts), "auto");
  assert.equal(claudeAppFolderMode("/elsewhere", opts), null);
  assert.equal(claudePermissionMode("/repos/app", { ...opts, autoMode: true }), "acceptEdits");
  prefs({ "/repos/app": "bypassPermissions" });
  assert.equal(claudePermissionMode("/repos/app", { ...opts, autoMode: true }), "auto", "an unsupported choice falls back to auto");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ permissions: { defaultMode: "plan" } }));
  prefs({ "/repos/app": "acceptEdits" });
  assert.equal(claudePermissionMode("/repos/app", { ...opts, autoMode: true }), undefined, "their settings' defaultMode: no flag at all");
});

test("Codex gets the image by path: exec --image and app-server localImage", async (t) => {
  const { argumentsFor } = require("../src/agents");
  const args = argumentsFor("codex", { sandbox: "workspace-write", cwd: "/work", images: [{ path: "/jobs/1/images/1.png" }] });
  assert.deepEqual(args.slice(-2), ["--image=/jobs/1/images/1.png", "-"]);
  assert.equal(args[args.indexOf("--sandbox") + 1], "danger-full-access");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-codex-image-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, "fake-codex");
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('node:fs');const input=[];const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);input.push(m);fs.writeFileSync(${JSON.stringify(path.join(dir, "input.json"))},JSON.stringify(input));
  if(m.method==='initialize'){send({id:m.id,result:{}});return;}
  if(m.method==='thread/start'){send({id:m.id,result:{thread:{id:'thread-1'},approvalPolicy:'never'}});return;}
  if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn-1'}}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[]}}});}
});`, { mode: 0o700 });
  const { createCodexRpcSession } = require("../src/codex-rpc");
  const { codexInput } = require("../src/agent-images");
  const session = createCodexRpcSession({ executable, cwd: dir, sandbox: "workspace-write", shutdownTimeoutMs: 100 });
  t.after(() => session.close());
  await session.start(codexInput("Design it", [{ path: "/jobs/1/images/1.png", name: "wireframe.png" }]));
  const turn = JSON.parse(fs.readFileSync(path.join(dir, "input.json"), "utf8")).find((m) => m.method === "turn/start");
  assert.match(turn.params.input[0].text, /^Design it[\s\S]*wireframe\.png: \/jobs\/1\/images\/1\.png/);
  assert.deepEqual(turn.params.input[1], { type: "localImage", path: "/jobs/1/images/1.png" });
  await assert.rejects(createCodexRpcSession({ executable, cwd: dir }).start({ text: "x", localImages: ["relative.png"] }), /absolute image paths/);
});

test("the start and send routes take images and refuse malformed ones before anything runs", async (t) => {
  const f = claudeFixture(t);
  const { startServer } = require("../src/server");
  const token = "t".repeat(32);
  const server = await startServer({ port: 0, token });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(base + route, { method: "POST", headers: { "x-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const capabilities = await (await fetch(base + "/capabilities")).json();
  assert.equal(capabilities.features.agent_images, true);
  assert.equal(capabilities.features.agent_any_folder, true);
  const bad = await post("/agents/start", { prompt: "x", cwd: f.work, agent: "claude", workspace_write: true, images: [image(JPEG, "image/png")] });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /does not match/);
  assert.equal(fs.existsSync(path.join(f.dir, "jobs")) && fs.readdirSync(path.join(f.dir, "jobs")).some((name) => /^[0-9a-f-]{36}$/.test(name)), false);
  // A primary Git checkout is fine for writes.
  execFileSync("git", ["-C", f.work, "init"], { stdio: "pipe" });
  const good = await post("/agents/start", { prompt: "Design", cwd: f.work, agent: "claude", workspace_write: true, images: [image(PNG, "image/png")] });
  assert.equal(good.status, 202);
  const receipt = await good.json();
  assert.equal(receipt.images, 1);
  assert.equal((await finished(f.codex, receipt.job_id)).state, "completed");
});
