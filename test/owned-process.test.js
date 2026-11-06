"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnOwned, signalOwned, windowsArguments, jobHostPath } = require("../src/owned-process");
const { windowsCandidates } = require("../src/agents");
const { bundledWindowsTunnel } = require("../src/cloudflared");

test("Windows owned processes use a fixed Job wrapper and argument array without a shell", () => {
  let launch;
  const child = {};
  const result = spawnOwned("C:\\Program Files\\Codex\\codex.exe", ["arg\" & echo private"], { stdio: ["pipe", "pipe", "pipe"], shell: true },
    { platform: "win32", host: "C:\\app\\Job.exe", exists: () => true, spawnProcess: (...args) => { launch = args; return child; } });
  assert.equal(result, child); assert.equal(launch[0], "C:\\app\\Job.exe");
  assert.deepEqual(launch[1].slice(-3), ["--", "C:\\Program Files\\Codex\\codex.exe", "arg\" & echo private"]);
  assert.equal(launch[2].shell, false); assert.equal(launch[2].detached, false);
  assert.deepEqual(windowsArguments("C:\\node.exe", ["task"], { parentPid: null }), ["--", "C:\\node.exe", "task"]);
  assert.throws(() => windowsArguments("C:\\node.exe", [], { parentPid: 0 }), /process owner/);
});
test("missing Job helper and command-script paths fail before spawning", () => {
  assert.throws(() => spawnOwned("C:\\node.exe", [], {}, { platform: "win32", host: "C:\\missing\\Job.exe", exists: () => false }), /supervisor is missing/);
  assert.throws(() => windowsArguments("C:\\npm\\codex.cmd", []), /Windows executable/);
  assert.throws(() => windowsArguments("codex.exe", []), /Windows executable/);
});
test("successful ownership handoff requires a live parent and an isolated input pipe", () => {
  assert.throws(() => windowsArguments("C:\\node.exe", [], { parentPid: null, releaseOnSuccess: true }), /private control input/);
  assert.throws(() => windowsArguments("C:\\node.exe", [], { console: true, releaseOnSuccess: true }), /private control input/);
  for (const stdio of [["ignore", "pipe", "pipe"], ["pipe", "inherit", "pipe"], ["pipe", "pipe", "ignore"], ["pipe", "pipe", "pipe", "pipe"], "pipe"]) {
    assert.throws(() => spawnOwned("C:\\node.exe", [], { releaseOnSuccess: true, stdio },
      { platform: "win32", host: "C:\\app\\Job.exe", exists: () => true, spawnProcess: () => assert.fail("must fail before spawn") }), /piped control input/);
  }
});
test("handoff captures stdout through an explicit extra pipe and preserves the child stdout API", () => {
  const input = {}, output = {}, error = {}, child = { stdin: input, stdout: null, stderr: error, stdio: [input, null, error, output] };
  const options = { releaseOnSuccess: true, ready: true, stdio: ["pipe", "pipe", "pipe"] };
  let launch;
  const result = spawnOwned("C:\\node.exe", ["task"], options,
    { platform: "win32", host: "C:\\app\\Job.exe", exists: () => true, spawnProcess: (...args) => { launch = args; return child; } });
  assert.equal(result, child); assert.equal(result.stdout, output); assert.equal(result.stdin, input); assert.equal(result.stderr, error);
  assert.deepEqual(launch[2].stdio, ["pipe", "ignore", "pipe", "pipe"]);
  assert.deepEqual(launch[1].slice(2), ["--ready", "--release-on-success", "--stdout-fd", "3", "--", "C:\\node.exe", "task"]);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"], "caller options remain reusable");
  assert.equal(child.stdio[1], null, "do not duplicate the extra stream in the ChildProcess stdio lifecycle array");
});
test("signed app helper selection never compiles or falls back when its bundled helper is missing", () => {
  const settings = { platform: "win32", executable: "C:\\app\\node.exe", sourceDirectory: "C:\\app\\bridge\\src" };
  assert.equal(jobHostPath({ ...settings, exists: (file) => file === "C:\\app\\manifest.json", compile: () => assert.fail("must not compile signed app fallback") }),
    "C:\\app\\shapes.inc Bridge Job.exe");
  assert.equal(jobHostPath({ ...settings, exists: () => false, compile: () => "C:\\private\\compiled.exe" }), "C:\\private\\compiled.exe");
});
test("Windows cancellation targets the exact live wrapper and never a global PID name", () => {
  const signals = [];
  const child = { pid: 123, exitCode: null, signalCode: null, kill: (signal) => signals.push(signal) };
  signalOwned(child, "SIGKILL", { platform: "win32", kill: () => assert.fail("must not signal POSIX group") });
  child.exitCode = 0; signalOwned(child, "SIGKILL", { platform: "win32" });
  assert.deepEqual(signals, ["SIGKILL"]);
});
test("Windows provider discovery checks native installs and PATH executables", () => {
  const candidates = windowsCandidates("codex", { home: "C:\\Users\\Me", env: { APPDATA: "C:\\Users\\Me\\AppData\\Roaming", Path: "C:\\tools;D:\\more tools" }, arch: "x64" });
  assert.ok(candidates.includes("C:\\tools\\codex.exe"));
  assert.ok(candidates.some((value) => value.includes("x86_64-pc-windows-msvc\\codex\\codex.exe")));
  assert.ok(candidates.every((value) => value.endsWith(".exe")));
});

test("installed Windows host requires its pinned bundled tunnel without runtime downloads", () => {
  const options = { platform: "win32", executable: "C:\\app\\computer-connection\\node.exe" };
  assert.equal(bundledWindowsTunnel({ ...options, exists: () => true }), "C:\\app\\computer-connection\\cloudflared.exe");
  assert.throws(() => bundledWindowsTunnel({ ...options, exists: (file) => file.endsWith("Job.exe") }), /tunnel helper is missing/);
  assert.equal(bundledWindowsTunnel({ ...options, exists: () => false }), null);
});
