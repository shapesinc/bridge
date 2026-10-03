"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const securedWindowsDirectories = new Set();

function stateDir() {
  return process.env.SHAPES_BRIDGE_HOME || path.join(os.homedir(), ".shapes-bridge");
}

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  else if (!securedWindowsDirectories.has(dir)) {
    // POSIX modes do not restrict Windows ACLs, particularly for a custom path.
    const identity = spawnSync("whoami.exe", [], { encoding: "utf8", windowsHide: true });
    if (identity.status !== 0 || !identity.stdout?.trim()) throw new Error("Could not identify the Windows account to protect computer credentials.");
    const secured = spawnSync("icacls.exe", [dir, "/inheritance:r", "/grant:r", `${identity.stdout.trim()}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { encoding: "utf8", windowsHide: true });
    if (secured.status !== 0) throw new Error("Could not make the Shapes Bridge directory private. Choose a directory owned by your Windows account.");
    securedWindowsDirectories.add(dir);
  }
  return dir;
}

function readState(name) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(), `${name}.json`), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function writeState(name, value) {
  const destination = path.join(ensureStateDir(), `${name}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
}

function removeState(name) {
  fs.rmSync(path.join(stateDir(), `${name}.json`), { force: true });
}

module.exports = { stateDir, ensureStateDir, readState, writeState, removeState };
