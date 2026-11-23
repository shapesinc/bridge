"use strict";

// Claude Code and Codex signed in through the person's shell profile (an API key,
// CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR, CODEX_HOME) looked signed out to the
// desktop app, which starts from launchd and never reads ~/.zshrc (2026-11-23).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const shellEnv = require("../src/login-shell-env");

const POSIX = process.platform !== "win32";

function stand_in_shell(t, profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-login-shell-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shell = path.join(dir, "shell");
  // Called as `shell -l -i -c <script>`: run the "profile", then the script.
  fs.writeFileSync(shell, `#!/bin/sh\n${profile}\nexec /bin/sh -c "$4"\n`, { mode: 0o700 });
  return { dir, shell };
}

test("only documented sign-in names are kept", () => {
  const extra = new Set(["AZURE_OPENAI_API_KEY"]);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "CODEX_HOME", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"]) assert.ok(shellEnv.wanted(name, extra), name);
  for (const name of ["PATH", "HOME", "SHAPES_RUNTIME_TOKEN", "NODE_OPTIONS", "anthropic_api_key", "CLAUDE_CODE_ENTRYPOINT"]) {
    assert.ok(!shellEnv.wanted(name, extra), name);
  }
});

test("profile output before the marker is ignored; values keep newlines and '='", () => {
  const values = shellEnv.parseEnvironment(Buffer.from(`Welcome!\n${shellEnv.MARK}\nA=1\0B=x=y\nz\0broken\0`));
  assert.deepEqual(values, { A: "1", B: "x=y\nz" });
  assert.equal(shellEnv.parseEnvironment("no marker"), null);
});

test("a profile's sign-in variables reach agents; this process's own values win", { skip: !POSIX }, async (t) => {
  shellEnv.resetLoginShellAuth();
  t.after(() => shellEnv.resetLoginShellAuth());
  const { shell } = stand_in_shell(t, [
    "echo 'profile banner'",
    "export CLAUDE_CODE_OAUTH_TOKEN=from-profile",
    "export CLAUDE_CONFIG_DIR=/tmp/profile-claude",
    "export SECRET_NOT_FOR_AGENTS=nope",
  ].join("\n"));
  const values = await shellEnv.loadLoginShellAuth({ shell, force: true });
  assert.equal(values.CLAUDE_CODE_OAUTH_TOKEN, "from-profile");
  assert.equal(values.CLAUDE_CONFIG_DIR, "/tmp/profile-claude");
  assert.ok(Object.keys(values).every((name) => shellEnv.wanted(name, new Set())), Object.keys(values).join());
  const env = shellEnv.agentEnvironment({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/already/set" });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "from-profile");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/already/set");
  assert.equal(env.SECRET_NOT_FOR_AGENTS, undefined);
});

test("a profile that hangs never holds up a task", { skip: !POSIX }, async (t) => {
  const { shell } = stand_in_shell(t, "sleep 30");
  const started = Date.now();
  assert.equal(await shellEnv.readShell(shell, { home: os.tmpdir(), timeoutMs: 300 }), null);
  assert.ok(Date.now() - started < 3000);
});

test("a profile that leaves something running in the background still answers at once", { skip: !POSIX }, async (t) => {
  const { shell } = stand_in_shell(t, "export ANTHROPIC_API_KEY=from-profile\n(sleep 30) &");
  const started = Date.now();
  const values = await shellEnv.readShell(shell, { home: os.tmpdir(), timeoutMs: 4000 });
  assert.equal(values?.ANTHROPIC_API_KEY, "from-profile");
  assert.ok(Date.now() - started < 3000);
});

test("a reread that fails keeps the sign-in the last read found", async (t) => {
  shellEnv.resetLoginShellAuth();
  t.after(() => shellEnv.resetLoginShellAuth());
  let clock = 5_000_000, fail = false;
  const read = async () => (fail ? null : { CLAUDE_CODE_OAUTH_TOKEN: "kept" });
  const options = { shell: "/bin/sh", read, now: () => clock, platform: "darwin" };
  await shellEnv.loadLoginShellAuth(options);
  fail = true; clock += 11 * 60_000;
  assert.deepEqual(await shellEnv.loadLoginShellAuth(options), { CLAUDE_CODE_OAUTH_TOKEN: "kept" });
  assert.equal(shellEnv.agentEnvironment({}).CLAUDE_CODE_OAUTH_TOKEN, "kept");
});

test("one read is shared and reused; a signed-out check reads the profile again", async (t) => {
  shellEnv.resetLoginShellAuth();
  t.after(() => shellEnv.resetLoginShellAuth());
  let clock = 1_000_000, reads = 0, profile = {};
  const read = async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { PATH: "/bin", ...profile }; };
  const options = { shell: "/bin/sh", read, now: () => clock, platform: "darwin" };
  await Promise.all([shellEnv.loadLoginShellAuth(options), shellEnv.loadLoginShellAuth(options)]);
  await shellEnv.loadLoginShellAuth(options);
  assert.equal(reads, 1);
  // They add a key and ask again: within 15 s no reread, after it one that notices.
  profile = { ANTHROPIC_API_KEY: "added" };
  assert.equal(await shellEnv.refreshLoginShellAuth({ ...options }), false);
  clock += 16_000;
  assert.equal(await shellEnv.refreshLoginShellAuth({ ...options }), true);
  assert.equal(shellEnv.agentEnvironment({}).ANTHROPIC_API_KEY, "added");
  assert.equal(reads, 2);
  // Claude Code and Codex are checked side by side: the one that didn't reread still sees the change.
  const since = shellEnv.loginShellAuthVersion() - 1;
  assert.equal(await shellEnv.refreshLoginShellAuth({ ...options, since }), true);
  assert.equal(reads, 2);
  // Windows apps already have the user's environment: no shell.
  assert.deepEqual(await shellEnv.loadLoginShellAuth({ ...options, platform: "win32", force: true }), {});
});

test("a Codex provider's own key variable counts", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "config.toml"),
    '[model_providers.azure]\nname = "Azure"\nenv_key = "AZURE_OPENAI_API_KEY"\n[x]\nenv_key = "lower_case"\n');
  assert.deepEqual([...shellEnv.codexKeyNames({}, home)], ["AZURE_OPENAI_API_KEY"]);
});

test("Claude Code signed in only through the profile is ready, not signed out", { skip: !POSIX }, async (t) => {
  shellEnv.resetLoginShellAuth();
  const keys = ["SHAPES_LOGIN_SHELL", "SHAPES_CLAUDE_BINARY", "CLAUDE_CODE_OAUTH_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    shellEnv.resetLoginShellAuth();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const { dir, shell } = stand_in_shell(t, "export CLAUDE_CODE_OAUTH_TOKEN=from-profile");
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("2.1.325 (Claude Code)"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("--print --output-format --verbose --permission-prompts --permission-mode --tools --strict-mcp-config --mcp-config --disallowedTools"); process.exit(0); }
const loggedIn = process.env.CLAUDE_CODE_OAUTH_TOKEN === "from-profile";
console.log(JSON.stringify({ loggedIn, authMethod: loggedIn ? "oauth_token" : "none" }));
process.exit(loggedIn ? 0 : 1);
`, { mode: 0o700 });
  process.env.SHAPES_CLAUDE_BINARY = claude;
  const { inspectAgent } = require("../src/agents");
  process.env.SHAPES_LOGIN_SHELL = path.join(dir, "missing-shell");
  assert.equal((await inspectAgent("claude", dir)).status, "auth_required");
  shellEnv.resetLoginShellAuth();
  process.env.SHAPES_LOGIN_SHELL = shell;
  const agent = await inspectAgent("claude", dir);
  assert.equal(agent.status, "ready");
  assert.ok(!JSON.stringify(require("../src/agents").publicAgent(agent)).includes("from-profile"));
});
