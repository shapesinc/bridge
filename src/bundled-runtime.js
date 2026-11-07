"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { localEnvironment } = require("./local-workspace");
const { ensureStateDir } = require("./state");
const { validateToolProxy } = require("./native-tool-proxy");

const VERSION = require("../assets/codex/runtime.json").version;
const expiryMillis = (value) => typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
function bundledRuntime() {
  const executable = process.env.SHAPES_BUNDLED_CODEX_BINARY
    || path.resolve(__dirname, "../../codex", process.arch, "bin/codex-app-server");
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    if (!fs.statSync(executable).isFile()) throw new Error("Not a file");
    return { available: true, executable, version: VERSION, funding: "shapes_credits" };
  } catch { return { available: false, version: VERSION, funding: "shapes_credits" }; }
}

function validateGateway(gateway, { sessionId, scopeId, requestKey, platform = process.platform }) {
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)
      || gateway.session_id !== sessionId || gateway.scope_id !== scopeId || gateway.request_key !== requestKey
      || typeof gateway.token !== "string" || !gateway.token || gateway.token.length > 16384
      || typeof gateway.model !== "string" || !gateway.model || gateway.model.length > 200
      || typeof gateway.run_id !== "string" || !gateway.run_id || gateway.run_id.length > 200
      || !Number.isFinite(expiryMillis(gateway.expires_at)) || expiryMillis(gateway.expires_at) <= Date.now()) {
    throw new Error("A current gateway grant bound to this session and request is required.");
  }
  const url = new URL(gateway.base_url);
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("The gateway must use HTTPS, or loopback HTTP for local development.");
  }
  const { token } = gateway;
  const { toolToken, toolProxy } = validateToolProxy(gateway, { platform });
  return { token, toolToken, metadata: { base_url: url.toString().replace(/\/$/, ""), model: gateway.model,
    ...(toolProxy ? { tool_proxy: toolProxy } : {}),
    run_id: gateway.run_id, expires_at: gateway.expires_at, scope_id: scopeId, session_id: sessionId, request_key: requestKey } };
}

function launchConfiguration(gateway) {
  const token = process.env.SHAPES_RUNTIME_TOKEN;
  if (!token || !Number.isFinite(expiryMillis(gateway.expires_at)) || expiryMillis(gateway.expires_at) <= Date.now()) throw new Error("The gateway grant expired before the local task started.");
  const home = path.join(ensureStateDir(), "runtime-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (process.getuid && homeStat.uid !== process.getuid())) throw new Error("Runtime storage must be owned by this account.");
  const environment = localEnvironment();
  // Never reuse the person's unrelated provider credentials or Codex profile.
  for (const key of Object.keys(environment)) if (/^(?:OPENAI_|CODEX_|ANTHROPIC_|SHAPES_CODEX_)/.test(key)) delete environment[key];
  delete environment.SHAPES_NATIVE_TOOL_TOKEN;
  environment.CODEX_HOME = home;
  environment.SHAPES_RUNTIME_TOKEN = token;
  const config = {
    model_provider: "shapes", model: gateway.model,
    "model_providers.shapes.name": "shapes.inc",
    "model_providers.shapes.base_url": gateway.base_url,
    "model_providers.shapes.env_key": "SHAPES_RUNTIME_TOKEN",
    "model_providers.shapes.wire_api": "responses",
    "model_providers.shapes.requires_openai_auth": false,
    "model_providers.shapes.supports_websockets": false,
    "model_providers.shapes.request_max_retries": 0,
    "model_providers.shapes.stream_max_retries": 0,
    "model_providers.shapes.http_headers.Accept": "text/event-stream",
    web_search: "disabled", check_for_update_on_startup: false, "analytics.enabled": false,
    // Leave useful headroom above the runtime/repository instructions. This is
    // an early threshold calibrated to the gateway's 256 KiB request envelope,
    // not the provider's advertised context window. Byte overflow still uses
    // the gateway's context_length_exceeded rejection boundary; the pinned
    // runtime reports a terminal error rather than silently replaying the task.
    model_auto_compact_token_limit: 32000, model_reasoning_summary: "auto",
    "features.view_image": true,
    "shell_environment_policy.ignore_default_excludes": true,
    "shell_environment_policy.exclude": ["SHAPES_RUNTIME_TOKEN"],
    "sandbox_workspace_write.writable_roots": [],
  };
  // Match the capabilities supported by the existing billed Responses gateway.
  for (const feature of ["apps", "browser_use", "computer_use", "enable_request_compression", "goals", "hooks",
    "image_generation", "memories", "multi_agent", "multi_agent_v2", "plugins", "realtime_conversation",
    "remote_plugin", "skill_search", "sleep_tool", "tool_suggest", "unbounded_connection_retries", "workspace_dependencies"]) {
    config[`features.${feature}`] = false;
  }
  return { environment, model: gateway.model, modelProvider: "shapes",
    launchArgs: ["--listen", "stdio://", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])] };
}

module.exports = { bundledRuntime, validateGateway, launchConfiguration, VERSION };
