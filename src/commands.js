"use strict";

// Reads and cancels scoped command receipts written by the older command format.
// New starts use command-process. A saved receipt is never a reason to replay a
// shell command, and a cancelled start remains cancelled.
const fs = require("node:fs");
const path = require("node:path");
const { ensureStateDir, replaceStateFile } = require("./state");

const KEY = /^[A-Za-z0-9:_-]{1,128}$/;
const ID = /^[a-f0-9]{64}$/;
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
  try { replaceStateFile(temp, file); }
  catch (error) { fs.rmSync(temp, { force: true }); throw error; }
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
  return receipt(file, row);
}

module.exports = { commandStatus, cancelCommand };
