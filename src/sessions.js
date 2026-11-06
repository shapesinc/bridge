"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ensureStateDir } = require("./state");
const { expandHome } = require("./local-workspace");
const { startJob, publicStatus, listJobs, validateCwd, jobEvents, resumeContext } = require("./codex");
const { bundledRuntime, validateGateway } = require("./bundled-runtime");
const { normalizeSessionInput, sessionInputText } = require("./session-input");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function root() {
  const directory = path.join(ensureStateDir(), "sessions");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw error("Session storage must be owned by this account.");
  return directory;
}
function validateIdentity(id, scope) {
  if (!UUID.test(id || "") || typeof scope !== "string" || !scope || scope.length > 128) throw error("A valid session_id and scope_id are required.");
}
function file(id) { return path.join(root(), `${id}.json`); }
function save(session) {
  const destination = file(session.session_id), temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(session), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}
function load(id, scope) {
  validateIdentity(id, scope);
  let value;
  try { value = JSON.parse(fs.readFileSync(file(id), "utf8")); }
  catch (cause) { if (cause.code === "ENOENT") throw error("Unknown local session.", 404); throw cause; }
  if (value.scope_id !== scope) throw error("This session belongs to a different authorization scope.", 403);
  return value;
}
function status(session) {
  const latest = session.jobs.length ? publicStatus(session.jobs.at(-1)) : null;
  return { session_id: session.session_id, scope_id: session.scope_id, cwd: session.cwd, sandbox: session.sandbox,
    funding: session.funding, state: latest && !TERMINAL.has(latest.state) ? latest.state : "idle",
    created_at: session.created_at, latest_job: latest, turn_count: session.jobs.length };
}
function sessionResumeContext(session) {
  let resume = {};
  const history = [];
  for (const id of [...session.jobs].reverse()) {
    const previous = resumeContext(id);
    history.push(previous);
    if (!resume.resumeThreadId && previous.resumeThreadId) resume = {
      resumeThreadId: previous.resumeThreadId, usageBaseline: previous.usageBaseline,
    };
  }
  const delivered = new Map();
  for (const previous of history) {
    if (!resume.resumeThreadId || previous.inputDeliveredThreadId !== resume.resumeThreadId) continue;
    for (const [key, digest] of Object.entries(previous.inputContext)) if (!delivered.has(key)) delivered.set(key, digest);
  }
  return { ...resume, deliveredInputContext: Object.fromEntries(delivered) };
}
function recoverPending(session) {
  if (!session.pending_request) return;
  const found = listJobs({ requestKey: session.pending_request, limit: 1 }).jobs[0];
  if (found && !session.jobs.includes(found.job_id)) session.jobs.push(found.job_id);
  delete session.pending_request;
  save(session);
}
async function locked(id, operation) {
  const lock = path.join(root(), `${id}.lock`);
  try { fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (cause) {
    if (cause.code !== "EEXIST") throw cause;
    const pid = Number(fs.readFileSync(lock, "utf8"));
    let live = true;
    try { process.kill(pid, 0); } catch (failure) { if (failure.code === "ESRCH") live = false; }
    if (live) throw error("This session is already accepting a turn. Retry with the same request_key.", 409);
    fs.rmSync(lock, { force: true });
    return locked(id, operation);
  }
  try { return await operation(); }
  finally { fs.rmSync(lock, { force: true }); }
}

async function createSession(body) {
  validateIdentity(body?.session_id, body?.scope_id);
  if (Object.keys(body).some((key) => !["session_id", "scope_id", "cwd", "workspace_write", "funding"].includes(key))
      || typeof body.cwd !== "string" || (body.workspace_write !== undefined && typeof body.workspace_write !== "boolean")
      || body.funding !== "shapes_credits") throw error("Supply immutable cwd, workspace_write, and shapes_credits funding.");
  const sandbox = body.workspace_write ? "workspace-write" : "read-only";
  const cwd = validateCwd(expandHome(body.cwd), sandbox);
  return locked(body.session_id, () => {
    if (fs.existsSync(file(body.session_id))) {
      const existing = load(body.session_id, body.scope_id);
      if (existing.cwd !== cwd || existing.sandbox !== sandbox || existing.funding !== body.funding) throw error("This session already has different immutable settings.", 409);
      recoverPending(existing);
      return status(existing);
    }
    const session = { session_id: body.session_id, scope_id: body.scope_id, cwd, sandbox,
      funding: body.funding, created_at: new Date().toISOString(), jobs: [] };
    save(session);
    return status(session);
  });
}

async function startSessionTurn(body) {
  validateIdentity(body?.session_id, body?.scope_id);
  const hasInput = Object.hasOwn(body, "input"), hasPrompt = Object.hasOwn(body, "prompt");
  if (Object.keys(body).some((key) => !["session_id", "scope_id", "prompt", "input", "request_key", "gateway"].includes(key))
      || hasInput === hasPrompt || (hasPrompt && (typeof body.prompt !== "string" || !body.prompt.trim()))
      || typeof body.request_key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.request_key)) throw error("Supply exactly one of prompt or input, and a stable request_key for this session turn.");
  const input = hasInput ? normalizeSessionInput(body.input) : undefined;
  const prompt = input ? sessionInputText(input) : body.prompt;
  return locked(body.session_id, async () => {
    const session = load(body.session_id, body.scope_id);
    recoverPending(session);
    const grant = validateGateway(body.gateway, { sessionId: body.session_id, scopeId: body.scope_id, requestKey: body.request_key });
    // Preserve the caller's globally unique key so /agents/jobs can recover a
    // lost HTTP receipt. startJob's fingerprint also binds session and scope.
    const requestKey = body.request_key;
    const existing = listJobs({ requestKey, limit: 1 }).jobs[0];
    const last = session.jobs.length ? publicStatus(session.jobs.at(-1)) : null;
    if (!existing && last && !TERMINAL.has(last.state)) throw error("This session already has an active turn. Wait or cancel before sending another.", 409);
    if (!existing && session.jobs.length >= 5000) throw error("This session reached its local turn limit. Create a new session.", 409);
    if (!bundledRuntime().available) throw error("The built-in runtime is unavailable. Update shapes.inc on this computer.", 409);
    const { deliveredInputContext, ...resume } = sessionResumeContext(session);
    session.pending_request = requestKey;
    save(session);
    try {
      const receipt = await startJob({ prompt, ...(input ? { input, deliveredInputContext } : {}), cwd: session.cwd, sandbox: session.sandbox,
        agent: "codex", interactive: true, requestKey, ...resume,
        builtIn: { sessionId: session.session_id, scopeId: session.scope_id, gateway: grant.metadata, token: grant.token } });
      if (!session.jobs.includes(receipt.job_id)) session.jobs.push(receipt.job_id);
      delete session.pending_request;
      save(session);
      return receipt;
    } catch (cause) { recoverPending(session); throw cause; }
  });
}

function readSession(id, scope) {
  const session = load(id, scope), context = sessionResumeContext(session);
  return { ...status(session), context_thread_id: context.resumeThreadId || null,
    // Bounded discovery lets the authenticated backend avoid downloading
    // already delivered attachments. Dispatch still checks the full ledger.
    delivered_context_keys: Object.keys(context.deliveredInputContext).slice(0, 128) };
}
function sessionEvents(id, scope, cursor = "0:0") {
  const session = load(id, scope);
  if (!/^\d{1,8}:\d{1,8}$/.test(cursor)) throw error("Invalid session event cursor.");
  let [index, offset] = cursor.split(":").map(Number);
  if (index > session.jobs.length) throw error("Event cursor exceeds this session's history.");
  const events = [];
  while (index < session.jobs.length && events.length < 100) {
    const jobId = session.jobs[index], page = jobEvents(jobId, offset, 100 - events.length);
    events.push(...page.events.map((event) => ({ job_id: jobId, ...event })));
    offset = page.cursor;
    if (page.has_more || !TERMINAL.has(publicStatus(jobId).state)) break;
    index++; offset = 0;
  }
  return { session_id: id, events, cursor: `${index}:${offset}`, ...status(session) };
}

module.exports = { createSession, startSessionTurn, readSession, sessionEvents };
