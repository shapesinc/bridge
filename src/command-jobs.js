"use strict";

// A receipt is committed before spawning a supervisor. An uncertain start is
// never replayed. Supervisors outlive the tunnel and own timeout/cancellation.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { stateDir, ensureStateDir } = require("./state");

const HEX = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);
const RETENTION_MS = 24 * 60 * 60 * 1000;
let ephemeralMutation = false;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error = (message, statusCode = 400, errorType = "invalid_command") => Object.assign(new Error(message), { statusCode, errorType });
const root = () => path.join(stateDir(), "command-jobs");
const jobFile = (id) => {
  if (typeof id !== "string" || !HEX.test(id)) throw error("Invalid command job ID.");
  return path.join(root(), `${id}.json`);
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
  } else fs.renameSync(temp, file);
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
  if (!TERMINAL.has(record.state) && Date.now() - record.created_at > 10000 && (!supervisor || !alive(supervisor))) {
    // The worker can finish between our first read and the liveness check.
    // Once it is dead its final save is complete; never overwrite that receipt.
    record = load(id);
    if (TERMINAL.has(record.state)) return receipt(record);
    record = { ...record, state: "interrupted", finished_at: Date.now(), result: {
      exit_code: -1, stdout: "", stderr: "The command supervisor stopped without a completion receipt. Its effects are unknown; inspect the computer before issuing another mutation.", outcome_unknown: true,
    } };
    save(record);
  }
  return receipt(record);
}

function lockFile() { return path.join(root(), "mutation.lock"); }

function release(id) {
  try {
    if (JSON.parse(fs.readFileSync(lockFile(), "utf8")).id === id) fs.unlinkSync(lockFile());
  } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
}

function claim(id, scope, metadata) {
  if (ephemeralMutation) throw error("Another computer mutation is running. Wait for its receipt.", 409, "computer_busy");
  ensureStateDir();
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(lockFile(), JSON.stringify({ id, scope, ...metadata, launcher_pid: process.pid, created_at: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (cause) {
    if (cause.code !== "EEXIST") throw cause;
    const lock = JSON.parse(fs.readFileSync(lockFile(), "utf8"));
    // A supervisor owns release; never steal a lock based on age/PID alone.
    const busy = error("Another computer mutation is running or needs reconciliation. Wait for its receipt; do not repeat or work around it.", 409, "computer_busy");
    if (lock.scope === scope && HEX.test(lock.id)) busy.jobId = lock.id;
    throw busy;
  }
}

function prune() {
  let count = 0;
  for (const name of fs.readdirSync(root())) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record = load(name.slice(0, -5));
    if (TERMINAL.has(record.state) && record.state !== "interrupted" && Date.now() - record.finished_at > RETENTION_MS) {
      for (const suffix of [".json", ".claimed", ".cancel", ".supervisor"]) fs.rmSync(path.join(root(), record.job_id + suffix), { force: true });
    } else count++;
  }
  if (count >= 256) throw error("Command receipt storage is full. Wait for completed receipts to expire before starting more commands.", 409, "command_storage_full");
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
      release(id);
      const existing = load(id);
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

function acknowledgeInterrupted(id) {
  let record;
  try { record = load(id); }
  catch (cause) {
    if (cause.errorType !== "command_not_found") throw cause;
    let lock;
    try { lock = JSON.parse(fs.readFileSync(lockFile(), "utf8")); }
    catch (lockError) { if (lockError.code === "ENOENT") throw cause; throw lockError; }
    if (lock.id !== id || !HEX.test(lock.scope) || !HEX.test(lock.fingerprint)) throw cause;
    // A launcher commits its initial receipt before spawning anything. Never
    // clear that gap while the owning process could still finish the launch.
    if (!Number.isInteger(lock.launcher_pid) || lock.launcher_pid <= 0 || alive(lock.launcher_pid)) {
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
  if (!TERMINAL.has(latest.state) || (supervisor && alive(supervisor))) {
    throw error("Only a finished or interrupted command with no live supervisor can be acknowledged locally.");
  }
  save({ ...latest, acknowledged_at: Date.now() });
  release(id);
  return receipt(latest);
}

async function mutation(run) {
  // Legacy HTTP actions live in this server process. Do not create a durable
  // lock that could outlive them; command workers use the disk lock instead.
  if (ephemeralMutation || fs.existsSync(lockFile())) throw error("Another computer mutation is running or needs reconciliation. Wait for its receipt.", 409, "computer_busy");
  ephemeralMutation = true;
  try { return await run(); } finally { ephemeralMutation = false; }
}

module.exports = { start, status, cancel, mutation, acknowledgeInterrupted, root, load, save, release, TERMINAL };
