"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEmbeddedProcess } = require("../src/embedded-process");
const { descendants } = require("../src/embedded-children");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, timeout = 5000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() >= end) throw new Error("Fixture timed out"); await sleep(20); } }

test("ancestry collection excludes unrelated processes even when names or state IDs match", () => {
  assert.deepEqual(descendants(10, { snapshot: () => "10 1\n12 10\n13 12\n99 1\n100 99\n" }), [12, 13]);
});

test("owned stop cleans detached descendants and leaves an unrelated process alive", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-embedded-process-"));
  const receipt = path.join(directory, "pids.json");
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const fixture = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
    child.once('spawn',()=>setTimeout(()=>fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({daemon:process.pid,child:child.pid})),100)); setInterval(()=>{},1000);`;
  const manager = createEmbeddedProcess({ spawnProcess: (file, _args, options) => spawn(file, ["-e", fixture], options), graceMs: 200 });
  let pids;
  try {
    await manager.start(); await manager.start(); await until(() => fs.existsSync(receipt)); pids = JSON.parse(fs.readFileSync(receipt));
    await manager.stop(); await until(() => !alive(pids.daemon) && !alive(pids.child));
    assert.equal(alive(unrelated.pid), true); assert.equal(manager.running(), false);
  } finally {
    await manager.stop(); unrelated.kill("SIGKILL"); if (pids) for (const pid of Object.values(pids)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("controller SIGKILL closes private IPC and cancels daemon plus detached jobs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-embedded-parent-")), receipt = path.join(directory, "pids.json");
  const lifetime = path.join(__dirname, "../src/embedded-lifetime.js"), children = path.join(__dirname, "../src/embedded-children.js");
  const daemon = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const parent=require(${JSON.stringify(lifetime)}).parentLifetime();
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
    parent.signal.addEventListener('abort',async()=>{await require(${JSON.stringify(children)}).stopDescendants({graceMs:100});process.exit(0)});
    child.once('spawn',()=>setTimeout(()=>fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({daemon:process.pid,child:child.pid})),100));setInterval(()=>{},1000);`;
  const controllerCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});setInterval(()=>{},1000);`;
  const controller = spawn(process.execPath, ["-e", controllerCode], { stdio: "ignore" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  let pids;
  try {
    await until(() => fs.existsSync(receipt)); pids = JSON.parse(fs.readFileSync(receipt));
    controller.kill("SIGKILL"); await until(() => !alive(pids.daemon) && !alive(pids.child));
    assert.equal(alive(unrelated.pid), true);
  } finally {
    controller.kill("SIGKILL"); unrelated.kill("SIGKILL"); if (pids) for (const pid of Object.values(pids)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
