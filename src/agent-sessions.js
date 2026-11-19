"use strict";

// Coding sessions in the person's own Claude Code and Codex.
//
// A session is the vendor's own persisted conversation, never a copy:
// - Claude Code: ~/.claude/projects/<folder>/<id>.jsonl. `claude --resume <id>`
//   continues it, and the Claude app imports it into its Code tab from
//   claude://resume?session=<id>.
// - Codex: a thread in ~/.codex, listed by the Codex app and `codex resume`,
//   opened by codex://threads/<id>.
// This module keeps the Bridge's record of which sessions a chat started (bound
// to a scope the shapes.inc server derives; a model never supplies it), reads
// the vendor's record of a session and checks whether the person has it open.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localEnvironment } = require("./local-workspace");
const { spawnOwned, signalOwned } = require("./owned-process");
const { closeProcessGroup } = require("./process-close");

// Claude Code session ids are UUIDv4 and Codex thread ids UUIDv7; both are
// stored and compared in canonical lowercase.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^[0-9a-f]{64}$/;
const MAX_TITLE = 80;
const MAX_MESSAGE_TEXT = 4000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

function sessionId(value) {
  if (typeof value !== "string" || !SESSION_ID.test(value.toLowerCase())) {
    const error = new Error("agent_session_id must be a session id returned by a start.");
    error.statusCode = 400;
    throw error;
  }
  return value.toLowerCase();
}

function sessionScope(value) {
  if (typeof value !== "string" || !SCOPE.test(value)) {
    const error = new Error("This session operation needs the chat's server-provided scope.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

// Shown in the person's own session lists, so: one line, no control
// characters, bounded. An empty title falls back to the task's first line.
function sessionTitle(title, prompt) {
  const clean = (value) => (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  let text = clean(title) || clean(String(prompt || "").split("\n").find((line) => line.trim()) || "");
  if (text.length > MAX_TITLE) text = `${text.slice(0, MAX_TITLE - 1).trimEnd()}…`;
  return text || "shapes.inc task";
}

// How the person opens the same session in their own app or terminal.
function openLinks(agent, id) {
  return agent === "claude"
    ? { app: "Claude", app_url: `claude://resume?session=${id}`, cli_command: `claude --resume ${id}` }
    : { app: "Codex", app_url: `codex://threads/${id}`, cli_command: `codex resume ${id}` };
}

function recordPath(directory, agent, id) {
  if (!["claude", "codex"].includes(agent)) throw new Error("Unknown local agent.");
  return path.join(directory, `${agent}-${sessionId(id)}.json`);
}

function readRecord(directory, agent, id) {
  try { return JSON.parse(fs.readFileSync(recordPath(directory, agent, id), "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}

// Either agent: ids never collide across vendors, but look both up.
function findRecord(directory, id) {
  return readRecord(directory, "claude", id) || readRecord(directory, "codex", id);
}

function listRecords(directory, scope, limit = 20) {
  let names;
  try { names = fs.readdirSync(directory).filter((name) => /^(claude|codex)-[0-9a-f-]{36}\.json$/.test(name)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const name of names.slice(0, 2000)) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      if (record.scope === scope) records.push(record);
    } catch { /* A partially written record is not listable. */ }
  }
  return records.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, limit);
}

// Bounded child process: output is kept private and capped.
function runBounded(executable, args, { cwd = os.homedir(), timeoutMs = 5000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child, timer, output = "", finished = false;
    const finish = (code, failed = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, output, failed });
    };
    const stop = () => { try { signalOwned(child, "SIGKILL"); } catch {} finish(null, true); };
    try {
      child = spawnOwned(executable, args, { cwd, env: localEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (part) => { output += part; if (output.length > maxBytes) stop(); });
      child.once("error", () => finish(null, true));
      child.once("close", (code) => finish(code));
      timer = setTimeout(stop, timeoutMs);
    } catch { finish(null, true); }
  });
}

// `claude agents --json` lists every running Claude Code session on this
// computer: terminal, background and the Claude app's Code tab. Returns null
// when it can't tell (an older Claude Code, or the check failed).
async function claudeActiveSessions(executable, options) {
  const result = await runBounded(executable, ["agents", "--json"], options);
  if (result.failed || result.code !== 0) return null;
  try {
    const entries = JSON.parse(result.output);
    if (!Array.isArray(entries)) return null;
    return entries.filter((entry) => entry && typeof entry.sessionId === "string").map((entry) => ({
      session_id: entry.sessionId.toLowerCase(), kind: typeof entry.kind === "string" ? entry.kind : null,
      status: typeof entry.status === "string" ? entry.status : typeof entry.state === "string" ? entry.state : null,
      pid: Number.isInteger(entry.pid) ? entry.pid : null,
    }));
  } catch { return null; }
}

function claudeProjectsDirectory() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

// Claude Code names a project folder after its path with every other character
// replaced by "-". Long paths are shortened, so fall back to finding the file.
function claudeTranscriptFile(id, cwd, directory = claudeProjectsDirectory()) {
  const name = `${sessionId(id)}.jsonl`;
  if (typeof cwd === "string") {
    const direct = path.join(directory, cwd.replace(/[^a-zA-Z0-9]/g, "-"), name);
    if (fs.existsSync(direct)) return direct;
  }
  let folders;
  try { folders = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
  for (const folder of folders.slice(0, 5000)) {
    if (!folder.isDirectory()) continue;
    const file = path.join(directory, folder.name, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function bounded(text) {
  const clean = String(text || "").trim();
  return clean.length > MAX_MESSAGE_TEXT ? { text: `${clean.slice(0, MAX_MESSAGE_TEXT)}…`, truncated: true } : { text: clean, truncated: false };
}

function tailLines(file, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // A partial first line.
    return { lines: lines.filter(Boolean), clipped: start > 0 };
  } finally { fs.closeSync(handle); }
}

// Messages people and agents wrote, oldest first. Tool calls, tool results,
// side chains and Claude Code's own bookkeeping lines are left out.
function claudeTranscriptMessages(file, limit) {
  const { lines, clipped } = tailLines(file);
  const messages = [];
  const byId = new Map();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || !["user", "assistant"].includes(entry.type) || entry.isSidechain || entry.isMeta || !entry.message) continue;
    const content = entry.message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
      : "";
    if (!text.trim() || (entry.type === "user" && /^<(command-name|local-command-stdout|command-message)>/.test(text.trim()))) continue;
    const key = entry.type === "assistant" && typeof entry.message.id === "string" ? entry.message.id : null;
    if (key && byId.has(key)) {
      const existing = byId.get(key);
      Object.assign(existing, bounded(`${existing.text}\n${text}`));
      continue;
    }
    const message = { role: entry.type, ...bounded(text), at: typeof entry.timestamp === "string" ? entry.timestamp : null };
    messages.push(message);
    if (key) byId.set(key, message);
  }
  return { messages: messages.slice(-limit), truncated: clipped || messages.length > limit };
}

// One short-lived Codex app-server: initialize, then the given calls in order.
async function codexAppServer(executable, cwd, calls, { timeoutMs = 20000, maxLineBytes = 8 * 1024 * 1024 } = {}) {
  const child = spawnOwned(executable, ["app-server", "--listen", "stdio://"],
    { cwd, env: localEnvironment(), detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map();
  let buffer = "", nextId = 0, failure;
  const fail = (error) => {
    failure ||= error;
    for (const { reject } of waiting.values()) reject(failure);
    waiting.clear();
  };
  child.once("error", fail);
  child.once("close", () => fail(new Error("Codex app-server exited.")));
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > maxLineBytes) { fail(new Error("Codex app-server message exceeds the output limit.")); return; }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      const call = typeof value?.id === "string" ? waiting.get(value.id) : undefined;
      if (!call) continue;
      waiting.delete(value.id);
      if (value.error) call.reject(Object.assign(new Error(`Codex app-server request failed: ${value.error.message || "unknown error"}`), { rpc: true }));
      else call.resolve(value.result);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = `bridge-read-${++nextId}`;
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const timer = setTimeout(() => fail(Object.assign(new Error("Codex app-server timed out."), { code: "CODEX_RPC_TIMEOUT" })), timeoutMs);
  try {
    await rpc("initialize", { clientInfo: { name: "shapes_bridge", title: "shapes.inc", version: "0.1.0" },
      capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const results = [];
    for (const [method, params] of calls) results.push(await rpc(method, params));
    return results;
  } finally {
    clearTimeout(timer);
    await closeProcessGroup(child).catch(() => {});
  }
}

function codexText(content) {
  return Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n") : "";
}

async function codexThreadMessages(executable, id, { cwd, limit }) {
  const [read] = await codexAppServer(executable, cwd || os.homedir(), [["thread/read", { threadId: sessionId(id), includeTurns: true }]]);
  const thread = read?.thread;
  if (!thread || typeof thread !== "object" || String(thread.id || "").toLowerCase() !== id) throw new Error("Codex returned a different thread.");
  const messages = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const text = item?.type === "userMessage" ? codexText(item.content) : item?.type === "agentMessage" ? item.text : "";
      if (typeof text !== "string" || !text.trim()) continue;
      messages.push({ role: item.type === "userMessage" ? "user" : "assistant", ...bounded(text),
        at: Number.isInteger(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : null });
    }
  }
  const last = turns.at(-1);
  return {
    messages: messages.slice(-limit), truncated: messages.length > limit,
    vendor_status: typeof thread.status?.type === "string" ? thread.status.type : null,
    last_turn_status: typeof last?.status === "string" ? last.status : null,
    vendor_title: typeof thread.name === "string" && thread.name ? thread.name : null,
  };
}

module.exports = {
  SESSION_ID, sessionId, sessionScope, sessionTitle, openLinks, recordPath, readRecord, findRecord, listRecords,
  claudeActiveSessions, claudeTranscriptFile, claudeTranscriptMessages, codexAppServer, codexThreadMessages,
  claudeProjectsDirectory,
};
