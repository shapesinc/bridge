"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localEnvironment } = require("./local-workspace");
const { spawnOwned, signalOwned } = require("./owned-process");

const IDS = ["codex", "claude"];
const PROBE_TIMEOUT = 5000;

function desktopClaudeCandidates(home = os.homedir()) {
  const directory = path.join(home, "Library/Application Support/Claude/claude-code");
  try {
    const versions = fs.readdirSync(directory).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
    versions.sort((a, b) => {
      const left = a.split(".").map(Number), right = b.split(".").map(Number);
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
    });
    return versions.slice(0, 3).flatMap((version) => {
      const folder = path.join(directory, version);
      return fs.readdirSync(folder).filter((name) => /^[a-zA-Z0-9_-]+$/.test(name)).slice(0, 3)
        .map((name) => path.join(folder, name, "claude.app/Contents/MacOS/claude"));
    });
  } catch { return []; }
}

function candidates(agent) {
  const override = process.env[agent === "codex" ? "SHAPES_CODEX_BINARY" : "SHAPES_CLAUDE_BINARY"];
  if (override) return [override];
  const home = os.homedir();
  if (process.platform === "win32") return windowsCandidates(agent, { home, env: process.env });
  const defaults = agent === "codex" ? [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ] : [
    path.join(home, ".local/bin/claude"), path.join(home, ".claude/local/claude"),
    path.join(home, ".claude/local/node_modules/.bin/claude"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
    ...desktopClaudeCandidates(home),
  ];
  return [...new Set([...defaults, ...(localEnvironment().PATH || "").split(path.delimiter)
    .filter(Boolean).map((dir) => path.join(dir, agent))])];
}

function windowsCandidates(agent, { home, env, arch = process.arch }) {
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const npm = path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "npm", "node_modules");
  const defaults = agent === "codex" ? [
    path.win32.join(npm, "@openai", "codex", "vendor", target, "codex", "codex.exe"),
    path.win32.join(npm, "@openai", `codex-win32-${arch}`, "vendor", target, "codex", "codex.exe"),
    path.win32.join(home, ".local", "bin", "codex.exe"),
  ] : [path.win32.join(home, ".local", "bin", "claude.exe"), path.win32.join(home, ".claude", "local", "claude.exe")];
  const search = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  return [...new Set([...defaults, ...search.split(";").filter(Boolean).map((directory) => path.win32.join(directory, `${agent}.exe`))])];
}

// Probes never send a prompt. Capture all output privately: login status can
// include account identities or an API-key prefix, neither belongs in receipts.
function probe(executable, args, cwd) {
  return new Promise((resolve) => {
    let child, timer, output = "", error = "", finished = false;
    function finish(code, failed = false) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, output, error, failed });
    }
    function stop() {
      try { signalOwned(child, "SIGKILL"); } catch {}
      finish(null, true);
    }
    try {
      child = spawnOwned(executable, args, { cwd, env: localEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (part) => { output += part; if (output.length > 65536) stop(); });
      child.stderr.on("data", (part) => { error += part; if (error.length > 65536) stop(); });
      child.once("error", () => finish(null, true));
      child.once("close", (code) => finish(code));
      timer = setTimeout(stop, PROBE_TIMEOUT);
    } catch { finish(null, true); }
  });
}

async function inspectCandidate(id, executable, cwd) {
  const base = { id, installed: true, authenticated: false, available: false };
  const version = await probe(executable, ["--version"], cwd);
  const match = id === "codex" ? /codex-cli\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(version.output) : /(\d+\.\d+\.\d+)\s+\(Claude Code\)/.exec(version.output);
  if (version.failed) return { ...base, status: "check_failed", reason: "The local CLI version check did not finish." };
  if (version.code !== 0 || !match) return { ...base, status: "unsupported", reason: "The executable is not a supported agent CLI." };
  base.version = match[1].slice(0, 48);
  const help = await probe(executable, id === "codex" ? ["exec", "--help"] : ["--help"], cwd);
  const flags = id === "codex" ? ["--json", "--sandbox", "--ephemeral"]
    : ["--print", "--output-format", "--verbose", "--permission-prompts", "--permission-mode", "--tools", "--strict-mcp-config", "--mcp-config", "--disallowedTools"];
  if (help.failed) return { ...base, status: "check_failed", reason: "The local CLI capability check did not finish." };
  if (help.code !== 0 || !flags.every((flag) => help.output.includes(flag))) {
    return { ...base, status: "unsupported", reason: "Update the local agent CLI; this version lacks required headless controls." };
  }
  const auth = await probe(executable, id === "codex" ? ["login", "status"] : ["auth", "status"], cwd);
  let authenticated = false, malformedAuth = false;
  if (id === "claude") {
    try {
      const status = JSON.parse(auth.output);
      malformedAuth = typeof status?.loggedIn !== "boolean";
      authenticated = auth.code === 0 && status?.loggedIn === true;
    } catch { malformedAuth = true; }
  } else {
    authenticated = auth.code === 0 && /(?:^|\r?\n)\s*Logged in\b/i.test(auth.output + "\n" + auth.error);
  }
  if (auth.failed || malformedAuth || (auth.code !== 0 && auth.code !== 1)) {
    return { ...base, status: "check_failed", reason: "The local authentication check did not finish successfully." };
  }
  return {
    ...base, authenticated, available: authenticated, status: authenticated ? "ready" : "auth_required",
    // Private like executable: whether `--name` can label a session in Claude Code's own lists.
    ...(id === "claude" && /(?:^|\s)--name\b/.test(help.output) ? { nameFlag: true } : {}),
    // Private too: whether write runs can ask the person through this Bridge
    // (`--permission-prompt-tool stdio`) and run in Claude Code's auto mode.
    ...(id === "claude" && /"host"/.test(optionHelp(help.output, "--permission-prompts")) ? { hostPrompts: true } : {}),
    ...(id === "claude" && /"auto"/.test(optionHelp(help.output, "--permission-mode")) ? { autoMode: true } : {}),
    reason: authenticated ? "Installed and signed in. Provider availability is verified when a task runs."
      : `Sign in to ${id === "claude" ? "Claude Code" : "Codex"} locally, then retry.`,
    // Kept private by publicAgent; the native host also needs a compatible,
    // signed-out executable to open the vendor's own login flow.
    executable,
  };
}

// One option's own help text: from its flag to the next option.
function optionHelp(help, flag) {
  const lines = String(help || "").split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*(?:-\\w,\\s*)?${flag}\\b`).test(line));
  if (start < 0) return "";
  // Options start near the margin; wrapped description lines are indented far deeper.
  const end = lines.findIndex((line, index) => index > start && /^\s{0,6}-/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join(" ");
}

// A ready agent is reused for a minute: starting or messaging a session no
// longer re-probes version, flags and sign-in each time. Anything not ready
// is checked again on every call, so signing in takes effect at once.
const READY_TTL_MS = 60_000;
const readyCache = new Map();

async function inspectAgent(id, cwd = process.cwd(), { reuse = false } = {}) {
  if (!IDS.includes(id)) throw new Error("Unknown local agent.");
  const cached = reuse && readyCache.get(id);
  if (cached && Date.now() - cached.at < READY_TTL_MS) {
    try { if (fs.statSync(cached.agent.executable).mtimeMs === cached.mtime) return cached.agent; } catch {}
  }
  const agent = await inspectFresh(id, cwd);
  if (agent.available && agent.executable && !process.env.SHAPES_CLAUDE_BINARY && !process.env.SHAPES_CODEX_BINARY) {
    try { readyCache.set(id, { agent, at: Date.now(), mtime: fs.statSync(agent.executable).mtimeMs }); } catch {}
  } else readyCache.delete(id);
  return agent;
}

async function inspectFresh(id, cwd) {
  const paths = [];
  for (const candidate of candidates(id)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      if (!paths.includes(real)) paths.push(real);
    } catch {}
  }
  // Bound discovery latency even when a stale executable hangs. Candidate order
  // chooses the preferred compatible install; a ready alternate install wins.
  const results = await Promise.all(paths.slice(0, 12).map((file) => inspectCandidate(id, file, cwd)));
  const compatible = results.find((item) => item.available) || results.find((item) => item.status === "auth_required");
  if (compatible) return compatible;
  if (id === "codex") {
    const fallback = await require("./personal-codex").inspectBundledPersonal();
    if (fallback) return fallback;
  }
  return results[0] || { id, installed: false, authenticated: false, available: false,
    status: "not_installed", reason: `Install ${id === "claude" ? "Claude Code" : "Codex"} on this computer.` };
}

function publicAgent({ executable, transport, profile, nameFlag, hostPrompts, autoMode, ...agent }) { return agent; }

// The person's own Claude Code decides what needs asking: a defaultMode in
// their settings (managed, user or project) wins. Without one, use auto mode,
// the Claude app's default, so their autoMode rules apply. Never bypass.
function claudeSettingsMode(cwd, { home = os.homedir(), platform = process.platform } = {}) {
  const managed = platform === "darwin" ? "/Library/Application Support/ClaudeCode"
    : platform === "win32" ? path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode")
      : "/etc/claude-code";
  let dropIns = [];
  try { dropIns = fs.readdirSync(path.join(managed, "managed-settings.d")).filter((name) => name.endsWith(".json")).sort(); } catch {}
  const files = [
    path.join(managed, "managed-settings.json"),
    ...dropIns.map((name) => path.join(managed, "managed-settings.d", name)),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"),
    ...(cwd ? [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")] : []),
  ];
  for (const file of files) {
    try {
      const mode = JSON.parse(fs.readFileSync(file, "utf8"))?.permissions?.defaultMode;
      if (typeof mode === "string" && mode) return mode;
    } catch {}
  }
  return null;
}

// Modes Claude Code takes on the command line without another flag.
const CLAUDE_MODES = new Set(["default", "acceptEdits", "auto", "plan", "dontAsk"]);

// The mode the person picked for this folder (or the nearest parent) in the
// Claude app's Code tab. Best effort: the app keeps it in its own preferences.
function claudeAppFolderMode(cwd, { home = os.homedir(), platform = process.platform } = {}) {
  if (!cwd) return null;
  const file = platform === "win32"
    ? path.win32.join(process.env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  let prefs;
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
    prefs = JSON.parse(fs.readFileSync(file, "utf8"))?.preferences?.epitaxyPrefs;
  } catch { return null; }
  if (!prefs || typeof prefs !== "object") return null;
  const join = platform === "win32" ? path.win32 : path.posix;
  const folder = (value) => join.resolve(value).replace(/[\\/]+$/, "") || join.sep;
  const target = folder(cwd);
  let best = null;
  for (const version of ["epitaxy-folder-permission-mode-v2.", "epitaxy-folder-permission-mode."]) {
    for (const [key, folders] of Object.entries(prefs)) {
      if (!key.startsWith(version) || !folders || typeof folders !== "object") continue;
      for (const [saved, mode] of Object.entries(folders)) {
        if (typeof saved !== "string" || !join.isAbsolute(saved) || typeof mode !== "string") continue;
        const root = folder(saved);
        const inside = target === root || target.startsWith(root.endsWith(join.sep) ? root : root + join.sep);
        if (inside && (!best || root.length > best.root.length)) best = { root, mode };
      }
    }
    if (best) break;
  }
  return best && CLAUDE_MODES.has(best.mode) ? best.mode : null;
}

// The person's own mode, never one this Bridge prefers: a defaultMode in
// their Claude Code settings is applied by Claude Code itself (no flag); else
// the mode they chose for this folder in the Claude app; else auto, the
// Claude app's default. undefined means pass no --permission-mode.
function claudePermissionMode(cwd, { autoMode = false, home, platform } = {}) {
  if (claudeSettingsMode(cwd, { home, platform })) return undefined;
  const appMode = claudeAppFolderMode(cwd, { home, platform });
  if (appMode && (appMode !== "auto" || autoMode)) return appMode;
  return autoMode ? "auto" : undefined;
}

async function listAgents(cwd) {
  const agents = await Promise.all(IDS.map((id) => inspectAgent(id, cwd)));
  return { agents: agents.map(publicAgent), default_agent: agents.find((item) => item.available)?.id || null };
}

async function selectAgent(id, cwd) {
  if (![...IDS, "auto"].includes(id)) throw new Error("agent must be auto, codex, or claude.");
  // Starts reuse a ready agent for a minute; readiness answers (listAgents) always check again.
  const inspected = await Promise.all((id === "auto" ? IDS : [id]).map((name) => inspectAgent(name, cwd, { reuse: true })));
  const selected = inspected.find((item) => item.available);
  if (selected) return selected;
  const error = new Error(id === "auto" ? "No local agent is ready. Install and sign in to Codex or Claude Code locally."
    : inspected[0].reason);
  error.errorType = "agent_unavailable";
  error.agents = inspected.map(publicAgent);
  throw error;
}

async function verifyInteractiveCodex(selected, cwd) {
  if (selected.transport === "bundled_personal") return;
  const version = selected.version?.split(".").map(Number);
  const help = await probe(selected.executable, ["app-server", "--help"], cwd);
  if (help.failed || help.code !== 0 || !help.output.includes("--listen")
      || !version || (version[0] === 0 && version[1] < 160)) {
    const error = new Error("Update Codex on this computer to use interactive permissions and questions.");
    error.errorType = "agent_unavailable";
    error.agents = [{ ...publicAgent(selected), available: false, status: "unsupported", reason: error.message }];
    throw error;
  }
}

function argumentsFor(agent, request) {
  // Granting a chat this computer is the consent: write jobs run with full
  // access and no approval prompts; read-only jobs stay read-only.
  if (agent === "codex") return [
    "-a", "never", "exec", "--json", "--color", "never", "--sandbox", request.sandbox === "workspace-write" ? "danger-full-access" : "read-only",
    "-c", "sandbox_workspace_write.writable_roots=[]", "--skip-git-repo-check", "--cd", request.cwd,
    // The person's attached images (saved in the job folder) with the prompt.
    ...(request.images || []).map((image) => `--image=${image.path}`), "-",
  ];
  if (request.claudeHost) {
    // The person's own Claude Code: their permission mode and rules decide,
    // and whatever would prompt them comes to the chat as an approval.
    const args = ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-prompts", "host", "--permission-prompt-tool", "stdio"];
    if (request.permissionMode) args.push("--permission-mode", request.permissionMode);
    if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
    else if (request.agentSessionId) {
      args.push("--session-id", request.agentSessionId);
      if (request.nameFlag && request.title) args.push(`--name=${request.title}`);
    }
    return args;
  }
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none",
    // Images travel in a stream-json user message with the prompt.
    ...(request.images?.length ? ["--input-format", "stream-json"] : [])];
  // A session the person can open: a new one under the id Bridge chose, or the
  // same session continued. The name is joined to its flag so a title can't
  // be read as another option.
  if (request.resumeSessionId) args.push("--resume", request.resumeSessionId);
  else if (request.agentSessionId) {
    args.push("--session-id", request.agentSessionId);
    if (request.nameFlag && request.title) args.push(`--name=${request.title}`);
  }
  if (request.sandbox === "read-only") {
    // --tools restricts built-ins; it does not remove MCP services. Disable
    // those explicitly. This restricts agent tools, not user hooks or the OS.
    // https://code.claude.com/docs/en/cli-reference
    args.push("--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "mcp__*");
  } else if (request.permissionMode) {
    // A CLI without host prompts: the person's own mode and rules still decide;
    // what would need asking is denied and reported, never bypassed.
    args.push("--permission-mode", request.permissionMode);
  }
  return args;
}

module.exports = { listAgents, selectAgent, inspectAgent, publicAgent, argumentsFor, claudeSettingsMode, claudeAppFolderMode, claudePermissionMode, desktopClaudeCandidates, windowsCandidates, verifyInteractiveCodex };
