"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
  const defaults = agent === "codex" ? [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ] : [
    path.join(home, ".local/bin/claude"), path.join(home, ".claude/local/claude"),
    path.join(home, ".claude/local/node_modules/.bin/claude"),
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
    ...desktopClaudeCandidates(home),
  ];
  return [...new Set([...defaults, ...(process.env.PATH || "").split(path.delimiter)
    .filter(Boolean).map((dir) => path.join(dir, agent))])];
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
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      finish(null, true);
    }
    try {
      child = spawn(executable, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
    reason: authenticated ? "Installed and signed in. Provider availability is verified when a task runs."
      : `Sign in to ${id === "claude" ? "Claude Code" : "Codex"} locally, then retry.`,
    ...(authenticated ? { executable } : {}),
  };
}

async function inspectAgent(id, cwd = process.cwd()) {
  if (!IDS.includes(id)) throw new Error("Unknown local agent.");
  const paths = [];
  for (const candidate of candidates(id)) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      if (!paths.includes(real)) paths.push(real);
    } catch {}
  }
  if (!paths.length) return { id, installed: false, authenticated: false, available: false,
    status: "not_installed", reason: `Install ${id === "claude" ? "Claude Code" : "Codex"} on this computer.` };
  // Bound discovery latency even when a stale executable hangs. Candidate order
  // chooses the preferred compatible install; a ready alternate install wins.
  const results = await Promise.all(paths.slice(0, 12).map((file) => inspectCandidate(id, file, cwd)));
  return results.find((item) => item.available) || results.find((item) => item.status === "auth_required") || results[0];
}

function publicAgent({ executable, ...agent }) { return agent; }

async function listAgents(cwd) {
  const agents = await Promise.all(IDS.map((id) => inspectAgent(id, cwd)));
  return { agents: agents.map(publicAgent), default_agent: agents.find((item) => item.available)?.id || null };
}

async function selectAgent(id, cwd) {
  if (![...IDS, "auto"].includes(id)) throw new Error("agent must be auto, codex, or claude.");
  const inspected = await Promise.all((id === "auto" ? IDS : [id]).map((name) => inspectAgent(name, cwd)));
  const selected = inspected.find((item) => item.available);
  if (selected) return selected;
  const error = new Error(id === "auto" ? "No local agent is ready. Install and sign in to Codex or Claude Code locally."
    : inspected[0].reason);
  error.errorType = "agent_unavailable";
  error.agents = inspected.map(publicAgent);
  throw error;
}

async function verifyInteractiveCodex(selected, cwd) {
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
  if (agent === "codex") return [
    "-a", "never", "exec", "--json", "--color", "never", "--sandbox", request.sandbox,
    "-c", "sandbox_workspace_write.writable_roots=[]", "--skip-git-repo-check", "--cd", request.cwd, "-",
  ];
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"];
  if (request.sandbox === "read-only") {
    // --tools restricts built-ins; it does not remove MCP services. Disable
    // those explicitly. This restricts agent tools, not user hooks or the OS.
    // https://code.claude.com/docs/en/cli-reference
    args.push("--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disallowedTools", "mcp__*");
  } else {
    // Authorize this task's requested edits, retaining explicit deny/ask and
    // managed rules. Other commands still need existing permission rules.
    // https://code.claude.com/docs/en/permission-modes
    args.push("--permission-mode", "acceptEdits");
  }
  return args;
}

module.exports = { listAgents, selectAgent, inspectAgent, argumentsFor, desktopClaudeCandidates, verifyInteractiveCodex };
