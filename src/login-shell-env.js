"use strict";

// The person's own Claude Code and Codex sign-in settings, as their terminal has them.
//
// The desktop app starts from launchd, which never reads ~/.zprofile or ~/.zshrc.
// Someone who signs Claude Code or Codex in through their shell profile (an API
// key, `claude setup-token`'s CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR, CODEX_HOME,
// a Bedrock or Vertex profile) looked signed out here while their terminal worked.
// Read the login shell's environment once, bounded, and keep only the names those
// tools document for sign-in and provider choice. Values stay in this process and
// the agents it starts: never logged, never in receipts, request files or status,
// never sent to the server. Windows apps already inherit the user's environment.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localEnvironment } = require("./local-workspace");
const { spawnOwned, signalOwned } = require("./owned-process");

// https://code.claude.com/docs/en/env-vars and /authentication; Codex: CODEX_HOME,
// OPENAI_API_KEY / CODEX_API_KEY, OPENAI_BASE_URL and each provider's `env_key`.
const NAMES = new Set([
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_FULL_SIGN_IN_LINK",
  "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
  "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
]);
const PREFIXES = ["ANTHROPIC_", "AWS_", "CLAUDE_CODE_OAUTH_", "CLAUDE_CODE_CLIENT_", "CLAUDE_CODE_USE_", "CLAUDE_CODE_SKIP_", "CLAUDE_CODE_AWS_"];
const NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const TIMEOUT_MS = 5000;
const MAX_OUTPUT = 1024 * 1024;
const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const MARK = "__SHAPES_LOGIN_ENV_6c1f__";

let cached = { values: {}, at: 0, ok: false };
let pending = null;
// Bumped whenever what the profile holds for sign-in changes.
let version = 0;

function wanted(name, extra) {
  return NAME.test(name) && (NAMES.has(name) || extra.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix)));
}

// A Codex provider names the variable that holds its key (`env_key = "..."`).
function codexKeyNames(env, home) {
  const names = new Set();
  try {
    const text = fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"), "utf8").slice(0, 262144);
    for (const match of text.matchAll(/^\s*env_key\s*=\s*"([A-Z][A-Z0-9_]{0,63})"\s*$/gm)) names.add(match[1]);
  } catch {}
  return names;
}

// Everything printed after the marker: NUL-separated NAME=value pairs.
function parseEnvironment(output) {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output);
  const start = text.lastIndexOf(`${MARK}\n`);
  if (start < 0) return null;
  const values = {};
  for (const entry of text.slice(start + MARK.length + 1).split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) values[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return values;
}

// Their account's shell, as Terminal opens it. SHAPES_LOGIN_SHELL points tests
// and support checks at another one without touching anyone's profile.
function loginShell({ env = process.env, user = () => os.userInfo() } = {}) {
  let shell = env.SHAPES_LOGIN_SHELL;
  if (!shell) try { shell = user().shell; } catch {}
  shell = shell || env.SHELL || "/bin/zsh";
  try {
    if (!path.isAbsolute(shell) || !fs.statSync(shell).isFile()) return null;
    fs.accessSync(shell, fs.constants.X_OK);
  } catch { return null; }
  return shell;
}

function readShell(shell, { home, spawnProcess = spawnOwned, signal = signalOwned, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child, timer, size = 0, finished = false;
    const chunks = [];
    const finish = (values) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Leftovers the profile started in this shell's process group go with it.
      try { signal(child, "SIGKILL"); } catch {}
      resolve(values);
    };
    try {
      // Interactive login, as a new terminal window: exports in ~/.zshrc count.
      child = spawnProcess(shell, ["-l", "-i", "-c", `printf '\\n%s\\n' ${MARK}; exec /usr/bin/env -0`], {
        cwd: home, env: { ...localEnvironment(), TERM: "dumb" }, stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.on("data", (part) => {
        size += part.length;
        if (size > MAX_OUTPUT) { finish(null); return; }
        chunks.push(part);
      });
      child.once("error", () => finish(null));
      child.once("close", () => finish(parseEnvironment(Buffer.concat(chunks))));
      timer = setTimeout(() => finish(null), timeoutMs);
    } catch { finish(null); }
  });
}

// Loads once and reuses the answer for ten minutes (a minute after a failure),
// so probes and starts never wait on the shell twice. Concurrent callers share one read.
async function loadLoginShellAuth({ platform = process.platform, env = process.env, home = os.homedir(), now = Date.now,
  force = false, shell, read = readShell } = {}) {
  if (platform === "win32") return {};
  if (!force && cached.at && now() - cached.at < (cached.ok ? FRESH_MS : RETRY_MS)) return cached.values;
  if (pending) return pending;
  pending = (async () => {
    const login = shell === undefined ? loginShell({ env }) : shell;
    const all = login ? await read(login, { home }) : null;
    const values = {};
    if (all) {
      const extra = codexKeyNames({ ...all, ...env }, home);
      for (const [name, value] of Object.entries(all)) if (wanted(name, extra) && value) values[name] = value;
    }
    if (JSON.stringify(Object.entries(values).sort()) !== JSON.stringify(Object.entries(cached.values).sort())) version += 1;
    cached = { values, at: now(), ok: Boolean(all) };
    return values;
  })();
  try { return await pending; } finally { pending = null; }
}

// Read the profile again when an agent looks signed out, at most every 15 seconds.
// True when what it holds for sign-in differs from the read `since` came from,
// even when a check running alongside did the rereading.
async function refreshLoginShellAuth({ minAgeMs = 15_000, now = Date.now, since = version, ...options } = {}) {
  if (pending) await pending.catch(() => {});
  if (!cached.at || now() - cached.at >= minAgeMs) await loadLoginShellAuth({ ...options, now, force: true });
  return version !== since;
}

function loginShellAuthVersion() { return version; }

// The environment for the person's own Claude Code or Codex: what this process
// already has wins, then their login shell's sign-in settings fill the gaps.
function agentEnvironment(base = localEnvironment()) {
  return { ...cached.values, ...base };
}

function resetLoginShellAuth() { cached = { values: {}, at: 0, ok: false }; pending = null; }

module.exports = { loadLoginShellAuth, refreshLoginShellAuth, loginShellAuthVersion, agentEnvironment, parseEnvironment, readShell, loginShell, wanted, codexKeyNames,
  resetLoginShellAuth, MARK };
