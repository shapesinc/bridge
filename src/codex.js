"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { selectAgent, argumentsFor, verifyInteractiveCodex } = require("./agents");
const { normalizeRequest, nativeResponse } = require("./approvals");

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
function failureReason({ agent, agentError, exitCode, signal, errorType }) {
  const name = agentName(agent);
  const reported = sanitizeAgentError(agentError);
  if (reported) {
    // Classify the raw text: redaction can remove the words a hint needs.
    const hint = FAILURE_HINTS.find(([, pattern]) => pattern.test(agentError));
    const advice = hint ? hint[2](name) : `Open ${name} on this computer to check the problem, then retry.`;
    return { errorType: errorType || "agent_error",
      error: agent === "claude" ? `${name} reported an error before finishing. ${advice}` : `${name} reported: "${reported}". ${advice}` };
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    return { errorType: errorType || "process_error",
      error: `${name} exited with code ${exitCode} before reporting a result. Open ${name} on this computer to check that it is signed in and up to date, then retry.` };
  }
  if (signal) {
    return { errorType: errorType || "process_error",
      error: `${name} was stopped by ${signal} before reporting a result. Make sure nothing on this computer is closing it, then retry.` };
  }
  return { errorType: errorType || "missing_completion",
    error: `${name} exited without finishing the task. Update ${name} on this computer, then retry.` };
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

function jobDir(id) {
  if (!UUID.test(id)) throw new Error("Invalid job ID.");
  const directory = path.join(root(), id);
  if (!fs.existsSync(directory)) throw new Error("Unknown job ID.");
  return privateDir(directory);
}

function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

function saveState(directory, state) {
  writePrivate(path.join(directory, "state.json"), JSON.stringify(state));
}

function loadState(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
}

function validateCwd(value, sandbox) {
  if (!value || !path.isAbsolute(value)) throw new Error("--cwd must be an explicit absolute directory.");
  const cwd = fs.realpathSync(value);
  if (!fs.statSync(cwd).isDirectory()) throw new Error("--cwd must be a directory.");
  if (sandbox === "workspace-write") {
    const git = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
    if (git.error) throw new Error("Cannot validate Git worktree: git is unavailable or timed out.");
    if (git.status === 0 && git.stdout.trim() === "true") {
      const dirs = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { encoding: "utf8", timeout: 5000 });
      if (dirs.status !== 0) throw new Error("Cannot validate Git worktree.");
      const [gitDir, commonDir] = dirs.stdout.trim().split("\n").map((p) => fs.realpathSync(p));
      if (gitDir === commonDir) throw new Error("Workspace writes require a dedicated Git worktree. Create one and pass its path as --cwd.");
    } else if (git.status !== 128 || !/^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(git.stderr)) {
      throw new Error("Cannot validate Git worktree.");
    }
  }
  return cwd;
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

function publicStatus(id, expectedAgent) {
  const { diagnostics_directory, diagnostics_available, ...receipt } = getStatus(id, expectedAgent);
  return receipt;
}

async function startJob({ promptFile, prompt: suppliedPrompt, cwd, sandbox = "read-only", timeoutSeconds = 1800, agent = "codex", interactive = false, requestKey }) {
  if (process.platform === "win32") throw new Error("The local agent launcher currently requires macOS or Linux.");
  if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("Unsupported sandbox.");
  cwd = validateCwd(cwd, sandbox);
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
  if (typeof interactive !== "boolean") throw new Error("interactive must be boolean.");
  validRequestKey(requestKey);
  const fingerprint = requestKey && crypto.createHash("sha256")
    .update(JSON.stringify([prompt, cwd, sandbox, timeout, agent, interactive])).digest("hex");
  if (requestKey && fs.existsSync(root())) {
    const existing = existingRequest(requestKey, fingerprint);
    if (existing) return { ...publicStatus(existing), deduplicated: true };
  }
  const selected = await selectAgent(agent, cwd);
  agent = selected.id;
  interactive = interactive && agent === "codex";
  if (interactive) await verifyInteractiveCodex(selected, cwd);
  const executable = selected.executable;
  const id = crypto.randomUUID();
  const directory = privateDir(path.join(root(), id));
  const state = { id, status: "queued", cwd, sandbox, agent, interactive, createdAt: new Date().toISOString(),
    promptPreview: prompt.trim().replace(/\s+/g, " ").slice(0, 160) };
  writePrivate(path.join(directory, "request.json"), JSON.stringify({ prompt, cwd, sandbox, timeout, executable, agent, interactive }));
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
  // The job is durably queued and listable from here on; a launch failure is
  // recorded on it so a status or list call explains what happened.
  try {
    const child = spawn(process.execPath, [path.join(__dirname, "../bin/codex.js"), "_supervise", id], {
      detached: true, stdio: "ignore", env: { ...process.env, SHAPES_CODEX_JOB_DIR: root() },
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
    ...(agent === "claude" ? { permission_scope: sandbox === "read-only" ? "read-only-tools" : "full-access" } : {}) };
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
  const state = loadState(directory);
  const agent = state.agent || "codex";
  if (expectedAgent && agent !== expectedAgent) throw new Error("This job belongs to a different local agent.");
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
    final: finalResult, error: state.error ? bounded(state.error, 1000) : null,
    cwd: state.cwd, sandbox: state.sandbox, thread_id: typeof state.threadId === "string" ? bounded(state.threadId, 512) : null,
    created_at: state.createdAt, finished_at: state.finishedAt || null,
    exit_code: state.exitCode ?? null,
    error_type: state.errorType || null,
    permission_denials: state.permissionDenials || 0,
    ...(state.errorType === "permission_denied" && state.status === "failed"
      ? { needs_user_action: true } : {}),
    ...(agent === "claude" ? { permission_scope: state.sandbox === "read-only" ? "read-only-tools" : "full-access" } : {}),
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

async function superviseInteractive(directory, state, request) {
  const { createCodexRpcSession } = require("./codex-rpc");
  const pending = new Map();
  let stopped, failed = false, timer, poll, session;
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
  const stop = (status) => {
    if (stopped) return;
    stopped = status;
    // Closing owns only this job's app-server process group, including workers.
    void session?.close();
  };
  const onSignal = () => stop("cancelled");
  Object.assign(state, { supervisorPid: process.pid, status: "running", startedAt: new Date().toISOString() });
  persist();
  try {
    if (fs.existsSync(path.join(directory, "cancel"))) { stopped = "cancelled"; return; }
    session = createCodexRpcSession({
      executable: request.executable, cwd: request.cwd, sandbox: request.sandbox,
      onEvent(value) {
        if (value.type === "thread.started") { state.threadId = value.thread_id; persist(); }
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
        const combined = Buffer.concat([logs[kind], Buffer.from(chunk)]);
        if (combined.length > MAX_OUTPUT) state[`${kind}Truncated`] = true;
        logs[kind] = combined.subarray(Math.max(0, combined.length - MAX_OUTPUT));
        writePrivate(path.join(directory, `${kind}.log`), logs[kind]);
      },
      onServerRequest(native) {
        try {
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
    const completion = session.start(request.prompt);
    state.agentPid = session.child?.pid;
    persist();
    const result = await completion;
    Object.assign(state, { usage: result.usage, exitCode: result.exitCode, signal: result.signal });
    if (result.status !== "completed") failed = true;
    if (typeof result.error?.message === "string" && result.error.message.trim()) state.agentError ||= result.error.message.slice(0, 4000);
  } catch {
    // Not the agent's own report: never quote it (it can carry local paths).
    // A cancel or deadline closes the session on purpose, and a permission
    // denial keeps its own explanation.
    failed = true;
    if (!stopped && !state.error && !state.agentError && state.errorType !== "permission_denied") {
      Object.assign(state, { errorType: "process_error",
        error: "Codex stopped before reporting a result. Check that Codex is installed, signed in and up to date on this computer, then retry; if it keeps happening, restart shapes.inc Bridge." });
    }
  } finally {
    clearInterval(poll); clearTimeout(timer);
    process.removeListener("SIGTERM", onSignal); process.removeListener("SIGINT", onSignal);
    await session?.close();
    for (const value of [...pending.values()]) clearRequest(value.native.id);
    state.pendingRequests = [];
    state.status = stopped || (failed ? "failed" : "completed");
    state.finishedAt = new Date().toISOString();
    if (state.status === "failed" && state.errorType === "permission_denied") state.error = "The local agent was blocked by tool permissions.";
    else if (state.status === "failed" && !state.error) Object.assign(state, failureReason({ agent: "codex", agentError: state.agentError, exitCode: state.exitCode, signal: state.signal, errorType: state.errorType }));
    saveState(directory, state);
  }
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
  let escalation;
  let stopped;
  let turnCompleted = false;
  let turnFailed = false;
  let lineBuffer = "";
  const decoder = new StringDecoder("utf8");
  const logs = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const killGroup = (signal) => {
    if (child && child.pid) {
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  const stop = (status) => {
    if (stopped) return;
    stopped = status;
    killGroup("SIGTERM");
    escalation = setTimeout(() => killGroup("SIGKILL"), 1500);
  };
  const finish = (status, detail = {}) => {
    clearInterval(poll); clearTimeout(deadline); clearTimeout(escalation);
    Object.assign(state, detail, { status, finishedAt: new Date().toISOString() });
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
        if (value.type === "system" && value.subtype === "init" && typeof value.session_id === "string") state.threadId = value.session_id;
        if (value.type === "system" && value.subtype === "permission_denied") {
          state.permissionDenials = (state.permissionDenials || 0) + 1;
          state.errorType = "permission_denied";
          turnFailed = true;
        }
        if (value.type !== "result") return;
        if (typeof value.session_id === "string") state.threadId = value.session_id;
        state.permissionDenials = Math.max(state.permissionDenials || 0, Array.isArray(value.permission_denials) ? value.permission_denials.length : 0);
        const denied = state.permissionDenials > 0;
        const success = value.subtype === "success" && value.is_error === false && typeof value.result === "string" && Boolean(value.result.trim());
        if (!success || denied) {
          turnFailed = true;
          state.errorType = denied ? "permission_denied" : "agent_error";
          if (!denied && typeof value.result === "string" && value.result.trim()) state.agentError = value.result.slice(0, 4000);
          else if (!denied && Array.isArray(value.errors) && typeof value.errors[0] === "string") state.agentError = value.errors[0].slice(0, 4000);
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
    child = spawn(request.executable, argumentsFor(agent, request),
      { cwd: request.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {}); // Early CLI exits can close stdin before the prompt is consumed.
    child.stdin.end(request.prompt);
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
      if (fs.existsSync(path.join(directory, "cancel"))) stop("cancelled");
    }, 250);
    deadline = setTimeout(() => stop("timed_out"), request.timeout * 1000);
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ exitCode: code, signal }));
    });
    lineBuffer += decoder.end();
    if (lineBuffer) event(lineBuffer);
    // A child may leave subprocesses behind after closing its pipes.
    if (stopped) killGroup("SIGKILL");
    const success = exit.exitCode === 0 && turnCompleted && !turnFailed;
    finish(stopped || (success ? "completed" : "failed"), {
      ...exit,
      ...(!stopped && !success ? {
        ...(state.errorType === "permission_denied" ? {
          error: "The local agent was blocked by tool permissions. This background runner cannot handle interactive approval; review access in the local agent before continuing.",
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

module.exports = { startJob, getStatus, publicStatus, listJobs, cancelJob, respondJob, supervise, validateCwd, failureReason, MAX_OUTPUT };
