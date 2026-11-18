"use strict";

// A receipt is committed before spawning a supervisor. An uncertain start is
// never replayed. Supervisors outlive the tunnel and own timeout/cancellation.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { stateDir, ensureStateDir, replaceStateFile } = require("./state");

const HEX = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);
const RETENTION_MS = 24 * 60 * 60 * 1000;
const RECEIPT_REPLACE_MS = 5000;
// Runaway guard only: how many commands may be running on this computer at
// once, across and within chats. Raise it freely; nothing else depends on it.
const MAX_RUNNING = 64;
// A finished receipt is what makes a repeated start a no-op. Keep this many;
// beyond it the oldest finished ones are dropped so new commands are never refused.
const MAX_RECEIPTS = 1024;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (message, statusCode = 400, errorType = "invalid_command") => Object.assign(new Error(message), { statusCode, errorType });
const root = () => path.join(stateDir(), "command-jobs");
const jobFile = (id) => {
  if (typeof id !== "string" || !HEX.test(id)) throw error("Invalid command job ID.");
  return path.join(root(), `${id}.json`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A PID outlives its process: Windows hands the same number to an unrelated
// program within minutes. A supervisor lives at most its command's timeout plus
// termination grace, and a launcher only the moment between taking the lock and
// saving the first receipt. Past that window a live PID belongs to someone else.
const SUPERVISOR_GRACE_MS = 60000, LAUNCH_WINDOW_MS = 60000;
function supervisorAlive(record, pid = supervisorPid(record)) {
  return Boolean(pid) && alive(pid) && Date.now() - record.created_at <= (record.command?.timeout || 600) * 1000 + SUPERVISOR_GRACE_MS;
}
function launcherPending(lock) {
  if (!Number.isFinite(lock.created_at) || Date.now() - lock.created_at > LAUNCH_WINDOW_MS) return false;
  return !Number.isInteger(lock.launcher_pid) || lock.launcher_pid <= 0 || alive(lock.launcher_pid);
}

function supervisorPid(record) {
  if (record.supervisor_pid) return record.supervisor_pid;
  try { return Number(fs.readFileSync(path.join(root(), `${record.job_id}.supervisor`), "utf8")); }
  catch (cause) { if (cause.code !== "ENOENT") throw cause; }
}

let systemdVersion;
function launchSupervisor(id) {
  let binary = process.execPath;
  let args = [path.join(__dirname, "command-worker.js"), id];
  if (process.platform === "linux" && process.env.SHAPES_BRIDGE_SYSTEMD_SERVICE === "1") {
    if (systemdVersion === undefined) {
      const version = spawnSync("systemd-run", ["--version"], { encoding: "utf8", timeout: 2000 });
      const match = /^systemd (\d+)/.exec(version.stdout || "");
      if (version.status !== 0 || !match) throw error("Cannot start an independent systemd command scope.", 503);
      systemdVersion = Number(match[1]);
    }
    // setsid/detached alone still belongs to the daemon's service cgroup.
    // A separate user scope preserves the inherited environment and owns its
    // lifecycle independently of connection restarts. Keep normal KillMode.
    args = ["--user", "--scope", "--quiet", "--collect", `--unit=shapes-bridge-command-${id}`,
      ...(systemdVersion >= 254 ? ["--expand-environment=no"] : []), "--", binary, ...args];
    binary = "systemd-run";
  }
  return spawn(binary, args, { detached: true, windowsHide: true, stdio: "ignore", env: process.env });
}

function save(record, { exclusive = false } = {}) {
  const file = jobFile(record.job_id), temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  if (exclusive) {
    // Cancel can overtake a delayed start in a second daemon. An initial write
    // must never replace its durable tombstone.
    try { fs.linkSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
  // A status poll or a scanner can hold the receipt open for a moment on
  // Windows. A failed replacement keeps the fully written temporary file:
  // settleLost() adopts it once this process is gone.
  } else replaceStateFile(temp, file, { budgetMs: RECEIPT_REPLACE_MS });
}

const LOST = "The command supervisor stopped without a completion receipt.";
// A supervisor that could not replace its receipt leaves the complete record
// beside it. That file is local proof of what happened, so the lock need not
// wait for the owner: a terminal record is the real result, and a "running"
// record over a still-queued receipt means the shell was never started.
function settleLost(record) {
  const supervisor = supervisorPid(record);
  if (!supervisor || supervisorAlive(record, supervisor)) return null;
  const lost = record.state === "interrupted" && !record.acknowledged_at && String(record.result?.stderr || "").startsWith(LOST);
  if (TERMINAL.has(record.state) && !lost) return null;
  let pending;
  const temp = `${jobFile(record.job_id)}.${supervisor}.tmp`;
  try { pending = JSON.parse(fs.readFileSync(temp, "utf8")); }
  catch (cause) { if (cause.code === "ENOENT" || cause instanceof SyntaxError) return null; throw cause; }
  if (pending?.job_id !== record.job_id || pending.scope !== record.scope || pending.fingerprint !== record.fingerprint) return null;
  let settled;
  if (TERMINAL.has(pending.state)) settled = pending;
  else if (pending.state === "running" && (record.state === "queued" || (lost && !record.started_at))) {
    settled = { ...record, state: "failed", finished_at: Date.now(), result: { exit_code: -1, stdout: "",
      stderr: "The command did not start: its supervisor could not record the start. Nothing ran.", cleanup_confirmed: true } };
  } else return null;
  save(settled);
  fs.rmSync(temp, { force: true });
  if (settled.state !== "interrupted") release(settled.job_id);
  return settled;
}

// A marker says "this command is running". Once the command's supervisor (or,
// before a first receipt, its launcher) is gone, nothing of ours is still
// running it: on Windows the kernel Job dies with that process, and on POSIX
// its process groups were already signalled. The marker is then removed here
// without the owner. The receipt keeps its unknown outcome and the request is
// never replayed. True when the marker is gone.
function settle(entry) {
  if (!entry.id) {
    // Unreadable: a launcher that died while writing it, or a damaged
    // mutation.lock. Nothing can be running behind it once the launch window passed.
    try { if (Date.now() - fs.statSync(entry.file).mtimeMs > LAUNCH_WINDOW_MS) fs.rmSync(entry.file, { force: true }); }
    catch (cause) { if (cause.code !== "ENOENT") throw cause; }
    return !fs.existsSync(entry.file);
  }
  try { settleLost(load(entry.id)); } catch { /* No receipt, or no local proof: fall through. */ }
  if (!fs.existsSync(entry.file)) return true;
  try { acknowledgeInterrupted(entry.id, { automatic: true }); } catch { return false; }
  return !fs.existsSync(entry.file);
}

// Every command still running, after clearing the markers of those that are gone.
function running() {
  return markerFiles().map(readMarker).filter((entry) => entry && !settle(entry));
}

function load(id) {
  try { return JSON.parse(fs.readFileSync(jobFile(id), "utf8")); }
  catch (cause) { if (cause.code === "ENOENT") throw error("Command job not found.", 404, "command_not_found"); throw cause; }
}

function receipt(record) {
  const { job_id, state, created_at, started_at, finished_at, command_hash, result, cancel_requested } = record;
  return { job_id, state, created_at, started_at, finished_at, command_hash,
    ...(result || {}), ...(cancel_requested ? { cancel_requested: true } : {}) };
}

function status(id, scope) {
  if (typeof scope !== "string" || !HEX.test(scope)) throw error("A trusted command scope is required.", 403);
  let record = load(id);
  if (record.scope !== scope) throw error("Command job not found.", 404, "command_not_found");
  const supervisor = supervisorPid(record);
  if (TERMINAL.has(record.state)) return receipt(settleLost(record) || record);
  if (Date.now() - record.created_at > 10000 && !supervisorAlive(record, supervisor)) {
    // The worker can finish between our first read and the liveness check.
    // Once it is dead its final save is complete; never overwrite that receipt.
    record = load(id);
    if (TERMINAL.has(record.state)) return receipt(record);
    const settled = settleLost(record);
    if (settled) return receipt(settled);
    record = { ...record, state: "interrupted", finished_at: Date.now(), result: {
      exit_code: -1, stdout: "", stderr: `${LOST} Its effects are unknown; inspect the computer before issuing another mutation.`, outcome_unknown: true,
    } };
    save(record);
  }
  return receipt(record);
}

// Commands do not wait for each other: any number of chats, and any number of
// commands in one chat, run side by side. running/<job>.json marks a command
// that is running, only so the runaway guard can count them and so a command
// whose supervisor died gets its receipt settled.
// mutation.lock is the single whole-computer lock written by Bridge 0.2.11 and
// earlier. It is never written now. One left by a command that was running
// across the update is treated as that command's marker and no longer stops
// anything else.
const legacyLockFile = () => path.join(root(), "mutation.lock");
const runningDir = () => path.join(root(), "running");

function markerFiles() {
  const files = fs.existsSync(legacyLockFile()) ? [legacyLockFile()] : [];
  let names = [];
  try { names = fs.readdirSync(runningDir()); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
  for (const name of names.sort()) if (/^[a-f0-9]{64}\.json$/.test(name)) files.push(path.join(runningDir(), name));
  return files;
}

// `id` is null when the file cannot be parsed.
function readMarker(file) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (cause) { if (cause.code === "ENOENT") return null; }
  const valid = Boolean(lock) && typeof lock.id === "string" && HEX.test(lock.id);
  return { file, id: valid ? lock.id : null, lock: valid ? lock : null };
}

function release(id) {
  fs.rmSync(path.join(runningDir(), `${id}.json`), { force: true });
  try { if (JSON.parse(fs.readFileSync(legacyLockFile(), "utf8")).id === id) fs.unlinkSync(legacyLockFile()); }
  catch (cause) { if (cause.code !== "ENOENT" && !(cause instanceof SyntaxError)) throw cause; }
}

// Read-only view of what is running, for the local owner. Markers whose
// command is gone are cleared first.
function pendingLocks() {
  return running().map(({ id, lock, file }) => {
    if (!id) return { job_id: null, state: "starting", running: true, created_at: null, file };
    let record;
    try { record = load(id); }
    catch (cause) { if (cause.errorType !== "command_not_found") throw cause; }
    if (!record) return { job_id: id, state: "starting", created_at: lock.created_at ?? null, running: true };
    return { job_id: id, state: record.state, created_at: record.created_at, running: true };
  });
}

const LIMIT = `This computer is already running ${MAX_RUNNING} commands. Wait for one to finish, then send this again.`;
const busy = () => Object.assign(error(LIMIT, 409, "computer_busy"), { busyReason: "limit" });

// Take a place for this command. It never waits for another command; the only
// refusal is the runaway guard.
function claim(id, scope, metadata) {
  ensureStateDir();
  fs.mkdirSync(runningDir(), { recursive: true, mode: 0o700 });
  if (running().length >= MAX_RUNNING) throw busy();
  // The same start arriving twice at once is settled by the exclusive receipt
  // write that follows, not here: whoever loses that reads the winner's receipt.
  try { fs.writeFileSync(path.join(runningDir(), `${id}.json`), JSON.stringify({ id, scope, ...metadata, launcher_pid: process.pid, created_at: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (cause) { if (cause.code !== "EEXIST") throw cause; return; }
  // Two Bridge processes can each see one free place and both take it. Counting
  // again after writing means the guard is never exceeded.
  if (running().length > MAX_RUNNING) { release(id); throw busy(); }
}

function prune() {
  const kept = [];
  for (const name of fs.readdirSync(root())) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record = load(name.slice(0, -5));
    const finished = TERMINAL.has(record.state);
    if (finished && record.state !== "interrupted" && Date.now() - record.finished_at > RETENTION_MS) forget(record.job_id);
    else kept.push({ id: record.job_id, finished, at: record.finished_at || record.created_at || 0 });
  }
  const droppable = kept.filter((entry) => entry.finished).sort((a, b) => a.at - b.at);
  for (let extra = kept.length - MAX_RECEIPTS + 1; extra > 0 && droppable.length; extra--) forget(droppable.shift().id);
}
function forget(id) {
  for (const suffix of [".json", ".claimed", ".cancel", ".supervisor", ".worker-error"]) fs.rmSync(path.join(root(), id + suffix), { force: true });
}

async function start(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["cmd", "cwd", "timeout", "shell", "scope", "request_key"].includes(key))
      || typeof body.cmd !== "string" || !body.cmd.trim() || body.cmd.length > 100000
      || (body.cwd !== undefined && typeof body.cwd !== "string")
      || !Number.isInteger(body.timeout) || body.timeout < 1 || body.timeout > 600
      || (body.shell !== undefined && !["powershell", "cmd", "sh"].includes(body.shell))
      || typeof body.scope !== "string" || !HEX.test(body.scope)
      || typeof body.request_key !== "string" || !HEX.test(body.request_key)) throw error("Supply cmd, timeout (1–600), trusted scope/request_key, and optional cwd/shell.");
  const id = digest([body.scope, body.request_key]);
  const fingerprint = digest([body.cmd, body.cwd || null, body.timeout, body.shell || null]);
  try {
    const existing = load(id);
    if (existing.fingerprint && existing.fingerprint !== fingerprint) throw error("The command request key was reused for different arguments.", 409, "command_conflict");
    return { ...status(id, body.scope), deduplicated: true };
  } catch (cause) { if (cause.errorType !== "command_not_found") throw cause; }
  claim(id, body.scope, { fingerprint, command_hash: digest(body.cmd) });
  let record, launched = false;
  try {
    prune();
    record = { job_id: id, scope: body.scope, fingerprint, command_hash: digest(body.cmd),
      command: body, state: "queued", created_at: Date.now(), launcher_pid: process.pid };
    try { save(record, { exclusive: true }); }
    catch (cause) {
      if (cause.code !== "EEXIST") throw cause;
      // A cancel tombstone or the same start from another process got there
      // first. A tombstone means nothing runs; a twin start owns the marker.
      const existing = load(id);
      if (TERMINAL.has(existing.state)) release(id);
      if (existing.scope !== body.scope || existing.fingerprint && existing.fingerprint !== fingerprint) throw error("The command request key was reused for different arguments.", 409, "command_conflict");
      return { ...status(id, body.scope), deduplicated: true };
    }
    const child = launchSupervisor(id);
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    launched = true;
    fs.writeFileSync(path.join(root(), `${id}.supervisor`), String(child.pid), { mode: 0o600 });
    child.unref();
    return receipt(record);
  } catch (cause) {
    if (launched) throw error("Command supervisor started but its launch receipt could not be saved. Poll the existing job; do not repeat it.", 503, "command_start_unconfirmed");
    try {
      if (record && fs.existsSync(jobFile(id)) && load(id).state === "queued") save({ ...record, state: "failed", finished_at: Date.now(), result: { exit_code: -1, stdout: "", stderr: "Command supervisor could not start.", cleanup_confirmed: true } });
    } finally { release(id); }
    throw cause;
  }
}

function cancel(id, scope) {
  if (typeof scope !== "string" || !HEX.test(scope)) throw error("A trusted command scope is required.", 403);
  jobFile(id); // Validate before constructing any filename.
  let result;
  try { result = status(id, scope); }
  catch (cause) {
    if (cause.errorType !== "command_not_found") throw cause;
    // A wrong scope must never overwrite an existing receipt. If no receipt
    // exists, a scoped tombstone makes a late/lost start safely non-executable.
    let existing;
    try { existing = load(id); }
    catch (missing) { if (missing.errorType !== "command_not_found") throw missing; }
    if (existing) throw error("Command job not found.", 404, "command_not_found");
    ensureStateDir(); fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    prune();
    const now = Date.now();
    const record = { job_id: id, scope, fingerprint: null, command_hash: null,
      state: "cancelled", created_at: now, finished_at: now, cancel_requested: true,
      result: { exit_code: -1, stdout: "", stderr: "cancelled before start", cleanup_confirmed: true, cancelled_before_start: true } };
    try { save(record, { exclusive: true }); return receipt(record); }
    catch (race) { if (race.code !== "EEXIST") throw race; }
    result = status(id, scope);
  }
  if (TERMINAL.has(result.state)) return result;
  fs.writeFileSync(path.join(root(), `${id}.cancel`), "cancel", { mode: 0o600 });
  return { ...result, cancel_requested: true };
}

function acknowledgeInterrupted(id, { automatic = false } = {}) {
  let record;
  try { record = load(id); }
  catch (cause) {
    if (cause.errorType !== "command_not_found") throw cause;
    const lock = markerFiles().map(readMarker).find((entry) => entry?.id === id)?.lock;
    if (!lock || !HEX.test(lock.scope) || !HEX.test(lock.fingerprint)) throw cause;
    // A launcher commits its initial receipt before spawning anything. Never
    // clear that gap while the owning process could still finish the launch.
    if (launcherPending(lock)) {
      throw error("An orphan command lock with a live launcher cannot be acknowledged locally.");
    }
    record = { job_id: id, scope: lock.scope, fingerprint: lock.fingerprint,
      command_hash: lock.command_hash, created_at: lock.created_at,
      state: "interrupted", finished_at: Date.now(), result: {
        exit_code: -1, stdout: "", stderr: "The launcher stopped before saving the first command receipt. The owner reconciled its orphan lock locally; this request will not run again.", outcome_unknown: true,
      } };
    // Commit a tombstone before releasing the lock so the same request key
    // cannot become a fresh command, even if acknowledgement is interrupted.
    save(record);
  }
  status(id, record.scope);
  const latest = load(id);
  const supervisor = supervisorPid(latest);
  if (!TERMINAL.has(latest.state) || supervisorAlive(latest, supervisor)) {
    throw error("Only a finished or interrupted command with no live supervisor can be acknowledged locally.");
  }
  save({ ...latest, acknowledged_at: Date.now(), ...(automatic ? { released_automatically: true } : {}) });
  release(id);
  return receipt(latest);
}

module.exports = { start, status, cancel, acknowledgeInterrupted, pendingLocks, root, load, save, release, TERMINAL, MAX_RUNNING, MAX_RECEIPTS };
