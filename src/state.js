"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const securedWindowsDirectories = new Set();
const retryWait = new Int32Array(new SharedArrayBuffer(4));

// Windows atomic replacement can briefly reject a competing open/rename with
// EPERM. Retry the same fully written private file; never unlink the destination
// or relax its ACL. Persistent permission errors remain bounded failures.
function replaceStateFile(temporary, destination, { platform = process.platform, rename = fs.renameSync,
  now = () => performance.now(), wait = ms => Atomics.wait(retryWait, 0, 0, ms) } = {}) {
  const deadline = now() + 250;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temporary, destination);
      if (attempt > 0 && process.env.SHAPES_BRIDGE_STATE_DIAGNOSTICS === "1") process.stderr.write(`Private state replacement retries: ${attempt}\n`);
      return;
    }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || remaining <= 0 || attempt >= 25) throw error;
      wait(Math.min(10, remaining));
    }
  }
}

function stateDir() {
  return process.env.SHAPES_BRIDGE_HOME || path.join(os.homedir(), ".shapes-bridge");
}

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  else if (!securedWindowsDirectories.has(dir)) {
    // POSIX modes do not restrict Windows ACLs, particularly for a custom path.
    const identity = spawnSync("whoami.exe", [], { encoding: "utf8", windowsHide: true, timeout: 1500, maxBuffer: 65536 });
    if (identity.status !== 0 || !identity.stdout?.trim()) throw Object.assign(new Error("Could not identify the Windows account to protect computer credentials."), { code: "STATE_IDENTITY_UNAVAILABLE" });
    const secured = spawnSync("icacls.exe", [dir, "/inheritance:r", "/grant:r", `${identity.stdout.trim()}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { encoding: "utf8", windowsHide: true, timeout: 1500, maxBuffer: 65536 });
    if (secured.status !== 0) throw Object.assign(new Error("Could not make the shapes.inc Bridge directory private. Choose a directory owned by your Windows account."), { code: "STATE_PERMISSIONS_UNAVAILABLE" });
    securedWindowsDirectories.add(dir);
  }
  return dir;
}

function readState(name, { maxBytes } = {}) {
  try {
    const file = path.join(stateDir(), `${name}.json`);
    if (maxBytes !== undefined) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Invalid private state file");
      const fd = fs.openSync(file, "r");
      try {
        const bytes = Buffer.alloc(maxBytes + 1), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (size > maxBytes) throw new Error("Private state file is too large");
        return JSON.parse(bytes.subarray(0, size).toString("utf8"));
      } finally { fs.closeSync(fd); }
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function writeState(name, value, { durable = false } = {}) {
  const destination = path.join(ensureStateDir(), `${name}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(temporary, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); if (durable) fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    replaceStateFile(temporary, destination);
    // Windows does not expose directory fsync through Node. File flush and
    // atomic replacement are still required; never report a failed write as saved.
    if (durable && process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(destination), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
}

function removeState(name) {
  fs.rmSync(path.join(stateDir(), `${name}.json`), { force: true });
}

module.exports = { stateDir, ensureStateDir, readState, writeState, removeState, replaceStateFile };
