"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { spawnOwned } = require("../src/owned-process");
const available = process.platform === "win32" && process.env.SHAPES_TEST_JOB_HOST;
const owned = (args, options = {}) => spawnOwned(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], ...options }, { host: process.env.SHAPES_TEST_JOB_HOST });
const waitFor = async (predicate) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.fail("The owned process did not settle before the deadline.");
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Windows Job helper preserves stdin/stdout and literal command arguments", { skip: !available, timeout: 15000 }, async () => {
  const args = ['spaces & shell | syntax', 'quote"here', 'trailing\\', 'emoji 🌲'];
  const child = owned(["-e", "let data='';process.stdin.on('data',p=>data+=p);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(1),data})))", ...args]);
  let output = "", error = "";
  child.stdout.on("data", (part) => { output += part; }); child.stderr.on("data", (part) => { error += part; });
  child.stdin.end("private test input");
  const [code] = await once(child, "close");
  assert.equal(code, 0, error);
  assert.deepEqual(JSON.parse(output), { args, data: "private test input" });
});

test("Windows handoff control input is hidden from the command and EOF fails closed", { skip: !available, timeout: 15000 }, async () => {
  for (const release of [true, false]) {
    const child = owned(["-e", "let data='';process.stdin.on('data',p=>data+=p);process.stdin.on('end',()=>console.log(JSON.stringify({data})))"], { releaseOnSuccess: true });
    let output = "";
    child.stdout.on("data", (part) => { output += part; }); child.stderr.resume();
    const closed = once(child, "close"); let timer;
    try {
      await Promise.race([once(child.stdout, "end"), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("command received the private control pipe instead of EOF")), 5000); })]);
      clearTimeout(timer);
      assert.deepEqual(JSON.parse(output), { data: "" });
      assert.equal(child.exitCode, null, "successful leader must wait for its owner");
      child.stdin.end(release ? "release\n" : undefined);
      assert.equal((await closed)[0], release ? 0 : 70);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } }
  }
});

test("Windows control EOF kills surviving descendants after successful leader exit", { skip: !available, timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-release-eof-")), receipt = path.join(directory, "owned.json");
  const source = "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));child.unref();";
  const wrapper = owned(["-e", source, receipt], { releaseOnSuccess: true });
  const closed = once(wrapper, "close"); wrapper.stdout.resume(); wrapper.stderr.resume();
  try {
    await waitFor(() => fs.existsSync(receipt));
    const pids = JSON.parse(fs.readFileSync(receipt, "utf8"));
    await waitFor(() => !alive(pids.parent));
    assert.equal(alive(pids.child), true);
    wrapper.stdin.end();
    assert.equal((await closed)[0], 70);
    await waitFor(() => !alive(pids.child));
  } finally {
    if (wrapper.exitCode === null && wrapper.signalCode === null) { wrapper.kill(); await closed; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminating a Windows Job wrapper kills its live child and grandchild", { skip: !available, timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-owned-"));
  const receipt = path.join(directory, "owned.json");
  const source = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000);";
  const wrapper = owned(["-e", source, receipt]);
  try {
    await waitFor(() => fs.existsSync(receipt));
    const pids = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.ok(alive(pids.parent)); assert.ok(alive(pids.child));
    wrapper.kill(); await once(wrapper, "close");
    await waitFor(() => !alive(pids.parent) && !alive(pids.child));
  } finally { if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Windows Job parent death ends the wrapper's entire process tree", { skip: !available, timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-parent-"));
  const receipt = path.join(directory, "owned.json");
  const modulePath = path.resolve(__dirname, "../src/owned-process.js");
  const nested = "const owned=require(process.argv[1]).spawnOwned;const c=owned(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'},{host:process.argv[2]});require('node:fs').writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,wrapper:c.pid}));setInterval(()=>{},1000);";
  const wrapper = owned(["-e", nested, modulePath, process.env.SHAPES_TEST_JOB_HOST, receipt]);
  try {
    await waitFor(() => fs.existsSync(receipt));
    const pids = JSON.parse(fs.readFileSync(receipt, "utf8"));
    process.kill(pids.parent); await once(wrapper, "close");
    await waitFor(() => !alive(pids.wrapper));
  } finally { if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("an explicitly durable Windows job survives its short launcher", { skip: !available, timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-durable-"));
  const receipt = path.join(directory, "receipt.json"), marker = path.join(directory, "completed.txt");
  const modulePath = path.resolve(__dirname, "../src/owned-process.js");
  const work = "setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'completed'),500)";
  const source = "const c=require(process.argv[1]).spawnOwned(process.execPath,['-e',process.argv[4],process.argv[5]],{parentPid:null,stdio:'ignore'},{host:process.argv[2]});c.once('spawn',()=>{require('node:fs').writeFileSync(process.argv[3],JSON.stringify({wrapper:c.pid}));c.unref()});";
  const launcher = spawn(process.execPath, ["-e", source, modulePath, process.env.SHAPES_TEST_JOB_HOST, receipt, work, marker], { stdio: "ignore", windowsHide: true });
  let wrapper;
  try {
    assert.equal((await once(launcher, "close"))[0], 0);
    wrapper = JSON.parse(fs.readFileSync(receipt, "utf8")).wrapper;
    await waitFor(() => fs.existsSync(marker));
    assert.equal(fs.readFileSync(marker, "utf8"), "completed");
    await waitFor(() => !alive(wrapper));
  } finally {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
    if (wrapper && alive(wrapper)) process.kill(wrapper);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
