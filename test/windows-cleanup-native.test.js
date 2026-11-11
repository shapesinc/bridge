"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { spawnOwned, signalOwned, ownedCleanup } = require("../src/owned-process");
const { closeProcessGroup } = require("../src/process-close");
const available = process.platform === "win32" && process.env.SHAPES_TEST_JOB_HOST;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = async (predicate, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail("Owned Windows fixture did not reach its expected state.");
};
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cleanup-")), children = new Set();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close"); child.kill(); await closed;
    }
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const own = child => { children.add(child); return child; };
  const launch = (source, handoff = false) => {
    const child = own(spawnOwned(process.execPath, ["-e", source],
      { cleanupReceipt: true, releaseOnSuccess: handoff, cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
      { host: process.env.SHAPES_TEST_JOB_HOST }));
    child.stdout.resume(); child.stderr.resume();
    return child;
  };
  return { dir, own, launch };
}

test("native cleanup confirms descendants when cancellation wins after output EOF but before release", { skip: !available, timeout: 20000 }, async t => {
  const f = fixture(t), state = path.join(f.dir, "state.json"), marker = path.join(f.dir, "late.txt");
  const background = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(state + ".tmp")},JSON.stringify({pid:process.pid,started:Date.now()}));fs.renameSync(${JSON.stringify(state + ".tmp")},${JSON.stringify(state)});setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'bad'),4000);setInterval(()=>{},1000)`;
  const child = f.launch(`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(background)}],{detached:true,stdio:'ignore'});c.unref()`, true);
  const ended = once(child.stdout, "end");
  await ended; await wait(() => fs.existsSync(state));
  const identity = JSON.parse(fs.readFileSync(state));
  assert.equal(alive(identity.pid), true);
  const closed = once(child, "close"); signalOwned(child, "SIGTERM"); await closed;
  assert.equal(ownedCleanup(child), true, "only the native empty-Job receipt confirms cancellation");
  await wait(() => !alive(identity.pid));
  await new Promise(resolve => setTimeout(resolve, Math.max(0, identity.started + 4750 - Date.now())));
  assert.equal(fs.existsSync(marker), false);
});

test("provider stdin remains independent and bounded close confirms the whole owned Job", { skip: !available, timeout: 20000 }, async t => {
  const f = fixture(t), state = path.join(f.dir, "state.json");
  const child = f.launch(`process.stdin.once('data',part=>{if(String(part)!=='provider-rpc\\n')process.exit(9);const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(state + ".tmp")},JSON.stringify({pid:c.pid}));fs.renameSync(${JSON.stringify(state + ".tmp")},${JSON.stringify(state)});});setInterval(()=>{},1000)`);
  child.stdin.write("provider-rpc\n"); await wait(() => fs.existsSync(state));
  const { pid } = JSON.parse(fs.readFileSync(state)); assert.equal(alive(pid), true);
  const result = await closeProcessGroup(child, { graceMs: 1500, exitTimeoutMs: 1500 });
  assert.equal(result.processExited, true); assert.equal(ownedCleanup(child), true);
  await wait(() => !alive(pid));
});

test("observer death and failed creation never manufacture cleanup confirmation", { skip: !available, timeout: 20000 }, async t => {
  const f = fixture(t), state = path.join(f.dir, "state.json");
  const child = f.launch(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(state + ".tmp")},JSON.stringify({pid:process.pid}));fs.renameSync(${JSON.stringify(state + ".tmp")},${JSON.stringify(state)});setInterval(()=>{},1000)`);
  await wait(() => fs.existsSync(state)); const { pid } = JSON.parse(fs.readFileSync(state));
  const closed = once(child, "close"); child.kill(); await closed;
  assert.equal(ownedCleanup(child), false); await wait(() => !alive(pid));
  const bad = path.join(f.dir, "invalid.exe"); fs.writeFileSync(bad, "invalid PE fixture");
  const failed = f.own(spawnOwned(bad, [], { cleanupReceipt: true, stdio: ["pipe", "pipe", "pipe"] }, { host: process.env.SHAPES_TEST_JOB_HOST }));
  failed.stdout.resume(); failed.stderr.resume();
  const [code] = await once(failed, "close"); assert.notEqual(code, 0); assert.equal(ownedCleanup(failed), false);
});

test("owner death closes the observer Job without escaping a descendant", { skip: !available, timeout: 20000 }, async t => {
  const f = fixture(t), state = path.join(f.dir, "owner.json"), command = path.join(f.dir, "command.json");
  const commandSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(command + ".tmp")},JSON.stringify({pid:process.pid}));fs.renameSync(${JSON.stringify(command + ".tmp")},${JSON.stringify(command)});setInterval(()=>{},1000)`;
  const source = `const fs=require('node:fs');const child=require(${JSON.stringify(path.resolve(__dirname, "../src/owned-process"))}).spawnOwned(process.execPath,['-e',${JSON.stringify(commandSource)}],{cleanupReceipt:true,stdio:['pipe','pipe','pipe']},{host:${JSON.stringify(process.env.SHAPES_TEST_JOB_HOST)}});child.stdout.resume();child.stderr.resume();child.once('spawn',()=>{fs.writeFileSync(${JSON.stringify(state + ".tmp")},JSON.stringify({observer:child.pid}));fs.renameSync(${JSON.stringify(state + ".tmp")},${JSON.stringify(state)});});setInterval(()=>{},1000)`;
  const owner = f.own(spawn(process.execPath, ["-e", source], { detached: true, stdio: "ignore", windowsHide: true }));
  await wait(() => fs.existsSync(state) && fs.existsSync(command)); const { observer } = JSON.parse(fs.readFileSync(state));
  const { pid } = JSON.parse(fs.readFileSync(command));
  assert.equal(alive(observer), true);
  const closed = once(owner, "close"); owner.kill(); await closed;
  await wait(() => !alive(observer) && !alive(pid));
});
