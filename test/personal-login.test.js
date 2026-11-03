"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loginCommand, openPersonalLogin } = require("../src/personal-login");
const { createEmbeddedController } = require("../src/embedded");
const { parseRequest } = require("../src/embedded-protocol");
const { publicAgent } = require("../src/agents");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

test("native personal login hands a literal executable to the official vendor command", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-personal-login-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = "/private/folder ' $(touch NEVER)/codex";
  let invocation;
  assert.deepEqual(await openPersonalLogin({ id: "codex", executable }, { directory, platform: "darwin", run(...args) { invocation = args; args.at(-1)(null); } }), { opened: true });
  assert.equal(invocation[0], "/usr/bin/open");
  assert.deepEqual(invocation[1].slice(0, 2), ["-a", "/System/Applications/Utilities/Terminal.app"]);
  const script = fs.readFileSync(invocation[1].at(-1), "utf8");
  assert.ok(script.endsWith("exec '/private/folder '\\'' $(touch NEVER)/codex' login\n"));
  assert.ok(script.includes('/bin/rm -f "$0"'));
  assert.equal(fs.statSync(invocation[1].at(-1)).mode & 0o777, 0o700);
  assert.equal(loginCommand("claude", "/bin/claude"), "exec '/bin/claude' auth login");
  assert.throws(() => loginCommand("other", "/bin/codex"));
  assert.throws(() => loginCommand("codex", "relative"));
  assert.throws(() => loginCommand("codex", "/bad\npath"));
  await assert.rejects(openPersonalLogin({ id: "codex", executable }, { directory, platform: "darwin", run(...args) { args.at(-1)(new Error("secret")); } }), /Could not open/);
  assert.equal(fs.readdirSync(directory).length, 1, "failed handoff file must be removed");
});

test("private account operations authorize and recheck before opening, and return no executable", async () => {
  let probes = 0, opens = 0, release;
  const candidate = { id: "codex", status: "auth_required", installed: true, authenticated: false, available: false, executable: "/private/codex" };
  const controller = createEmbeddedController({ read: () => null, remove: () => {},
    runtime: { running: () => false, pid: () => null, stop: async () => {} },
    discoverPersonalAgents: async () => { probes++; return { agents: [publicAgent(candidate)] }; },
    inspectPersonalAgent: async () => { probes++; if (release) await new Promise((resolve) => { release.resolve = resolve; }); return candidate; },
    launchPersonalLogin: async () => { opens++; return { opened: true }; },
  });
  await assert.rejects(controller.listPersonalAgents({ expectedUserId: "owner" }), { code: "account_unverified" });
  assert.equal(probes, 0);
  await controller.updateAccount({ userId: "owner", deviceIds: [], verified: true });
  assert.deepEqual((await controller.listPersonalAgents({ expectedUserId: "owner" })).agents, [publicAgent(candidate)]);
  assert.equal(JSON.stringify(await controller.listPersonalAgents({ expectedUserId: "owner" })).includes("/private"), false);
  assert.deepEqual(await controller.openAgentLogin({ expectedUserId: "owner", agent: "codex" }), { opened: true });
  assert.equal(candidate.authenticated, false, "opening a browser is not completed authentication");
  await assert.rejects(controller.openAgentLogin({ expectedUserId: "owner", agent: "all" }), { code: "invalid_request" });
  release = {};
  const pending = controller.openAgentLogin({ expectedUserId: "owner", agent: "codex" });
  await new Promise((resolve) => setImmediate(resolve));
  await controller.updateAccount({ userId: "other", deviceIds: [], verified: true });
  release.resolve();
  await assert.rejects(pending, { code: "account_changed" });
  assert.equal(opens, 1);
  await controller.dispose();
});

test("private protocol accepts only fixed login/status fields, never executable or credentials", () => {
  const base = { version: 1, id: "account", operation: "openAgentLogin", params: { expectedUserId: "owner", agent: "codex" } };
  assert.deepEqual(parseRequest(JSON.stringify(base)), base);
  for (const extra of [{ executable: "/bin/sh" }, { token: "provider-token" }, { command: "anything" }]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...base, params: { ...base.params, ...extra } })), { code: "invalid_request" });
  }
});
