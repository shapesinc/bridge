"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const MAX_OUTPUT = 64 * 1024;
const MAX_PROMPT = 64 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUNDLED = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

function privateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Codex job storage must be a directory owned by the current user, not a symlink.");
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

function binary() {
  const candidates = process.env.SHAPES_CODEX_BINARY
    ? [process.env.SHAPES_CODEX_BINARY]
    : [...BUNDLED, ...(process.env.PATH || "").split(path.delimiter).map((dir) => path.join(dir, "codex"))];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
      if (probe.status !== 0 || !/codex-cli\s/.test(probe.stdout)) continue;
      const help = spawnSync(candidate, ["exec", "--help"], { encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
      if (help.status === 0 && ["--json", "--sandbox", "--ephemeral"].every((flag) => help.stdout.includes(flag))) {
        return fs.realpathSync(candidate);
      }
    } catch {}
  }
  throw new Error("A current Codex CLI was not found (older CLIs are unsupported). Install/sign in to Codex, or set SHAPES_CODEX_BINARY to its current executable.");
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

async function startJob({ promptFile, cwd, sandbox = "read-only", timeoutSeconds = 1800 }) {
  if (process.platform === "win32") throw new Error("The Codex job launcher currently requires macOS or Linux.");
  if (!["read-only", "workspace-write"].includes(sandbox)) throw new Error("Unsupported sandbox.");
  cwd = validateCwd(cwd, sandbox);
  const timeout = Number(timeoutSeconds);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) throw new Error("Timeout must be between 1 and 86400 seconds.");
  if (!promptFile) throw new Error("--prompt-file is required.");
  const promptStat = fs.statSync(promptFile);
  if (!promptStat.isFile() || promptStat.size > MAX_PROMPT) throw new Error("Prompt must be a regular file no larger than 64 KiB.");
  const prompt = fs.readFileSync(promptFile, "utf8");
  if (!prompt.trim()) throw new Error("Prompt must not be empty.");
  const executable = binary();
  const id = crypto.randomUUID();
  const directory = privateDir(path.join(root(), id));
  writePrivate(path.join(directory, "request.json"), JSON.stringify({ prompt, cwd, sandbox, timeout, executable }));
  saveState(directory, { id, status: "queued", cwd, sandbox, createdAt: new Date().toISOString() });
  const child = spawn(process.execPath, [path.join(__dirname, "../bin/codex.js"), "_supervise", id], {
    detached: true, stdio: "ignore", env: { ...process.env, SHAPES_CODEX_JOB_DIR: root() },
  });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return { job_id: id, state: "queued", cwd, sandbox };
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

function getStatus(id) {
  const directory = jobDir(id);
  const state = loadState(directory);
  if (!TERMINAL.has(state.status)) {
    const lost = state.supervisorPid ? !alive(state.supervisorPid) : Date.now() - Date.parse(state.createdAt) > 30000;
    if (lost) {
      state.status = "failed";
      state.error = "Local Codex supervisor exited before reporting completion.";
      state.finishedAt = new Date().toISOString();
    }
  }
  const final = readOutput(directory, "result.txt");
  const finalResult = bounded(final, 8000);
  return {
    job_id: id, state: state.status,
    final: finalResult, error: state.error ? bounded(state.error, 1000) : null,
    cwd: state.cwd, sandbox: state.sandbox, thread_id: state.threadId || null,
    created_at: state.createdAt, finished_at: state.finishedAt || null,
    exit_code: state.exitCode ?? null,
    cancel_requested: fs.existsSync(path.join(directory, "cancel")),
    diagnostics_available: fs.existsSync(path.join(directory, "stdout.log")) || fs.existsSync(path.join(directory, "stderr.log")),
    diagnostics_directory: directory,
    output_truncated: Boolean(state.stdoutTruncated || state.stderrTruncated || state.resultTruncated || finalResult !== final),
  };
}

function cancelJob(id) {
  const directory = jobDir(id);
  const state = getStatus(id);
  if (!TERMINAL.has(state.state)) writePrivate(path.join(directory, "cancel"), "cancel\n");
  return { job_id: id, state: state.state, cancel_requested: !TERMINAL.has(state.state) || state.cancel_requested };
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
      if (value.type === "thread.started") state.threadId = value.thread_id;
      if (value.type === "turn.completed") { turnCompleted = true; state.usage = value.usage; }
      if (value.type === "turn.failed" || value.type === "error") turnFailed = true;
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
    child = spawn(request.executable, [
      "-a", "never", "exec", "--json", "--color", "never", "--sandbox", request.sandbox,
      "-c", "sandbox_workspace_write.writable_roots=[]",
      "--skip-git-repo-check", "--cd", request.cwd, "-",
    ], { cwd: request.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
      ...(!stopped && !success ? { error: "Codex did not complete successfully. Inspect the private local diagnostics directory." } : {}),
    });
  } catch (error) {
    if (child) killGroup("SIGKILL");
    finish("failed", { error: error.message });
  }
}

module.exports = { startJob, getStatus, cancelJob, supervise, validateCwd, MAX_OUTPUT };
