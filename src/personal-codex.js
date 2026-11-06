"use strict";

const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { localEnvironment } = require("./local-workspace");
const { bundledRuntime } = require("./bundled-runtime");
const { closeProcessGroup } = require("./process-close");

// The vendor owns this standard personal profile and its credentials. Never
// read/copy auth files, and never use the credits-funded runtime-home here.
function personalConfiguration(profile = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  if (typeof profile !== "string" || !path.isAbsolute(profile) || /[\x00-\x1f\x7f]/.test(profile)) throw new Error("Invalid personal Codex profile.");
  const environment = localEnvironment();
  for (const key of Object.keys(environment)) if (/^(?:OPENAI_|ANTHROPIC_|SHAPES_RUNTIME_TOKEN$)/.test(key)) delete environment[key];
  environment.CODEX_HOME = profile;
  const config = { model_provider: "openai", check_for_update_on_startup: false, "analytics.enabled": false,
    "features.hooks": false, "sandbox_workspace_write.writable_roots": [] };
  return { environment, modelProvider: "openai", requiredAccountType: "chatgpt", launchArgs: ["--listen", "stdio://",
    ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])] };
}

// A bounded account-only transport. It cannot start threads, turns, tools or
// inference. Account identities, provider errors and tokens never leave it.
function createAccountClient({ executable, profile, timeoutMs = 8000, spawnProcess = spawn, onLogin = () => {} }) {
  const config = personalConfiguration(profile);
  const child = spawnProcess(executable, config.launchArgs, { cwd: os.homedir(), env: config.environment,
    detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const calls = new Map(), decoder = new StringDecoder("utf8");
  let next = 0, buffer = "", closing, failed = false;
  function fail() {
    failed = true;
    for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error("Personal account check unavailable.")); }
    calls.clear();
  }
  function request(method, params = {}) {
    if (!["initialize", "account/read", "account/login/start", "account/login/cancel"].includes(method)) return Promise.reject(new Error("Unsupported account operation."));
    return new Promise((resolve, reject) => {
      if (closing || failed) { reject(new Error("Personal account session closed.")); return; }
      const id = ++next;
      const timer = setTimeout(() => { calls.delete(id); reject(new Error("Personal account operation timed out.")); }, timeoutMs);
      calls.set(id, { resolve, reject, timer });
      try { child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }
      catch { clearTimeout(timer); calls.delete(id); reject(new Error("Personal account session unavailable.")); }
    });
  }
  async function close() {
    if (!closing) closing = Promise.resolve().then(async () => {
      fail(); child.stdin.end();
      const result = await closeProcessGroup(child, { graceMs: 250, exitTimeoutMs: 1000 });
      if (!result.processExited) throw new Error("Personal account process exit is unconfirmed.");
    });
    return closing;
  }
  child.stdin.on("error", fail);
  child.stderr.on("data", () => {});
  child.once("error", fail); child.once("exit", fail);
  child.stdout.on("data", (part) => {
    try {
      buffer += decoder.write(part);
      if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line);
        if (value.method === "account/login/completed") onLogin({ loginId: value.params?.loginId, success: value.params?.success === true });
        else if (value.method && Object.hasOwn(value, "id")) child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: "Account operations only." } }) + "\n");
        else if (calls.has(value.id)) {
          const call = calls.get(value.id); calls.delete(value.id); clearTimeout(call.timer);
          if (value.error) call.reject(new Error("Personal account operation failed.")); else call.resolve(value.result);
        }
      }
    } catch { fail(); void close().catch(() => {}); }
  });
  const ready = request("initialize", { clientInfo: { name: "shapes_inc_personal", title: "shapes.inc", version: "1" }, capabilities: {} })
    .then(() => { child.stdin.write('{"method":"initialized","params":{}}\n'); });
  ready.catch(() => {});
  return { ready, request, close, get pid() { return child.pid; } };
}

async function inspectBundledPersonal({ runtime = bundledRuntime(), profile, createClient = createAccountClient } = {}) {
  if (!runtime.available) return null;
  const selected = { id: "codex", installed: true, version: runtime.version, executable: runtime.executable,
    transport: "bundled_personal", profile: personalConfiguration(profile).environment.CODEX_HOME };
  let client;
  try {
    client = createClient({ executable: selected.executable, profile: selected.profile });
    await client.ready;
    const result = await client.request("account/read", { refreshToken: false });
    if (!result || !Object.hasOwn(result, "account") || (result.account !== null && !["chatgpt", "apiKey"].includes(result.account?.type))) throw new Error();
    const authenticated = result.account?.type === "chatgpt";
    return { ...selected, authenticated, available: authenticated, status: authenticated ? "ready" : "auth_required",
      reason: authenticated ? "Signed in with ChatGPT." : "Sign in with ChatGPT to use your personal account." };
  } catch { return { ...selected, authenticated: false, available: false, status: "check_failed", reason: "Could not check your ChatGPT account. Try again." }; }
  finally { if (client) await client.close(); }
}

function validLoginURL(value) {
  try { const url = new URL(value); return value.length < 16384 && url.protocol === "https:" && !url.username && !url.password
    && ["auth.openai.com", "auth0.openai.com", "chatgpt.com"].includes(url.hostname); } catch { return false; }
}
function openBrowser(url) {
  return new Promise((resolve, reject) => execFile("/usr/bin/open", [url], { timeout: 10000, maxBuffer: 16384 },
    (error) => error ? reject(new Error("Could not open provider sign-in.")) : resolve()));
}

function createPersonalLoginManager({ createClient = createAccountClient, open = openBrowser, lifetimeMs = 5 * 60 * 1000 } = {}) {
  let pending = null;
  async function cancel() {
    const current = pending;
    if (!current) return { cancelled: false };
    pending = null; current.cancelled = true; clearTimeout(current.timer);
    try { if (current.loginId) await current.client.request("account/login/cancel", { loginId: current.loginId }); }
    finally { if (current.client) await current.client.close(); }
    return { cancelled: true };
  }
  function start(selected, authorize = () => {}) {
    if (pending) return pending.result;
    const current = { cancelled: false, client: null, loginId: null };
    pending = current;
    current.result = Promise.resolve().then(async () => {
    try {
      authorize();
      if (pending !== current || current.cancelled) throw new Error("Login cancelled.");
      current.client = createClient({ executable: selected.executable, profile: selected.profile,
        onLogin(value) {
          if (pending === current && value.loginId === current.loginId) {
            pending = null; clearTimeout(current.timer); void current.client.close().catch(() => {});
          }
        } });
      await current.client.ready; authorize();
      if (pending !== current || current.cancelled) throw new Error("Login cancelled.");
      const result = await current.client.request("account/login/start", { type: "chatgpt" });
      if (typeof result?.loginId !== "string" || !result.loginId || !validLoginURL(result.authUrl)) throw new Error("Invalid provider sign-in response.");
      current.loginId = result.loginId;
      authorize();
      if (pending !== current || current.cancelled) throw new Error("Login cancelled.");
      await open(result.authUrl); authorize();
      if (pending !== current || current.cancelled) throw new Error("Login cancelled.");
      current.timer = setTimeout(() => { if (pending === current) void cancel().catch(() => {}); }, lifetimeMs);
      current.timer.unref?.();
      return { opened: true, cancellable: true };
    } catch (error) {
      if (pending === current) await cancel().catch(() => {});
      else if (current.client) await current.client.close().catch(() => {});
      throw error;
    }
    });
    return current.result;
  }
  return { start, cancel, status: () => ({ pending: Boolean(pending) }) };
}

module.exports = { personalConfiguration, createAccountClient, inspectBundledPersonal, createPersonalLoginManager, validLoginURL };
