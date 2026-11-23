"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { selectAgent, argumentsFor, verifyInteractiveCodex, claudePermissionMode } = require("./agents");
const agentImages = require("./agent-images");
const { normalizeRequest, nativeResponse } = require("./approvals");
const { localEnvironment } = require("./local-workspace");
const { agentEnvironment } = require("./login-shell-env");
const { bundledRuntime, launchConfiguration } = require("./bundled-runtime");
const { spawnOwned, signalOwned } = require("./owned-process");
const { createNativeToolProxy } = require("./native-tool-proxy");
const { createToolBroker } = require("./native-tool-broker");
const { closeProcessGroup } = require("./process-close");
const { replaceStateFile } = require("./state");
const { normalizeSessionInput, runtimeSessionInput } = require("./session-input");
const sessions = require("./agent-sessions");

const MAX_OUTPUT = 64 * 1024;
const MAX_PROMPT = 64 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Only inspect failed native tool results. A page or an agent's prose can quote
// a denial without establishing that the runtime actually refused an action.
function isCodexPermissionDenial(item) {
  if (item?.type !== "mcp_tool_call" || item.server !== "cua_repl" || item.status !== "failed") return false;
  const content = item.result?.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === "text" && typeof part.text === "string" && (
    part.text.startsWith("Browser Use rejected this action due to browser security policy.")
    || /^Computer Use is not allowed to use the app '[^'\n]+' for safety reasons\.$/.test(part.text.trim())
  ));
}

const FAILURE_HINTS = [
  ["auth_required", /not logged in|unauthori[sz]ed|\b401\b|invalid api key|authenticat|log ?in again|sign ?in again|token (?:has )?expired|refresh token/i,
    (name) => `Sign in to ${name} on this computer again, then retry.`],
  ["usage_limit", /usage limit|rate limit|\b429\b|quota|too many requests|credit balance|out of credits/i,
    (name) => `The ${name} account on this computer hit a usage or rate limit. Wait for it to reset or check its plan, then retry.`],
  ["model_unavailable", /unknown model|invalid model|model\b[^.]{0,80}\b(?:not (?:found|supported|available)|does not exist|unsupported)/i,
    (name) => `The model configured for ${name} on this computer is unavailable. Choose a supported model in its settings, then retry.`],
  ["network_error", /stream disconnected|\bnetwork\b(?!\s+access)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection (?:error|refused|reset)|failed to connect|could not resolve/i,
    (name) => `${name} could not reach its service from this computer. Check the internet connection, then retry.`],
];

// Agent-reported errors are short, user-facing messages; stdout/stderr logs
// stay private. Credentials, long opaque values, home paths and email
// addresses are removed regardless: the quote can reach a group chat.
function sanitizeAgentError(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\b(?:sk|rk|pk|sess)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    // A URL's user:password, up to the last @ before its host.
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/]*@/g, "$1[redacted]@")
    // An Authorization value whatever its scheme; elsewhere "Basic" needs a credential-shaped value ("Basic plan" stays).
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)((?:basic|bearer|digest|token)\s+)?[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(basic)\s+(?=[A-Za-z0-9+/]*[\d=])[A-Za-z0-9+/]{8,}={0,2}/gi, "$1 [redacted]")
    .replace(/\b([A-Za-z0-9_-]*(?:token|key|password|passwd|secret))(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)[^\s/\\"']+/g, "~")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

// Claude result text can be model prose, so it is only classified, never quoted.
function failureReason({ agent, agentError, exitCode, signal, errorType, funding }) {
  const name = agentName(agent);
  const funded = funding === "shapes_credits";
  const reported = sanitizeAgentError(agentError);
  if (reported) {
    // Classify the raw text: redaction can remove the words a hint needs.
    const hint = FAILURE_HINTS.find(([, pattern]) => pattern.test(agentError));
    const advice = funded ? ({
      auth_required: "Retry the task or contact shapes.inc support.",
      usage_limit: "Check shapes.inc credits or retry later.",
      model_unavailable: "Retry later or contact shapes.inc support.",
      network_error: "Check your internet connection, then retry.",
    }[hint?.[0]] || "Retry the task or restart shapes.inc.")
      : hint ? hint[2](name) : `Open ${name} on this computer to check the problem, then retry.`;
    return { errorType: errorType || "agent_error",
      error: agent === "claude" ? `${name} reported an error before finishing. ${advice}` : `${name} reported: "${reported}". ${advice}` };
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return { errorType: errorType || "process_error",
      error: `${name} exited with code ${exitCode} before reporting a result. ${funded ? "Retry the task or restart shapes.inc." : `Open ${name} on this computer to check that it is signed in and up to date, then retry.`}` };
  }
  if (signal) {
    return { errorType: errorType || "process_error",
      error: `${name} was stopped by ${signal} before reporting a result. Make sure nothing on this computer is closing it, then retry.` };
  }
  return { errorType: errorType || "missing_completion",
    error: `${name} exited without finishing the task. ${funded ? "Update shapes.inc, then retry." : `Update ${name} on this computer, then retry.`}` };
}

function privateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Agent job storage must be a directory owned by the current user, not a symlink.");
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

function root() {
  return privateDir(path.resolve(process.env.SHAPES_CODEX_JOB_DIR || path.join(os.homedir(), ".shapes-bridge", "codex-jobs")));
}

function sessionsDirectory() { return privateDir(path.join(root(), "sessions")); }

function jobDir(id) {
  if (!UUID.test(id)) throw new Error("Invalid job ID.");
  const directory = path.join(root(), id);
  if (!fs.existsSync(directory)) throw new Error("Unknown job ID.");
  return privateDir(directory);
}

// Job files are replaced whole. On Windows a status reader in another process
// can hold the file for a moment and make the replacement fail;
// replaceStateFile waits that out within a bounded budget. If it still fails,
// this process's temporary file is removed so its next write (the terminal
// receipt, say) is not refused because the temporary name is taken.
const JOB_FILE_REPLACE_MS = 2000;
function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  try { replaceStateFile(temporary, file, { budgetMs: JOB_FILE_REPLACE_MS }); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function saveState(directory, state) {
  writePrivate(path.join(directory, "state.json"), JSON.stringify(state));
}

function loadState(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
}

// Any folder the person points at, as their own CLI would take it. Whether to
// branch, use a worktree or touch a sibling repository is the agent's call
// under the person's own settings and instructions, not this Bridge's: a
// worktree rule here boxed in Claude Code (2026-11-22, "you lobotomized my
// claude").
function validateCwd(value) {
  if (!value || !path.isAbsolute(value)) throw new Error("--cwd must be an explicit absolute directory.");
  const cwd = onDiskPath(value);
  if (!fs.statSync(cwd).isDirectory()) throw new Error("--cwd must be a directory.");
  return cwd;
}

// The folder as it is spelled on disk. macOS and Windows open
// "/applications/shapesinc/app" as /Applications/shapesinc/app, but Claude Code,
// Codex and the Claude app key sessions and saved permission modes by the exact
// spelling. The native lookup gives that spelling (and Windows' long names for
// short ones like RUNNER~1); symlinks resolve as before. A mapped Windows drive
// that comes back as its network share keeps the drive the person named.
function onDiskPath(value, realpath = fs.realpathSync) {
  const resolved = realpath(value);
  let native;
  try { native = realpath.native(value); } catch { return resolved; }
  if (typeof native !== "string" || !native || (/^[a-z]:/i.test(resolved) && !/^[a-z]:/i.test(native))) return resolved;
  return native;
}

const REQUEST_KEY = /^[A-Za-z0-9_-]{16,128}$/;

function agentName(agent) { return agent === "claude" ? "Claude Code" : "Codex"; }

function requestFile(requestKey) {
  const directory = privateDir(path.join(root(), "requests"));
  return path.join(directory, `${crypto.createHash("sha256").update(requestKey).digest("hex")}.json`);
}

function readRequest(requestKey) {
  try { return JSON.parse(fs.readFileSync(requestFile(requestKey), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function validRequestKey(value) {
  if (value !== undefined && (typeof value !== "string" || !REQUEST_KEY.test(value))) {
    throw new Error("request_key must be 16-128 letters, digits, '-' or '_'.");
  }
  return value;
}

// A job that failed before its runner started never executed anything, so the
// same request may run again; any job that started is returned instead.
function neverRan(id) {
  try {
    const state = loadState(jobDir(id));
    return !state.startedAt && getStatus(id).state === "failed";
  } catch { return true; }
}

function existingRequest(requestKey, fingerprint) {
  const existing = readRequest(requestKey);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) {
    const error = new Error("This request_key already belongs to a different task. Use a new request_key for a new task.");
    error.statusCode = 409;
    throw error;
  }
  return neverRan(existing.job_id) ? null : existing.job_id;
}

// Bind a request key to one job atomically. Returns the existing job ID when a
// concurrent retry of the same request already claimed it.
function claimRequest(requestKey, id, fingerprint) {
  const file = requestFile(requestKey);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ job_id: id, fingerprint }), { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.linkSync(temporary, file); return null; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const existing = existingRequest(requestKey, fingerprint);
      if (existing) return existing;
      fs.rmSync(file, { force: true });
    }
    throw new Error("This task is being started by another request. List recent jobs to find it before retrying.");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The Bridge's record of a session this chat started: which scope may use it,
// its folder and its latest turn. The vendor keeps the conversation itself.
function saveSessionRecord({ agent, id, scope, cwd, sandbox, title, startedBy, jobId, executable }) {
  const directory = sessionsDirectory();
  const existing = sessions.readRecord(directory, agent, id);
  if (existing && existing.scope !== scope) throw Object.assign(new Error("Unknown session for this chat."), { statusCode: 404 });
  const now = new Date().toISOString();
  writePrivate(sessions.recordPath(directory, agent, id), JSON.stringify({
    agent, agent_session_id: id, scope, cwd, sandbox, title: existing?.title || title || null,
    started_by: existing ? existing.started_by ?? null : startedBy ?? null,
    created_at: existing?.created_at || now, updated_at: now, last_job_id: jobId,
    turns: (existing?.turns || 0) + 1, ...(executable ? { executable } : {}),
  }));
}

function sessionReceipt(agent, id, title) {
  if (!id) return {};
  return { agent_session_id: id, ...(title ? { session_title: title } : {}), open: sessions.openLinks(agent, id) };
}

function publicStatus(id, expectedAgent) {
  const { diagnostics_directory, diagnostics_available, ...receipt } = getStatus(id, expectedAgent);
  return receipt;
}

async function startJob({ promptFile, prompt: suppliedPrompt, input: suppliedInput, deliveredInputContext, cwd, sandbox = "read-only", timeoutSeconds = 1800, agent = "codex", interactive = false, requestKey, builtIn, resumeThreadId, usageBaseline,
  sessionScope, title, startedBy, resumeSessionId, preselected, images: suppliedImages }) {
  if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("Unsupported sandbox.");
  // Already validated by the route; normalized again for direct callers.
  const images = Array.isArray(suppliedImages) && suppliedImages.every((image) => Buffer.isBuffer(image?.bytes))
    ? suppliedImages : agentImages.normalizeImages(suppliedImages);
  if (images.length && builtIn) throw new Error("Images go to a built-in session through its typed input.");
  // A session start or turn: the same Claude Code session or Codex thread the
  // person sees in their own apps, bound to the chat's server-derived scope.
  if (sessionScope !== undefined) {
    sessions.sessionScope(sessionScope);
    if (builtIn) throw new Error("Built-in sessions have their own continuation.");
  }
  if (resumeSessionId !== undefined && (sessionScope === undefined || sessions.sessionId(resumeSessionId) !== resumeSessionId)) {
    throw new Error("A session turn needs its session id and scope.");
  }
  if (title !== undefined && (typeof title !== "string" || title.length > 400)) throw new Error("title must be short text.");
  if (startedBy !== undefined && (typeof startedBy !== "string" || startedBy.length > 80)) throw new Error("started_by must be short text.");
  cwd = validateCwd(cwd);
  const timeout = Number(timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) throw new Error("Timeout must be between 1 and 86400 seconds.");
  if (promptFile && suppliedPrompt !== undefined) throw new Error("Supply a prompt or a prompt file, not both.");
  let prompt = suppliedPrompt;
  if (prompt === undefined) {
    if (!promptFile) throw new Error("--prompt-file is required.");
    const promptStat = fs.statSync(promptFile);
    if (!promptStat.isFile() || promptStat.size > MAX_PROMPT) throw new Error("Prompt must be a regular file no larger than 64 KiB.");
    prompt = fs.readFileSync(promptFile, "utf8");
  }
  if (typeof prompt !== "string" || Buffer.byteLength(prompt) > MAX_PROMPT) throw new Error("Prompt must be text no larger than 64 KiB.");
  if (!prompt.trim()) throw new Error("Prompt must not be empty.");
  if (suppliedInput !== undefined && !builtIn) throw new Error("Typed input requires a built-in session.");
  const input = suppliedInput === undefined ? undefined : normalizeSessionInput(suppliedInput);
  if (typeof interactive !== "boolean") throw new Error("interactive must be boolean.");
  validRequestKey(requestKey);
  const sessionTitle = sessionScope && !resumeSessionId ? sessions.sessionTitle(title, prompt) : undefined;
  const fingerprint = requestKey && crypto.createHash("sha256")
    .update(JSON.stringify([prompt, cwd, sandbox, timeout, agent, interactive,
      ...(builtIn ? [builtIn.sessionId, builtIn.scopeId, builtIn.gateway.model] : []),
      ...(input ? [input] : []),
      ...(sessionScope ? [sessionScope, resumeSessionId || null, sessionTitle || null] : [])])).digest("hex");
  if (requestKey && fs.existsSync(root())) {
    const existing = existingRequest(requestKey, fingerprint);
    if (existing) return { ...publicStatus(existing), deduplicated: true };
  }
  // Idempotency uses the complete packet above. Only a genuinely new job may
  // omit source items already acknowledged on this session's resumed thread.
  const preparedInput = input ? runtimeSessionInput(input, deliveredInputContext) : undefined;
  let selected;
  if (builtIn) {
    const runtime = bundledRuntime();
    if (!runtime.available) throw new Error("The built-in runtime is unavailable. Update shapes.inc on this computer.");
    selected = { ...runtime, id: "codex" };
  } else selected = preselected || await selectAgent(agent, cwd);
  agent = selected.id;
  // Session Codex threads always use the app-server: `codex exec` threads are
  // left out of the Codex app's thread list and can't be continued here.
  interactive = (interactive || selected.transport === "bundled_personal" || Boolean(sessionScope)) && agent === "codex";
  if (interactive && !builtIn) await verifyInteractiveCodex(selected, cwd);
  // Claude Code write runs ask the person through this Bridge instead of
  // skipping permissions, in the person's own permission mode; read-only runs
  // (only when the person asked for no changes) stay limited to read-only tools.
  const claudeHost = agent === "claude" && sandbox === "workspace-write" && selected.hostPrompts === true;
  // Every Claude Code write run uses the person's own mode, with or without host prompts.
  const permissionMode = agent === "claude" && sandbox === "workspace-write"
    ? claudePermissionMode(cwd, { autoMode: selected.autoMode }) : undefined;
  if (claudeHost) interactive = true;
  const executable = selected.executable;
  const id = crypto.randomUUID();
  // Claude Code takes the session id up front, so the session is bound before
  // it runs; a Codex thread id is known once the app-server starts it.
  const agentSessionId = resumeSessionId || (sessionScope && agent === "claude" ? crypto.randomUUID() : undefined);
  const directory = privateDir(path.join(root(), id));
  const savedImages = agentImages.saveImages(directory, images, writePrivate);
  const state = { id, status: "queued", cwd, sandbox, agent, interactive, createdAt: new Date().toISOString(),
    ...(savedImages.length ? { images: savedImages.length } : {}),
    ...(claudeHost ? { claudeHost: true } : {}),
    ...(selected.transport === "bundled_personal" ? { funding: "personal", runtimeVersion: selected.version, personalTransport: selected.transport } : {}),
    ...(builtIn ? { sessionId: builtIn.sessionId, scopeId: builtIn.scopeId, funding: "shapes_credits", runtimeVersion: selected.version,
      ...(usageBaseline ? { runtimeUsageTotal: usageBaseline } : {}) } : {}),
    ...(sessionScope ? { sessionScope, ...(agentSessionId ? { agentSessionId } : {}), ...(resumeSessionId ? { resumedSession: true } : {}) } : {}),
    promptPreview: prompt.trim().replace(/\s+/g, " ").slice(0, 160) };
  writePrivate(path.join(directory, "request.json"), JSON.stringify({ prompt, cwd, sandbox, timeout, executable, agent, interactive,
    ...(savedImages.length ? { images: savedImages } : {}),
    ...(input ? { input, ...preparedInput } : {}),
    ...(selected.transport === "bundled_personal" ? { personalProfile: selected.profile } : {}),
    ...(builtIn ? { gateway: builtIn.gateway, resumeThreadId, usageBaseline } : {}),
    // The person's own Codex picks a model this account offers.
    ...(!builtIn && agent === "codex" && selected.transport !== "bundled_personal" ? { pickAvailableModel: true } : {}),
    ...(claudeHost ? { claudeHost: true } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(sessionScope ? { sessionScope, title: sessionTitle, startedBy, agentSessionId, resumeSessionId,
      ...(agent === "claude" && selected.nameFlag ? { nameFlag: true } : {}) } : {}) }));
  saveState(directory, state);
  if (requestKey) {
    let existing;
    try { existing = claimRequest(requestKey, id, fingerprint); }
    catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
    if (existing) {
      fs.rmSync(directory, { recursive: true, force: true });
      return { ...publicStatus(existing), deduplicated: true };
    }
  }
  if (sessionScope && agentSessionId) {
    try { saveSessionRecord({ agent, id: agentSessionId, scope: sessionScope, cwd, sandbox, title: sessionTitle, startedBy, jobId: id, executable }); }
    catch (error) {
      Object.assign(state, { status: "failed", error: error.message, errorType: "session_unavailable", finishedAt: new Date().toISOString() });
      saveState(directory, state);
      throw Object.assign(error, { jobId: id });
    }
  }
  // The job is durably queued and listable from here on; a launch failure is
  // recorded on it so a status or list call explains what happened.
  try {
    const child = spawnOwned(process.execPath, [path.join(__dirname, "../bin/codex.js"), "_supervise", id], {
      // Durable jobs outlive a short CLI start request. On Windows the native
      // app's enclosing Job still owns the full runtime and every nested job.
      parentPid: null, detached: true, stdio: "ignore", // Profile sign-in settings are for the person's own agents, never a credits-funded built-in session.
      env: { ...(builtIn ? localEnvironment() : agentEnvironment()), SHAPES_CODEX_JOB_DIR: root(),
        ...(builtIn ? { SHAPES_RUNTIME_TOKEN: builtIn.token, SHAPES_NATIVE_TOOL_TOKEN: builtIn.toolToken || "" } : {}) },
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } catch (error) {
    const message = `The local job runner could not be launched (${error.code || "spawn failed"}), so the task did not run. Restart shapes.inc Bridge on this computer, then start the task again.`;
    Object.assign(state, { status: "failed", error: message, errorType: "process_error", finishedAt: new Date().toISOString() });
    saveState(directory, state);
    const failure = new Error(message);
    failure.jobId = id;
    throw failure;
  }
  return { job_id: id, state: "queued", cwd, sandbox, agent, interactive, created_at: state.createdAt,
    ...(savedImages.length ? { images: savedImages.length } : {}),
    ...(builtIn ? { session_id: builtIn.sessionId, funding: "shapes_credits", runtime_version: selected.version } : {}),
    ...(sessionScope ? sessionReceipt(agent, agentSessionId, resumeSessionId ? sessions.readRecord(sessionsDirectory(), agent, agentSessionId)?.title : sessionTitle) : {}),
    ...(agent === "claude" ? { permission_scope: claudeScope(sandbox, claudeHost) } : {}) };
}

// Read-only tools; the person's own Claude Code permissions with approvals
// asked in chat; or (older Claude Code) their own permissions, prompts denied.
function claudeScope(sandbox, host) {
  if (sandbox === "read-only") return "read-only-tools";
  return host ? "ask-in-chat" : "own-settings";
}

function listJobs({ requestKey, limit = 10, agent } = {}) {
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("limit must be between 1 and 50.");
  validRequestKey(requestKey);
  const base = root();
  let ids;
  if (requestKey) {
    const mapping = readRequest(requestKey);
    ids = mapping && UUID.test(mapping.job_id || "") ? [mapping.job_id] : [];
  } else {
    ids = fs.readdirSync(base).filter((name) => UUID.test(name)).map((name) => {
      try { return { name, time: fs.statSync(path.join(base, name, "state.json")).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.time - a.time).slice(0, 200).map((item) => item.name);
  }
  const jobs = [];
  for (const id of ids) {
    try {
      const status = getStatus(id);
      if (agent && status.agent !== agent) continue;
      const state = loadState(jobDir(id));
      jobs.push({
        job_id: id, state: status.state, agent: status.agent, interactive: status.interactive, cwd: status.cwd,
        sandbox: status.sandbox, created_at: status.created_at, finished_at: status.finished_at,
        error: status.error, error_type: status.error_type, thread_id: status.thread_id,
        ...(status.agent_session_id ? { agent_session_id: status.agent_session_id } : {}),
        task_preview: typeof state.promptPreview === "string" ? state.promptPreview : null,
      });
    } catch { /* A partially written or removed job is not listable. */ }
  }
  jobs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return { jobs: jobs.slice(0, count) };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readOutput(directory, name) {
  try { return fs.readFileSync(path.join(directory, name), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

// Cap encoded fields, including JSON escapes, so /run's output limit cannot
// chop the status response into invalid JSON.
function bounded(value, budget, tail = false) {
  let text = value;
  while (Buffer.byteLength(JSON.stringify(text)) > budget) {
    const count = Math.max(1, Math.ceil(text.length / 4));
    text = tail ? text.slice(count) : text.slice(0, -count);
  }
  return text;
}

function getStatus(id, expectedAgent) {
  const directory = jobDir(id);
  let state = loadState(directory);
  const agent = state.agent || "codex";
  if (expectedAgent && agent !== expectedAgent) throw new Error("This job belongs to a different local agent.");
  // The supervisor can save its terminal state and exit between our read and
  // the liveness check. Once it is gone its last save is complete, so read
  // again before calling the job lost.
  if (!TERMINAL.has(state.status) && state.supervisorPid && !alive(state.supervisorPid)) state = loadState(directory);
  if (!TERMINAL.has(state.status)) {
    let lost = false;
    if (state.supervisorPid) {
      lost = !alive(state.supervisorPid) && (state.startedAt
        ? "The local job runner stopped before the agent reported a result, for example because the bridge restarted or the computer shut down. The task may have made partial changes; review them before starting it again."
        : "The local job runner stopped before the task began, so it did not run. Start it again.");
    } else if (Date.now() - Date.parse(state.createdAt) > 30000) {
      lost = "The local job runner never started, so the task did not run. Restart shapes.inc Bridge on this computer, then start the task again.";
    }
    if (lost) {
      state.status = "failed";
      state.error = lost;
      state.errorType = "process_error";
      state.finishedAt = new Date().toISOString();
    }
  }
  const final = readOutput(directory, "result.txt");
  const finalResult = bounded(final, 8000);
  return {
    job_id: id, state: state.status, agent, interactive: state.interactive === true,
    ...(state.sessionId ? { session_id: state.sessionId, funding: state.funding, runtime_version: state.runtimeVersion, usage: state.usage || null } : {}),
    final: finalResult, error: state.error ? bounded(state.error, 1000) : null,
    cwd: state.cwd, sandbox: state.sandbox, thread_id: typeof state.threadId === "string" ? bounded(state.threadId, 512) : null,
    ...(state.sessionScope ? sessionReceipt(agent, state.agentSessionId) : {}),
    ...(typeof state.modelNote === "string" ? { model_note: state.modelNote } : {}),
    // What the agent actually got and ran under: how many of the person's
    // images, and Claude Code's own permission mode from its init event.
    ...(Number.isInteger(state.images) ? { images: state.images } : {}),
    ...(typeof state.permissionMode === "string" ? { permission_mode: bounded(state.permissionMode, 40) } : {}),
    ...(state.activity?.text ? { activity: { text: bounded(state.activity.text, 400), at: state.activity.at } } : {}),
    ...(Array.isArray(state.deniedActions) && state.deniedActions.length ? { denied_actions: state.deniedActions.slice(0, 10) } : {}),
    started_at: state.startedAt || null,
    created_at: state.createdAt, finished_at: state.finishedAt || null,
    exit_code: state.exitCode ?? null,
    error_type: state.errorType || null,
    permission_denials: state.permissionDenials || 0,
    ...(state.errorType === "permission_denied" && state.status === "failed"
      ? { needs_user_action: true } : {}),
    ...(agent === "claude" ? { permission_scope: claudeScope(state.sandbox, state.claudeHost) } : {}),
    cancel_requested: fs.existsSync(path.join(directory, "cancel")),
    diagnostics_available: fs.existsSync(path.join(directory, "stdout.log")) || fs.existsSync(path.join(directory, "stderr.log")),
    diagnostics_directory: directory,
    output_truncated: Boolean(state.stdoutTruncated || state.stderrTruncated || state.resultTruncated || finalResult !== final),
    // Display one pending prompt at a time, keeping receipts bounded. The next
    // native request becomes visible after the current one is answered.
    ...(state.interactive ? { pending_requests: TERMINAL.has(state.status) ? [] : (state.pendingRequests || []).slice(0, 1) } : {}),
  };
}

function respondJob(id, requestId, response) {
  const directory = jobDir(id);
  const state = getStatus(id);
  if (!UUID.test(requestId || "") || state.state !== "waiting_on_user" || state.cancel_requested
      || !state.pending_requests?.some((request) => request.id === requestId)) {
    const error = new Error("This request is no longer waiting for a response.");
    error.statusCode = 409;
    throw error;
  }
  const request = JSON.parse(fs.readFileSync(path.join(directory, `${requestId}.request.json`), "utf8"));
  // Validate against the original native schema, not fields supplied by a caller.
  const result = nativeResponse(request.native, request.display, response);
  const file = path.join(directory, `${requestId}.response.json`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ result, cancel: response.decision === "cancel" }), { mode: 0o600, flag: "wx" });
    fs.linkSync(temporary, file); // Atomic publication, and only the first response wins.
  } catch (error) {
    if (error.code === "EEXIST") { error.statusCode = 409; error.message = "This request already has a response."; }
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { job_id: id, request_id: requestId, accepted: true };
}

function cancelJob(id, expectedAgent) {
  const directory = jobDir(id);
  const state = getStatus(id, expectedAgent);
  if (!TERMINAL.has(state.state)) writePrivate(path.join(directory, "cancel"), "cancel\n");
  return { job_id: id, state: state.state, agent: state.agent, cancel_requested: !TERMINAL.has(state.state) || state.cancel_requested };
}

// --- Sessions: the person's own Claude Code sessions and Codex threads -----
// Each operation names a session by its vendor id plus the scope the server
// derived for this chat. A record from another scope is "unknown", the same
// answer as no record, so a chat can't probe for another chat's sessions.

function scopedRecord(agentSessionId, sessionScope, expectedAgent) {
  const id = sessions.sessionId(agentSessionId);
  const scope = sessions.sessionScope(sessionScope);
  if (expectedAgent !== undefined && !["claude", "codex"].includes(expectedAgent)) throw new Error("agent must be codex or claude.");
  const record = sessions.findRecord(sessionsDirectory(), id);
  if (!record || record.scope !== scope) {
    throw Object.assign(new Error("No session with that id was started from this chat on this computer."), { statusCode: 404, errorType: "unknown_session" });
  }
  // A task bound to one agent (say, the person's saved Codex) never reaches the other's session.
  if (expectedAgent && record.agent !== expectedAgent) {
    throw Object.assign(new Error("That session belongs to the other local agent."), { statusCode: 409, errorType: "session_agent_mismatch" });
  }
  return record;
}

function lastTurn(record) {
  if (!UUID.test(record.last_job_id || "")) return null;
  try { return publicStatus(record.last_job_id, record.agent); } catch { return null; }
}

// The executable that ran the session, if it is still there; otherwise the
// current install. Reads and checks never need a fresh sign-in probe.
async function sessionExecutable(record) {
  try {
    if (record.executable && fs.statSync(record.executable).isFile()) return record.executable;
  } catch {}
  return (await selectAgent(record.agent, record.cwd)).executable;
}

// One turn at a time per session, inside this Bridge process.
const sessionLocks = new Map();
async function withSessionLock(id, work) {
  const previous = sessionLocks.get(id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  sessionLocks.set(id, chained);
  await previous;
  try { return await work(); }
  finally { release(); if (sessionLocks.get(id) === chained) sessionLocks.delete(id); }
}

// Is the person (or anything else) running this Claude Code session right now,
// outside the turn this Bridge runs? null means Claude Code couldn't say.
// Asked only when this Bridge runs no turn of the session, so any running
// process with this session id is the person's (or another tool's).
async function claudeOpenElsewhere(record) {
  const active = await sessions.claudeActiveSessions(await sessionExecutable(record));
  if (!active) return null;
  return active.some((entry) => entry.session_id === record.agent_session_id);
}

async function sendTurn({ agentSessionId, sessionScope, prompt, requestKey, sandbox, agent, images }) {
  const record = scopedRecord(agentSessionId, sessionScope, agent);
  if (sandbox !== undefined && !["read-only", "workspace-write"].includes(sandbox)) throw new Error("Unsupported sandbox.");
  return withSessionLock(record.agent_session_id, async () => {
    const fresh = scopedRecord(record.agent_session_id, sessionScope);
    const previous = lastTurn(fresh);
    if (previous && !TERMINAL.has(previous.state)) {
      // A retry of the turn already running returns it instead of a refusal.
      if (requestKey) {
        const mapped = readRequest(validRequestKey(requestKey));
        if (mapped?.job_id === previous.job_id) return { ...previous, deduplicated: true };
      }
      throw Object.assign(new Error("This session is still working on its last message. Wait for it, or stop it, before sending another."),
        { statusCode: 409, errorType: "session_busy", jobId: previous.job_id });
    }
    const selected = await selectAgent(fresh.agent, fresh.cwd);
    if (fresh.agent === "claude" && await claudeOpenElsewhere({ ...fresh, executable: selected.executable })) {
      throw Object.assign(new Error("This Claude Code session is open on this computer right now (in the Claude app or a terminal). Continue it there, or close it there first."),
        { statusCode: 409, errorType: "session_open_elsewhere" });
    }
    return startJob({ prompt, cwd: fresh.cwd, sandbox: sandbox || fresh.sandbox, agent: fresh.agent,
      interactive: fresh.agent === "codex", requestKey, sessionScope, resumeSessionId: fresh.agent_session_id, preselected: selected, images });
  });
}

async function sessionStatus({ agentSessionId, sessionScope }) {
  const record = scopedRecord(agentSessionId, sessionScope);
  const turn = lastTurn(record);
  const running = turn && !TERMINAL.has(turn.state);
  let openElsewhere = null;
  // While this Bridge's own turn runs, the session is busy either way; only
  // an idle session needs Claude Code's list of open sessions.
  if (record.agent === "claude" && !running) {
    try { openElsewhere = await claudeOpenElsewhere(record); } catch { openElsewhere = null; }
  }
  return {
    agent_session_id: record.agent_session_id, agent: record.agent, title: record.title, cwd: record.cwd,
    sandbox: record.sandbox, started_by: record.started_by, created_at: record.created_at, updated_at: record.updated_at,
    turns: record.turns || 0,
    state: running ? (turn.state === "waiting_on_user" ? "waiting_on_user" : "running") : "idle",
    last_turn: turn ? { job_id: turn.job_id, state: turn.state, final: turn.final, error: turn.error, error_type: turn.error_type,
      created_at: turn.created_at, finished_at: turn.finished_at, ...(turn.model_note ? { model_note: turn.model_note } : {}) } : null,
    // Claude Code only: the session is running in the person's Claude app or a
    // terminal, beyond this Bridge's own turn. Codex can't report this.
    open_elsewhere: openElsewhere,
    open: sessions.openLinks(record.agent, record.agent_session_id),
  };
}

async function readSession({ agentSessionId, sessionScope, limit = 10, agent }) {
  const record = scopedRecord(agentSessionId, sessionScope, agent);
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("limit must be between 1 and 30.");
  let read;
  if (record.agent === "claude") {
    const file = sessions.claudeTranscriptFile(record.agent_session_id, record.cwd);
    read = file ? sessions.claudeTranscriptMessages(file, count) : { messages: [], truncated: false, not_saved_yet: true };
  } else {
    try { read = await sessions.codexThreadMessages(await sessionExecutable(record), record.agent_session_id, { cwd: record.cwd, limit: count }); }
    catch (error) {
      throw Object.assign(new Error("Codex could not read this thread right now. Check that Codex is installed and signed in, then retry."),
        { statusCode: 502, errorType: "session_read_failed" });
    }
  }
  return { agent_session_id: record.agent_session_id, agent: record.agent, title: record.title,
    source: record.agent === "claude" ? "claude_code_session" : "codex_thread", ...read,
    open: sessions.openLinks(record.agent, record.agent_session_id) };
}

function stopSession({ agentSessionId, sessionScope }) {
  const record = scopedRecord(agentSessionId, sessionScope);
  const turn = lastTurn(record);
  if (!turn || TERMINAL.has(turn.state)) {
    return { agent_session_id: record.agent_session_id, agent: record.agent, stopped: false, state: "idle",
      ...(turn ? { job_id: turn.job_id } : {}) };
  }
  const cancelled = cancelJob(turn.job_id, record.agent);
  return { agent_session_id: record.agent_session_id, agent: record.agent, stopped: cancelled.cancel_requested === true,
    job_id: turn.job_id, state: cancelled.state, cancel_requested: cancelled.cancel_requested };
}

function listSessions({ sessionScope, limit = 10 }) {
  const scope = sessions.sessionScope(sessionScope);
  const count = Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > 30) throw new Error("limit must be between 1 and 30.");
  return { sessions: sessions.listRecords(sessionsDirectory(), scope, count).map((record) => {
    const turn = lastTurn(record);
    return { agent_session_id: record.agent_session_id, agent: record.agent, title: record.title, cwd: record.cwd,
      started_by: record.started_by, updated_at: record.updated_at, turns: record.turns || 0,
      state: turn && !TERMINAL.has(turn.state) ? "running" : "idle", last_job_id: turn?.job_id || null,
      open: sessions.openLinks(record.agent, record.agent_session_id) };
  }) };
}

async function superviseInteractive(directory, state, request) {
  const { createCodexRpcSession } = require("./codex-rpc");
  const pending = new Map();
  let stopped, failed = false, timer, poll, session, toolProxy, toolBroker, resourceClosure;
  const logs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const persist = () => {
    state.pendingRequests = [...pending.values()].map((value) => value.display);
    if (!stopped) state.status = pending.size ? "waiting_on_user" : "running";
    saveState(directory, state);
  };
  const clearRequest = (nativeId) => {
    for (const [id, value] of pending) {
      if (value.native.id !== nativeId) continue;
      pending.delete(id);
      fs.rmSync(path.join(directory, `${id}.request.json`), { force: true });
      fs.rmSync(path.join(directory, `${id}.response.json`), { force: true });
    }
    persist();
  };
  const closeResources = () => {
    // Run both independent closures even if private-file cleanup or a transport
    // rejects. A rejected close must not skip the owned runtime's cancellation.
    if (!resourceClosure) resourceClosure = Promise.allSettled([
      Promise.resolve().then(() => toolBroker ? toolBroker.close() : toolProxy?.close()),
      Promise.resolve().then(() => session?.close()),
    ]);
    return resourceClosure;
  };
  const stop = (status) => {
    if (stopped) return;
    stopped = status;
    void closeResources();
  };
  const onSignal = () => stop("cancelled");
  Object.assign(state, { supervisorPid: process.pid, status: "running", startedAt: new Date().toISOString() });
  persist();
  try {
    if (fs.existsSync(path.join(directory, "cancel"))) { stopped = "cancelled"; return; }
    if (request.gateway) toolProxy = createNativeToolProxy({ gateway: request.gateway, token: process.env.SHAPES_NATIVE_TOOL_TOKEN,
      getContext: () => ({ threadId: session?.threadId, turnId: session?.turnId }) });
    if (toolProxy?.definitions.length) {
      toolBroker = await createToolBroker(toolProxy);
      state.toolBrokerDirectory = toolBroker.directory;
      persist();
    }
    const runtimeConfig = request.gateway ? launchConfiguration(request.gateway) : {};
    if (toolBroker) runtimeConfig.launchArgs.push(...toolBroker.launchArgs);
    session = createCodexRpcSession({
      executable: request.executable, cwd: request.cwd, sandbox: request.sandbox,
      ...(request.personalProfile ? require("./personal-codex").personalConfiguration(request.personalProfile) : {}),
      ...(request.gateway ? { ...runtimeConfig, resumeThreadId: request.resumeThreadId, usageBaseline: request.usageBaseline } : {
        ...(request.resumeSessionId ? { resumeThreadId: request.resumeSessionId } : { threadName: request.title }),
        pickAvailableModel: request.pickAvailableModel === true,
      }),
      startupRetries: request.gateway ? 1 : 0,
      onLifecycle(value) {
        state.runtimeStartup = { ...value, at: new Date().toISOString() };
        // The retry owns a new process; retain the actual PID for diagnostics.
        state.agentPid = session?.child?.pid;
        persist();
        if (state.sessionId) appendJobEvent(directory, { type: "runtime.startup", ...state.runtimeStartup });
      },
      onEvent(value) {
        if (request.gateway) value = redactRuntimeValue(value);
        if (!request.gateway) noteActivity(directory, state, value);
        if (state.sessionId) appendJobEvent(directory, value);
        if (value.type === "usage.updated") { state.usage = value.usage; state.runtimeUsageTotal = value.total_usage; persist(); }
        if (value.type === "thread.started") {
          state.threadId = value.thread_id;
          if (request.sessionScope) bindSession(state, request, value.thread_id);
          persist();
        }
        if (value.type === "model.substituted") {
          state.modelNote = `Codex's configured model ${value.configured} isn't offered on this account, so this turn used ${value.model}, the account's default.`;
          persist();
        }
        if (value.type === "input.delivered" && request.input) {
          state.inputDelivered = true;
          state.inputDeliveredThreadId = value.thread_id;
          state.inputContext = request.inputContext || {};
          persist();
        }
        if (value.type === "item.completed" && isCodexPermissionDenial(value.item)) {
          state.permissionDenials = (state.permissionDenials || 0) + 1;
          state.errorType = "permission_denied";
          failed = true;
          persist();
        }
        if (value.type === "turn.failed") {
          failed = true;
          if (typeof value.error?.message === "string" && value.error.message.trim()) state.agentError = value.error.message.slice(0, 4000);
        }
        if (value.type === "item.completed" && value.item?.type === "agent_message") {
          const result = Buffer.from(value.item.text || "");
          state.resultTruncated = result.length > MAX_OUTPUT;
          writePrivate(path.join(directory, "result.txt"), result.subarray(0, MAX_OUTPUT));
        }
      },
      onDiagnostic(kind, chunk) {
        if (!Object.prototype.hasOwnProperty.call(logs, kind)) return;
        if (request.gateway && process.env.SHAPES_RUNTIME_TOKEN) chunk = Buffer.from(String(chunk).split(process.env.SHAPES_RUNTIME_TOKEN).join("[redacted]"));
        const combined = Buffer.concat([logs[kind], Buffer.from(chunk)]);
        if (combined.length > MAX_OUTPUT) state[`${kind}Truncated`] = true;
        logs[kind] = combined.subarray(Math.max(0, combined.length - MAX_OUTPUT));
        writePrivate(path.join(directory, `${kind}.log`), request.gateway ? redactRuntimeValue(logs[kind].toString()) : logs[kind]);
      },
      onServerRequest(native) {
        try {
          if (request.gateway) native = redactRuntimeValue(native);
          if (stopped || pending.size >= 16 || Buffer.byteLength(JSON.stringify(native)) > 128 * 1024) throw new Error("Unsupported approval request.");
          const display = normalizeRequest(native);
          pending.set(display.id, { native, display });
          writePrivate(path.join(directory, `${display.id}.request.json`), JSON.stringify({ native, display }));
          persist();
        } catch {
          failed = true;
          state.errorType = "unsupported_approval";
          state.error = "This request requires approval in the local app. The computer task stopped without granting it.";
          stop("failed");
        }
      },
      onRequestResolved({ id: nativeId }) { clearRequest(nativeId); },
    });
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    poll = setInterval(() => {
      if (fs.existsSync(path.join(directory, "cancel"))) { stop("cancelled"); return; }
      if (stopped) return;
      for (const [id, value] of pending) {
        const file = path.join(directory, `${id}.response.json`);
        if (!fs.existsSync(file)) continue;
        try {
          const response = JSON.parse(fs.readFileSync(file, "utf8"));
          if (response.cancel) { stop("cancelled"); return; }
          session.respond(value.native.id, response.result);
          clearRequest(value.native.id);
        } catch {
          failed = true;
          state.error = "The local agent could not accept the response. The task stopped.";
          stop("failed");
        }
      }
    }, 100);
    timer = setTimeout(() => stop("timed_out"), request.timeout * 1000);
    const completion = session.start(request.runtimeInput || request.input
      || (request.images?.length ? agentImages.codexInput(request.prompt, request.images) : request.prompt));
    state.agentPid = session.child?.pid;
    persist();
    const result = await completion;
    Object.assign(state, { usage: result.usage, ...(result.totalUsage ? { runtimeUsageTotal: result.totalUsage } : {}), exitCode: result.exitCode, signal: result.signal });
    if (result.status !== "completed") failed = true;
    if (typeof result.error?.message === "string" && result.error.message.trim()) state.agentError ||= redactRuntimeValue(result.error.message).slice(0, 4000);
  } catch (error) {
    // Not the agent's own report: never quote it (it can carry local paths).
    // A cancel or deadline closes the session on purpose, and a permission
    // denial keeps its own explanation.
    failed = true;
    if (!stopped && !state.error && !state.agentError && state.errorType !== "permission_denied") {
      const startupTimeout = error.code === "CODEX_RPC_TIMEOUT" && ["initialize", "thread_start", "turn_start"].includes(error.phase);
      Object.assign(state, { errorType: startupTimeout ? "startup_timeout" : "process_error",
        error: startupTimeout ? (error.phase === "initialize"
          ? "The runtime could not initialize in time. No task was sent to the model. Restart shapes.inc on this computer and try again."
          : "The runtime timed out while starting the task. It was not automatically retried. Check the task status before trying again.")
          : request.gateway ? "The built-in runtime stopped before reporting a result. Retry the task or restart shapes.inc on this computer."
          : "Codex stopped before reporting a result. Check that Codex is installed, signed in and up to date on this computer, then retry; if it keeps happening, restart shapes.inc Bridge." });
    }
  } finally {
    clearInterval(poll); clearTimeout(timer);
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    const [transportClosure, processClosure] = await closeResources();
    if (transportClosure.status === "rejected") {
      stopped = "failed";
      state.errorType = "tool_transport_cleanup_unconfirmed";
      state.error = "The local capability transport could not finish cleanup. Check this computer and read operation receipts before retrying an action.";
    }
    if (processClosure.status === "rejected" || processClosure.value?.processExited === false) {
      stopped = "failed";
      state.errorType = "process_exit_unconfirmed";
      state.error = "The local agent was asked to stop, but its exit could not be confirmed. Check this computer before starting another task.";
    }
    for (const value of [...pending.values()]) clearRequest(value.native.id);
    state.pendingRequests = [];
    state.status = stopped || (failed ? "failed" : "completed");
    state.finishedAt = new Date().toISOString();
    if (state.status === "failed" && state.errorType === "permission_denied") state.error = "The local agent was blocked by tool permissions.";
    else if (state.status === "failed" && !state.error) Object.assign(state, failureReason({ agent: "codex", funding: state.funding, agentError: state.agentError, exitCode: state.exitCode, signal: state.signal, errorType: state.errorType }));
    // The terminal state is the job's last write: whoever sees it can rely
    // on the complete event history (and may remove the job directory).
    if (state.sessionId) appendJobEvent(directory, { type: "job.finished", state: state.status });
    saveState(directory, state);
  }
}

function redactRuntimeValue(value) {
  const tokens = [process.env.SHAPES_RUNTIME_TOKEN, process.env.SHAPES_NATIVE_TOOL_TOKEN].filter(Boolean);
  if (!tokens.length) return value;
  const clean = text => tokens.reduce((result, token) => result.split(token).join("[redacted]"), text);
  if (typeof value === "string") return clean(value);
  return JSON.parse(clean(JSON.stringify(value)));
}

function appendJobEvent(directory, value) {
  const file = path.join(directory, "events.jsonl");
  if (fs.existsSync(file) && fs.statSync(file).size >= 8 * 1024 * 1024) return;
  let encoded = JSON.stringify(value);
  encoded = redactRuntimeValue(encoded);
  if (Buffer.byteLength(encoded) > 32768) encoded = JSON.stringify({ type: value.type, truncated: true,
    item: value.item ? { id: value.item.id, type: value.item.type, status: value.item.status,
      text: String(value.item.text || "").slice(0, 4000) } : undefined });
  encoded = redactRuntimeValue(encoded);
  fs.appendFileSync(file, encoded + "\n", { mode: 0o600 });
}

function jobEvents(id, cursor = 0, limit = 100) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid event cursor or limit.");
  const file = path.join(jobDir(id), "events.jsonl");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").slice(0, -1) : [];
  if (cursor > lines.length) throw new Error("Event cursor exceeds available history.");
  const events = lines.slice(cursor, cursor + limit).map((line) => JSON.parse(line));
  return { events, cursor: cursor + events.length, has_more: cursor + events.length < lines.length };
}

function resumeContext(id) {
  const state = loadState(jobDir(id));
  return { resumeThreadId: state.threadId, usageBaseline: state.runtimeUsageTotal,
    inputDeliveredThreadId: state.inputDelivered ? state.inputDeliveredThreadId : undefined,
    inputContext: state.inputDelivered ? state.inputContext || {} : {} };
}

// "What it's doing now" for the chat's task card: one short line from the
// agent's own stream (a step it named, a command, a file), never its private
// reasoning. Saved at most every two seconds.
// A command's program name only ("Running git"): commands can carry secrets
// and the line can reach a group chat.
function commandName(command) {
  let text = Array.isArray(command) ? command.join(" ") : String(command || "");
  text = text.replace(/^\s*(?:\S*[\\/])?(?:ba|z|da)?sh(?:\.exe)?\s+-\w*c\s+['"]?/i, "");
  const token = text.trim().split(/\s+/).find((part) => part && !part.includes("=")) || "";
  const name = path.basename(token.replace(/['"`]/g, ""));
  return /^[A-Za-z0-9._+-]{1,40}$/.test(name) ? `Running ${name}` : "Running a command";
}

// How a denied action is named in receipts: the agent's own description of a
// command, or the file's name; never the raw command or full path.
function deniedSummary(tool, input) {
  const value = input && typeof input === "object" ? input : {};
  if (typeof value.description === "string" && value.description.trim()) return value.description;
  if (tool === "Bash") return commandName(value.command);
  const file = value.file_path || value.notebook_path;
  if (typeof file === "string" && file) return `Editing ${path.basename(file)}`;
  return "";
}

function activityLine(value) {
  const short = (text, limit = 160) => String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const base = (file) => path.basename(String(file || ""));
  if (value?.type === "system" && value.subtype === "task_started") return short(value.description);
  // API errors the CLI streams as synthetic assistant messages are not a step.
  if (value?.type === "assistant" && Array.isArray(value.message?.content) && !value.error && value.message?.model !== "<synthetic>") {
    for (const block of [...value.message.content].reverse()) {
      if (block?.type === "tool_use") {
        const input = block.input || {};
        if (block.name === "Bash") return short(input.description || commandName(input.command));
        if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(block.name)) return short(`Editing ${base(input.file_path || input.notebook_path)}`);
        if (block.name === "Read") return short(`Reading ${base(input.file_path)}`);
        if (["Grep", "Glob"].includes(block.name)) return "Searching the code";
        if (block.name === "Task" || block.name === "Agent") return short(input.description || "Working on a subtask");
        return short(`Using ${block.name}`);
      }
      if (block?.type === "text" && block.text?.trim()) return short(block.text.split(/(?<=[.!?])\s/)[0]);
    }
  }
  const item = value?.item;
  if (value?.type === "item.started" && item?.type === "command_execution") return commandName(item.command);
  if (value?.type === "item.started" && item?.type === "file_change") return "Editing files";
  if (value?.type === "item.completed" && item?.type === "agent_message" && item.text?.trim()) return short(item.text.split(/(?<=[.!?])\s/)[0]);
  return "";
}

function noteActivity(directory, state, value) {
  const text = activityLine(value);
  if (!text || state.activity?.text === text) return;
  state.activity = { text, at: new Date().toISOString() };
  const now = Date.now();
  if (!state.activitySavedAt || now - state.activitySavedAt > 2000) { state.activitySavedAt = now; saveState(directory, state); }
}

// The vendor reported its session id. A new Codex thread registers here; if a
// resumed Claude Code session continued under a new id, the record follows it
// so later turns keep reaching the conversation the person sees.
function bindSession(state, request, reported) {
  const id = typeof reported === "string" ? reported.toLowerCase() : "";
  if (!sessions.SESSION_ID.test(id) || state.agentSessionId === id) return;
  const previous = state.agentSessionId;
  state.agentSessionId = id;
  try {
    const record = previous ? sessions.readRecord(sessionsDirectory(), state.agent, previous) : null;
    saveSessionRecord({ agent: state.agent, id, scope: request.sessionScope, cwd: request.cwd, sandbox: request.sandbox,
      title: record?.title || request.title, startedBy: record?.started_by ?? request.startedBy, jobId: state.id, executable: request.executable });
  } catch { /* The receipt still carries the vendor id. */ }
}

async function supervise(id) {
  const directory = jobDir(id);
  // A second supervisor invocation must never start the same task twice.
  try {
    const lock = fs.openSync(path.join(directory, "supervisor.lock"), "wx", 0o600);
    fs.writeSync(lock, String(process.pid));
    fs.closeSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") return;
    throw error;
  }
  const state = loadState(directory);
  const request = JSON.parse(fs.readFileSync(path.join(directory, "request.json"), "utf8"));
  const agent = request.agent || "codex";
  if (agent === "codex" && request.interactive) return superviseInteractive(directory, state, request);
  let child;
  let poll;
  let deadline;
  let shutdown, finishExit;
  let stopped;
  let turnCompleted = false;
  let turnFailed = false;
  let lineBuffer = "";
  const decoder = new StringDecoder("utf8");
  const logs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  // Claude Code approvals (`can_use_tool`) waiting for the person in the chat.
  const pending = new Map();
  const persistPending = () => {
    state.pendingRequests = [...pending.values()].map((entry) => entry.display);
    if (!stopped) state.status = pending.size ? "waiting_on_user" : "running";
    saveState(directory, state);
  };
  let inputClosed = false;
  const sendControl = (value) => { if (inputClosed) return; try { child.stdin.write(JSON.stringify(value) + "\n"); } catch {} };
  const addDenied = ({ tool, summary, by }) => {
    const entry = { tool: String(tool || "tool").slice(0, 80), summary: String(summary || "").replace(/\s+/g, " ").trim().slice(0, 300),
      ...(by ? { by } : {}) };
    const list = state.deniedActions || [];
    if (!list.some((item) => item.tool === entry.tool && item.summary === entry.summary) && list.length < 10) state.deniedActions = [...list, entry];
  };
  function clearHostRequest(id) {
    if (!pending.delete(id)) return;
    fs.rmSync(path.join(directory, `${id}.request.json`), { force: true });
    fs.rmSync(path.join(directory, `${id}.response.json`), { force: true });
    persistPending();
  }
  function hostRequest(value) {
    const ask = value.request || {};
    // After the turn's result stdin is closed: an answer could never arrive, so never show the request.
    if (inputClosed) return;
    if (ask.subtype !== "can_use_tool" || typeof value.request_id !== "string") {
      sendControl({ type: "control_response", response: { subtype: "error", request_id: value.request_id, error: "Not supported here." } });
      return;
    }
    const native = { method: "claude/canUseTool", params: { tool_name: ask.tool_name, input: ask.input, description: ask.description, cwd: request.cwd } };
    let display;
    try {
      if (stopped || pending.size >= 16) throw new Error("No room for another approval.");
      display = normalizeRequest(native);
    } catch {
      // Never approve what the chat can't show; the agent hears why.
      sendControl({ type: "control_response", response: { subtype: "success", request_id: value.request_id,
        response: { behavior: "deny", message: "This approval couldn't be shown in the shapes.inc chat. Continue without it, or say what you need." } } });
      addDenied({ tool: ask.tool_name, summary: deniedSummary(ask.tool_name, ask.input) });
      try { saveState(directory, state); } catch {}
      return;
    }
    try {
      pending.set(display.id, { native, display, requestId: value.request_id });
      writePrivate(path.join(directory, `${display.id}.request.json`), JSON.stringify({ native, display }));
      persistPending();
    } catch {
      // Unsaved means nobody can answer it: deny now rather than leave Claude Code waiting.
      pending.delete(display.id);
      sendControl({ type: "control_response", response: { subtype: "success", request_id: value.request_id,
        response: { behavior: "deny", message: "This approval couldn't be shown in the shapes.inc chat. Continue without it, or say what you need." } } });
      addDenied({ tool: ask.tool_name, summary: deniedSummary(ask.tool_name, ask.input) });
    }
  }
  const killGroup = (signal) => {
    if (child && child.pid) {
      signalOwned(child, signal);
    }
  };
  const stop = (status) => {
    if (stopped) return;
    stopped = status;
    shutdown = closeProcessGroup(child).then((result) => { finishExit?.(result); return result; });
  };
  const finish = (status, detail = {}) => {
    clearInterval(poll); clearTimeout(deadline);
    for (const id of pending.keys()) {
      fs.rmSync(path.join(directory, `${id}.request.json`), { force: true });
      fs.rmSync(path.join(directory, `${id}.response.json`), { force: true });
    }
    pending.clear();
    Object.assign(state, detail, { status, pendingRequests: [], finishedAt: new Date().toISOString() });
    saveState(directory, state);
  };
  function capture(kind, chunk) {
    const combined = Buffer.concat([logs[kind], chunk]);
    if (combined.length > MAX_OUTPUT) state[`${kind}Truncated`] = true;
    logs[kind] = combined.subarray(Math.max(0, combined.length - MAX_OUTPUT));
    writePrivate(path.join(directory, `${kind}.log`), logs[kind]);
  }
  function event(line) {
    try {
      const value = JSON.parse(line);
      if (agent === "claude") {
        if (value.type === "control_request" && request.claudeHost) { hostRequest(value); return; }
        if (value.type === "control_cancel_request" && request.claudeHost) {
          for (const [id, entry] of pending) if (entry.requestId === value.request_id) clearHostRequest(id);
          return;
        }
        noteActivity(directory, state, value);
        if (value.type === "system" && value.subtype === "init" && typeof value.session_id === "string") {
          state.threadId = value.session_id;
          if (typeof value.permissionMode === "string") state.permissionMode = value.permissionMode.slice(0, 40);
          if (request.sessionScope) bindSession(state, request, value.session_id);
        }
        // A denied action is a fact about the run, not its outcome: the agent
        // often works around it and finishes. The result decides.
        if (value.type === "system" && value.subtype === "permission_denied") {
          state.permissionDenials = (state.permissionDenials || 0) + 1;
        }
        if (value.type === "assistant" && !turnCompleted && !value.parent_tool_use_id && !value.error
            && value.message?.model !== "<synthetic>") {
          // The latest thing it said (its own words, not a subagent's or an API error)
          // survives a stop, a crash or a lost result.
          const text = (value.message?.content || []).filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim();
          if (text) {
            const bytes = Buffer.from(text);
            state.resultTruncated = bytes.length > MAX_OUTPUT;
            writePrivate(path.join(directory, "result.txt"), bytes.subarray(0, MAX_OUTPUT));
          }
        }
        if (value.type !== "result") return;
        if (request.claudeHost) { inputClosed = true; try { child.stdin.end(); } catch {} } // The session's turn is over.
        if (typeof value.session_id === "string") state.threadId = value.session_id;
        const denials = Array.isArray(value.permission_denials) ? value.permission_denials : [];
        state.permissionDenials = Math.max(state.permissionDenials || 0, denials.length);
        // Named by the agent's own description, never the raw command or path:
        // receipts can reach a group chat.
        for (const denial of denials) addDenied({ tool: denial?.tool_name, summary: deniedSummary(denial?.tool_name, denial?.tool_input) });
        const success = value.subtype === "success" && value.is_error === false && typeof value.result === "string" && Boolean(value.result.trim());
        if (!success) {
          turnFailed = true;
          if (typeof value.result === "string" && value.result.trim()) state.agentError = value.result.slice(0, 4000);
          else if (Array.isArray(value.errors) && typeof value.errors[0] === "string") state.agentError = value.errors[0].slice(0, 4000);
          // A denial it worked around doesn't explain a usage limit, sign-in or network failure.
          const known = typeof state.agentError === "string" && FAILURE_HINTS.some(([, pattern]) => pattern.test(state.agentError));
          state.errorType = state.permissionDenials > 0 && !known ? "permission_denied" : "agent_error";
          return;
        }
        turnCompleted = true;
        const result = Buffer.from(value.result);
        state.resultTruncated = result.length > MAX_OUTPUT;
        writePrivate(path.join(directory, "result.txt"), result.subarray(0, MAX_OUTPUT));
        return;
      }
      if (value.type === "thread.started" && typeof value.thread_id === "string") {
        state.threadId = value.thread_id;
        // The desktop task must be discoverable while the job is still running.
        saveState(directory, state);
      }
      if (value.type === "item.completed" && isCodexPermissionDenial(value.item)) {
        state.permissionDenials = (state.permissionDenials || 0) + 1;
        state.errorType = "permission_denied";
        turnFailed = true;
        saveState(directory, state);
      }
      if (value.type === "turn.completed") { turnCompleted = true; state.usage = value.usage; }
      if (value.type === "turn.failed" || value.type === "error") {
        turnFailed = true;
        const message = value.type === "error" ? value.message : value.error?.message;
        if (typeof message === "string" && message.trim()) state.agentError = message.slice(0, 4000);
      }
      if (value.type === "item.completed" && value.item?.type === "agent_message") {
        const result = Buffer.from(value.item.text || "");
        state.resultTruncated = result.length > MAX_OUTPUT;
        writePrivate(path.join(directory, "result.txt"), result.subarray(0, MAX_OUTPUT));
      }
    } catch { /* Non-JSON diagnostic lines are retained in stdout.log. */ }
  }
  try {
    Object.assign(state, { supervisorPid: process.pid, status: "running", startedAt: new Date().toISOString() });
    saveState(directory, state);
    if (fs.existsSync(path.join(directory, "cancel"))) { finish("cancelled"); return; }
    child = spawnOwned(request.executable, argumentsFor(agent, request),
      { cwd: request.cwd, env: agentEnvironment(), detached: true, cleanupReceipt: true, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid) { state.agentPid = child.pid; saveState(directory, state); }
    child.stdin.on("error", () => {}); // Early CLI exits can close stdin before the prompt is consumed.
    // Host approvals keep stdin open for answers; the session's result ends it.
    // The person's images go in the same first message as their task.
    const message = JSON.stringify(agentImages.claudeUserMessage(request.prompt, request.images)) + "\n";
    if (request.claudeHost) child.stdin.write(message);
    else if (request.images?.length) child.stdin.end(message); // --input-format stream-json (argumentsFor)
    else child.stdin.end(request.prompt);
    child.stdout.on("data", (chunk) => {
      capture("stdout", chunk);
      lineBuffer += decoder.write(chunk);
      let newline;
      while ((newline = lineBuffer.indexOf("\n")) !== -1) {
        event(lineBuffer.slice(0, newline)); lineBuffer = lineBuffer.slice(newline + 1);
      }
      if (lineBuffer.length > 1024 * 1024) lineBuffer = "";
    });
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    process.once("SIGTERM", () => stop("cancelled"));
    process.once("SIGINT", () => stop("cancelled"));
    poll = setInterval(() => {
      if (fs.existsSync(path.join(directory, "cancel"))) { stop("cancelled"); return; }
      for (const [id, entry] of pending) {
        const file = path.join(directory, `${id}.response.json`);
        if (!fs.existsSync(file)) continue;
        let answer;
        try { answer = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
        if (answer.cancel) { stop("cancelled"); return; }
        try { answerHost(id, entry, answer); } catch { /* State is saved again on the next change or at the end. */ }
      }
    }, 250);
    function answerHost(id, entry, answer) {
      sendControl({ type: "control_response", response: { subtype: "success", request_id: entry.requestId, response: answer.result } });
      if (answer.result?.behavior === "deny") {
        addDenied({ tool: entry.native.params.tool_name, summary: deniedSummary(entry.native.params.tool_name, entry.native.params.input), by: "person" });
      }
      clearHostRequest(id); // Removed from pending first, so a failed save never answers twice.
    }
    deadline = setTimeout(() => stop("timed_out"), request.timeout * 1000);
    const exit = await new Promise((resolve, reject) => {
      finishExit = resolve;
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ exitCode: code, signal }));
    });
    const cleanup = shutdown ? await shutdown : null;
    lineBuffer += decoder.end();
    if (lineBuffer) event(lineBuffer);
    if (cleanup?.processExited === false) {
      finish("failed", { errorType: "process_exit_unconfirmed",
        error: "The local agent was asked to stop, but its exit could not be confirmed. Check this computer before starting another task." });
      return;
    }
    const success = exit.exitCode === 0 && turnCompleted && !turnFailed;
    finish(stopped || (success ? "completed" : "failed"), {
      ...exit,
      ...(!stopped && !success ? {
        ...(state.errorType === "permission_denied" ? {
          error: request.claudeHost
            ? "Claude Code couldn't finish: an action it needed was denied."
            : "The local agent was blocked by tool permissions. This background runner cannot handle interactive approval; review access in the local agent before continuing.",
          errorType: "permission_denied",
        } : failureReason({ agent, agentError: state.agentError, exitCode: exit.exitCode, signal: exit.signal,
          errorType: state.errorType || (exit.exitCode === 0 ? undefined : "process_error") })),
      } : {}),
    });
  } catch (error) {
    if (child) killGroup("SIGKILL");
    const name = agentName(agent);
    finish("failed", { errorType: "process_error", error: error?.code
      ? `${name} could not be started on this computer (${error.code}). Reinstall or update ${name}, then retry.`
      : `${name} stopped unexpectedly before reporting a result. Open ${name} on this computer to check that it works, then retry.` });
  }
}

module.exports = { startJob, getStatus, publicStatus, listJobs, cancelJob, respondJob, supervise, validateCwd, onDiskPath, failureReason, jobEvents, resumeContext, MAX_OUTPUT,
  sendTurn, sessionStatus, readSession, stopSession, listSessions };
