"use strict";

// "/applications/shapesinc/app" opens the same folder on macOS and Windows, but
// Claude Code, Codex and the Claude app key sessions and saved permission modes
// by the exact spelling (2026-11-23, job b56e64c0: the Bridge missed Dhruv's
// saved mode for /Applications/shapesinc/app and stored the lowercase path).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { validateCwd, onDiskPath } = require("../src/codex");
const { claudeAppFolderMode } = require("../src/agents");

function fakeRealpath(resolved, native) {
  const realpath = () => resolved;
  realpath.native = () => { if (native instanceof Error) throw native; return native; };
  return realpath;
}

test("the folder takes its on-disk spelling; a mapped drive stays a drive", () => {
  assert.equal(onDiskPath("/applications/shapesinc/app", fakeRealpath("/applications/shapesinc/app", "/Applications/shapesinc/app")),
    "/Applications/shapesinc/app");
  assert.equal(onDiskPath("c:\\users\\runner~1\\app", fakeRealpath("c:\\users\\RUNNER~1\\app", "C:\\Users\\runneradmin\\App")),
    "C:\\Users\\runneradmin\\App");
  assert.equal(onDiskPath("Z:\\work\\app", fakeRealpath("Z:\\work\\app", "\\\\server\\share\\work\\app")), "Z:\\work\\app");
  assert.equal(onDiskPath("/x", fakeRealpath("/x", new Error("EPERM"))), "/x");
});

test("an odd-case folder resolves to the real one, and its saved Claude app mode is found", (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "shapes-folder-spelling-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, "Shapes Inc", "App");
  fs.mkdirSync(real, { recursive: true });
  const typed = path.join(root, "shapes inc", "app");
  if (!fs.existsSync(typed)) { t.skip("this file system tells letter case apart"); return; }

  assert.equal(validateCwd(typed), real);
  assert.equal(validateCwd(typed.toUpperCase()), real);
  if (process.platform === "win32") assert.match(validateCwd(typed[0].toLowerCase() + typed.slice(1)), /^[A-Z]:\\/);

  // The saved-mode lookup reads the Claude app's settings under a stand-in home.
  const home = path.join(root, "home");
  const windows = process.platform === "win32";
  const appData = process.env.APPDATA;
  if (windows) { process.env.APPDATA = path.join(home, "AppData", "Roaming"); t.after(() => { process.env.APPDATA = appData; }); }
  const config = windows ? path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json")
    : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ preferences: { epitaxyPrefs: {
    "epitaxy-folder-permission-mode-v2.account": { [real]: "acceptEdits" } } } }));
  const platform = windows ? "win32" : "darwin";
  if (!windows) assert.equal(claudeAppFolderMode(typed, { home, platform }), null);
  assert.equal(claudeAppFolderMode(validateCwd(typed), { home, platform }), "acceptEdits");
});
