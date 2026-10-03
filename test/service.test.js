"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { serviceDefinition, launcherContent, runtimePaths } = require("../src/service");
const { writeState, readState } = require("../src/state");

test("macOS startup uses stable installed files, survives exit, and escapes home paths", () => {
  const result = serviceDefinition({ platform: "darwin", home: "/Users/A & B", dir: "/Users/A & B/.shapes-bridge", envPath: "/usr/bin:/some path" });
  assert.match(result.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(result.content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(result.content, /A &amp; B\/.shapes-bridge\/runtime\/Shapes Bridge/);
  assert.match(result.content, /<key>Umask<\/key><integer>63/);
  assert.match(result.content, /<string>daemon<\/string>/);
  assert.doesNotMatch(result.content, /npx|device_token/);
});

test("Linux user service restarts and quotes whitespace, quotes, and percent specifiers", () => {
  const result = serviceDefinition({ platform: "linux", home: '/home/a "quote"%name', dir: '/home/a "quote"%name/bridge' });
  assert.match(result.content, /Restart=always/);
  assert.match(result.content, /WantedBy=default.target/);
  assert.match(result.content, /UMask=0077/);
  assert.match(result.content, /\\"quote\\"%%name/);
});

test("Windows task is interactive, at login, stays alive on battery, and avoids elevation", () => {
  const result = serviceDefinition({ platform: "win32", home: "C:/Users/test", dir: "C:/Users/test/bridge", user: "DOMAIN\\A & B" });
  assert.match(result.content, /InteractiveToken/);
  assert.match(result.content, /LeastPrivilege/);
  assert.match(result.content, /<ExecutionTimeLimit>PT0S/);
  assert.match(result.content, /<StopIfGoingOnBatteries>false/);
  assert.match(result.content, /A &amp; B/);
  assert.match(result.content, /--state-dir/);
});

test("local control launchers preserve literal paths and need neither npm nor the network", () => {
  const unix = launcherContent("/Users/a'b/$special directory", "darwin");
  assert.match(unix, /a'\\''b/);
  assert.match(unix, /"\$@"/);
  assert.doesNotMatch(unix, /npx|https:/);
  const windows = launcherContent("C:/Users/A % B!", "win32");
  assert.match(windows, /DisableDelayedExpansion/);
  assert.match(windows, /A %% B!/);
  assert.match(windows, /%\*/);
});

test("installed local launcher runs offline and forwards shell metacharacters literally", { skip: process.platform === "win32" }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-launcher-"));
  const dir = path.join(base, "a'b $HOME directory");
  const paths = runtimePaths(dir);
  try {
    fs.mkdirSync(path.dirname(paths.cli), { recursive: true });
    fs.symlinkSync(process.execPath, paths.node);
    fs.writeFileSync(paths.cli, "process.stdout.write(JSON.stringify({args:process.argv.slice(2),state:process.env.SHAPES_BRIDGE_HOME}))");
    fs.writeFileSync(paths.launcher, launcherContent(dir), { mode: 0o700 });
    const args = ["status", "a'b $HOME ; literal"];
    const result = spawnSync(paths.launcher, args, { encoding: "utf8", env: { PATH: "/nonexistent" } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, state: dir });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("account credentials are atomically stored with private filesystem modes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-state-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  try {
    writeState("config", { device_token: "private-test-token" });
    assert.equal(readState("config").device_token, "private-test-token");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
    }
    assert.equal(fs.readdirSync(dir).filter((file) => file.endsWith(".tmp")).length, 0);
  } finally {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
