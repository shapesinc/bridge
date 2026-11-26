"use strict";

const crypto = require("node:crypto");
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
  now = () => performance.now(), wait = ms => Atomics.wait(retryWait, 0, 0, ms), budgetMs = 250 } = {}) {
  const deadline = now() + budgetMs, attempts = Math.ceil(budgetMs / 10);
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temporary, destination);
      if (attempt > 0 && process.env.SHAPES_BRIDGE_STATE_DIAGNOSTICS === "1") process.stderr.write(`Private state replacement retries: ${attempt}\n`);
      return;
    }
    catch (error) {
      const remaining = deadline - now();
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || remaining <= 0 || attempt >= attempts) throw error;
      wait(Math.min(10, remaining));
    }
  }
}

const WINDOWS_ACL_TIMEOUT_MS = 60000;

function stateDir() {
  return process.env.SHAPES_BRIDGE_HOME || path.join(os.homedir(), ".shapes-bridge");
}

const SYSTEM_SID = "S-1-5-18";
// Local, domain and Microsoft Entra (S-1-12-1-…) accounts.
const ACCOUNT_SID = /^S-1-\d+(-\d+)+$/i;
// Rewriting an ACL makes Windows reapply it to every file inside, so it takes
// longer the more receipts and sessions the store holds, and longer still while
// other Bridge processes do the same. The timeout is only a runaway guard:
// cutting it short refused commands on a busy store.
const windowsTool = (file, args) => spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: WINDOWS_ACL_TIMEOUT_MS, maxBuffer: 65536 });

// True only for exactly the DACL ensureStateDir grants: inheritance removed,
// full control for this account and SYSTEM, inherited by everything inside,
// and no other entry. Anything else (or anything unparsed) is rewritten.
function isPrivateWindowsAcl(sddl, sid) {
  const dacl = /D:([A-Z]*)((?:\([^()]*\))+)/.exec(typeof sddl === "string" ? sddl : "");
  if (!dacl || !dacl[1].includes("P") || typeof sid !== "string" || !ACCOUNT_SID.test(sid) || sid === SYSTEM_SID) return false;
  const trustees = new Set();
  for (const ace of dacl[2].slice(1, -1).split(")(")) {
    const [type, flags, rights, object, inherited, trustee, ...extra] = ace.split(";");
    if (type !== "A" || object || inherited || extra.length || !["fa", "0x1f01ff"].includes(String(rights).toLowerCase())) return false;
    if (typeof flags !== "string" || flags.length !== 4 || (flags.match(/../g) || []).sort().join() !== "CI,OI") return false;
    // SDDL names a few well-known accounts by alias: the built-in
    // Administrator (RID 500) is LA and the built-in Guest (RID 501) is LG.
    const who = trustee === "SY" ? SYSTEM_SID
      : (trustee === "LA" && /-500$/.test(sid)) || (trustee === "LG" && /-501$/.test(sid)) ? sid.toUpperCase()
        : trustee?.toUpperCase();
    if (who !== SYSTEM_SID && who !== sid.toUpperCase()) return false;
    trustees.add(who);
  }
  return trustees.size === 2;
}

// The directory's own DACL as SDDL. `icacls /save` without /T reads only the
// named object, so this never walks the files inside.
function windowsDirectoryAcl(dir) {
  const file = path.join(os.tmpdir(), `shapes-bridge-acl-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  try {
    if (windowsTool("icacls.exe", [dir, "/save", file, "/q"]).status !== 0) return null;
    const raw = fs.readFileSync(file);
    const text = (raw.length > 1 && raw[1] === 0 ? raw.toString("utf16le") : raw.toString("utf8")).replace(/^\uFEFF/, "");
    return text.split(/\r?\n/)[1]?.trim() || null;
  } catch { return null; }
  finally { fs.rmSync(file, { force: true }); }
}

function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  // A command supervisor is started by a Bridge process that has just secured
  // this directory and says so in the environment it hands down.
  else if (!securedWindowsDirectories.has(dir) && process.env.SHAPES_BRIDGE_STATE_SECURED !== dir) {
    // POSIX modes do not restrict Windows ACLs, particularly for a custom path.
    const identity = windowsTool("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(identity.stdout || "")?.[1];
    if (identity.status !== 0 || !sid) throw Object.assign(new Error("Could not identify the Windows account to protect computer credentials."), { code: "STATE_IDENTITY_UNAVAILABLE" });
    // Rewriting the ACL makes Windows propagate it to every file inside. Each
    // new Bridge process did that, so several starting together over a large
    // store timed each other out. An already private directory is left alone.
    if (!isPrivateWindowsAcl(windowsDirectoryAcl(dir), sid)) {
      const secured = windowsTool("icacls.exe", [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`]);
      if (secured.status !== 0) throw Object.assign(new Error("Could not make the shapes.inc Bridge directory private. Choose a directory owned by your Windows account."), { code: "STATE_PERMISSIONS_UNAVAILABLE" });
    }
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

module.exports = { stateDir, ensureStateDir, readState, writeState, removeState, replaceStateFile, isPrivateWindowsAcl, windowsDirectoryAcl };
