"use strict";

// Commands have their own scoped identity. A lost HTTP response never authorizes
// replaying a shell command, and a cancelled start remains cancelled on retry.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureStateDir } = require("./state");
const { expandHome } = require("./local-workspace");
const { runCommand } = require("./command-process");

const KEY = /^[A-Za-z0-9:_-]{1,128}$/;
const ID = /^[a-f0-9]{64}$/;
const active = new Map();
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function directory() {
  const dir = path.join(ensureStateDir(), "commands");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) {
    throw failure("Command storage must be a directory owned by this account.");
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

function location(id) { return path.join(directory(), `${id}.json`); }
function save(file, row) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(row), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
}
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function validate(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !fields.includes(key)) || typeof value.scope_id !== "string" || !KEY.test(value.scope_id)) {
    throw failure("Supply a valid command scope and supported fields.");
  }
}
function publicRow(row) {
  const { scope_id, fingerprint, ...receipt } = row;
  return receipt;
}
function receipt(file, row) {
  const live = active.get(file);
  if (live) return { ...publicRow(row), ...live.process.snapshot() };
  if (!TERMINAL.has(row.state)) {
    // The old process object is gone. A saved PID is never sufficient authority
    // to signal a process in a new daemon, or proof that its side effects ended.
    row = { ...row, state: "failed", exit_code: -1, finished_at: new Date().toISOString(),
      stderr: "The computer helper restarted before confirming this command's outcome.",
      error_type: "command_interrupted", outcome_unknown: true, cleanup_confirmed: false };
    save(file, row);
  }
  return publicRow(row);
}

function startCommand(body) {
  validate(body, ["cmd", "cwd", "timeout", "scope_id", "request_key"]);
  if (typeof body.request_key !== "string" || !KEY.test(body.request_key) || typeof body.cmd !== "string" || !body.cmd.trim()
      || Buffer.byteLength(body.cmd) > 65536 || body.cwd !== undefined && typeof body.cwd !== "string"
      || body.timeout !== undefined && (!Number.isInteger(body.timeout) || body.timeout < 1 || body.timeout > 600)) {
    throw failure("Supply command text, request_key, optional cwd, and timeout from 1 to 600 seconds.");
  }
  const cwd = path.resolve(body.cwd ? expandHome(body.cwd) : process.cwd());
  const timeout = body.timeout ?? 60;
  const id = crypto.createHash("sha256").update(`${body.scope_id}\0${body.request_key}`).digest("hex");
  const file = location(id);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([body.cmd, cwd, timeout])).digest("hex");
  const old = read(file);
  if (old) {
    if (old.scope_id !== body.scope_id) throw failure("Unknown command.", 404);
    if (old.fingerprint && old.fingerprint !== fingerprint) throw failure("request_key already names a different command.", 409);
    return { ...receipt(file, old), deduplicated: true };
  }
  if (active.size >= 32) throw failure("Too many commands are running. Wait for one to finish.", 429);
  const now = Date.now();
  const row = { command_id: id, scope_id: body.scope_id, fingerprint, state: "running",
    stdout: "", stderr: "", exit_code: null, cancel_requested: false, cleanup_confirmed: false,
    started_at: new Date(now).toISOString(), finished_at: null, deadline: new Date(now + timeout * 1000).toISOString() };
  // Exclusive creation is the execution boundary, before the first side effect.
  // A competing helper must retry this id instead of launching a second child.
  try { fs.writeFileSync(file, JSON.stringify(row), { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") throw failure("Command start is being recorded. Retry the same request_key.", 409); throw error; }
  const execution = runCommand({ cmd: body.cmd, cwd, timeout });
  active.set(file, { row, process: execution });
  execution.result.then((result) => {
    const uncertain = result.stopped && !result.cleanup_confirmed;
    const state = uncertain ? "failed" : result.stopped === "cancelled" ? "cancelled" : result.stopped?.startsWith("timed out") ? "timed_out"
      : result.exit_code === 0 ? "completed" : "failed";
    Object.assign(row, { state, stdout: result.stdout, stderr: result.stderr, exit_code: result.exit_code,
      finished_at: new Date().toISOString(), cleanup_confirmed: result.cleanup_confirmed === true });
    if (uncertain) Object.assign(row, { error_type: "command_exit_unconfirmed", outcome_unknown: true });
    try { save(file, row); } finally { active.delete(file); }
  }).catch(() => {
    // A storage failure must not become an unhandled rejection or launch retry.
    active.delete(file);
  });
  return { ...publicRow(row), deduplicated: false };
}

function lookup(body) {
  validate(body, ["command_id", "scope_id"]);
  if (typeof body.command_id !== "string" || !ID.test(body.command_id)) throw failure("Supply command_id and scope_id.");
  const file = location(body.command_id), row = read(file);
  if (row && row.scope_id !== body.scope_id) throw failure("Unknown command.", 404);
  return { file, row };
}
function commandStatus(body) {
  const { file, row } = lookup(body);
  if (!row) throw failure("Unknown command.", 404);
  return receipt(file, row);
}
function cancelCommand(body) {
  const { file, row } = lookup(body);
  if (!row) {
    // Stop can overtake a delayed start request or a lost start response. The
    // deterministic ID makes that race cancel-before-start, not start-after-stop.
    const now = new Date().toISOString();
    const cancelled = { command_id: body.command_id, scope_id: body.scope_id, fingerprint: null,
      state: "cancelled", stdout: "", stderr: "cancelled before start", exit_code: -1,
      cancel_requested: true, cleanup_confirmed: true, started_at: null, finished_at: now, deadline: null };
    fs.writeFileSync(file, JSON.stringify(cancelled), { mode: 0o600, flag: "wx" });
    return publicRow(cancelled);
  }
  const live = active.get(file);
  if (live && !TERMINAL.has(live.row.state)) {
    live.row.cancel_requested = true;
    try { save(file, live.row); }
    finally { live.process.cancel(); } // A disk error must not leave the child running.
  }
  return receipt(file, live?.row || row);
}

module.exports = { startCommand, commandStatus, cancelCommand };
