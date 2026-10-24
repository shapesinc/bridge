"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { serviceDefinition, launcherContent, runtimePaths, infoPlist, desktopEntry, buildMacApp, APP_NAME } = require("../src/service");
const { writeState, readState } = require("../src/state");

test("macOS startup uses stable installed files, survives exit, and escapes home paths", () => {
  const result = serviceDefinition({ platform: "darwin", home: "/Users/A & B", dir: "/Users/A & B/.shapes-bridge", envPath: "/usr/bin:/some path" });
  assert.match(result.content, /<key>KeepAlive<\/key><true\/>/);
  assert.match(result.content, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(result.content, /A &amp; B\/Applications\/shapes\.inc Bridge\.app\/Contents\/MacOS\/shapes\.inc Bridge/);
  assert.match(result.content, /<key>AssociatedBundleIdentifiers<\/key><array><string>inc\.shapes\.bridge<\/string><\/array>/);
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
    fs.mkdirSync(path.dirname(paths.node), { recursive: true });
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

test("macOS app bundle is a visible app: shapes.inc name, icon, hidden Dock item, and an open hook", () => {
  const plist = infoPlist({ dir: "/Users/A & B/.shapes-bridge", home: "/Users/A & B" });
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>inc\.shapes\.bridge<\/string>/);
  assert.match(plist, /<key>CFBundleName<\/key><string>shapes\.inc Bridge<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>shapes\.inc Bridge<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
  assert.match(plist, /NODE_OPTIONS<\/key><string>--require "\/Users\/A &amp; B\/Applications\/shapes\.inc Bridge\.app\/Contents\/Resources\/runtime\/bin\/open\.js"<\/string>/);
  assert.match(plist, /NSAppleEventsUsageDescription/);
  // A custom state directory keeps its own app beside it instead of ~/Applications.
  assert.equal(runtimePaths("/tmp/custom", "darwin", "/Users/A & B").app, "/tmp/custom/shapes.inc Bridge.app");
  assert.equal(runtimePaths("/Users/A & B/.shapes-bridge", "darwin", "/Users/A & B").app, "/Users/A & B/Applications/shapes.inc Bridge.app");
});

test("Linux launcher entry and renamed runners carry the shapes.inc name", () => {
  const entry = desktopEntry({ dir: '/home/a "b"/.shapes-bridge', home: '/home/a "b"' });
  assert.match(entry, /^Name=shapes\.inc Bridge$/m);
  assert.match(entry, /^Exec="\/home\/a \\"b\\"\/\.shapes-bridge\/shapes-bridge" open$/m);
  assert.match(entry, /^Icon=\/home\/a "b"\/\.shapes-bridge\/runtime\/shapes\.inc Bridge\.png$/m);
  assert.equal(path.basename(runtimePaths("/home/x/.shapes-bridge", "linux", "/home/x").node), "shapes.inc-bridge");
  assert.equal(path.basename(runtimePaths("C:/Users/x/.shapes-bridge", "win32", "C:/Users/x").node), "shapes.inc Bridge.exe");
  assert.match(serviceDefinition({ platform: "linux", home: "/home/x", dir: "/home/x/.shapes-bridge" }).content, /Description=shapes\.inc Bridge/);
  assert.match(serviceDefinition({ platform: "win32", home: "C:/Users/x", dir: "C:/Users/x/.shapes-bridge" }).content, /<Description>shapes\.inc Bridge<\/Description>/);
});

test("macOS app bundle build stages, swaps, signs and leaves a runnable renamed Node", { skip: process.platform !== "darwin" }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-app-"));
  const paths = runtimePaths(base, "darwin");
  const signed = [];
  try {
    fs.mkdirSync(paths.app, { recursive: true });
    fs.writeFileSync(path.join(paths.app, "stale"), "old install");
    buildMacApp(path.resolve(__dirname, ".."), paths, { sign: (app) => signed.push(app) });
    assert.deepEqual(signed, [`${paths.app}.staging`]);
    assert.equal(fs.existsSync(path.join(paths.app, "stale")), false);
    assert.equal(fs.existsSync(`${paths.app}.staging`), false);
    assert.equal(fs.existsSync(paths.cli), true);
    assert.equal(fs.existsSync(paths.icon), true);
    assert.match(fs.readFileSync(paths.plist, "utf8"), /CFBundleExecutable<\/key><string>shapes\.inc Bridge/);
    assert.equal(path.basename(paths.node), APP_NAME);
    const run = spawnSync(paths.node, ["-e", "process.stdout.write(String(1 + 1))"], { encoding: "utf8" });
    assert.equal(run.stdout, "2", run.stderr);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
