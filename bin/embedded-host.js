#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { embeddedApiOrigin } = require("../src/embedded-config");
const args = process.argv.slice(2);
// Installed signed host arguments only. Neither pipe nor browser RPC can
// select executable paths, account identity, API origin, or state storage.
if (args.length !== 4 || args[0] !== "--state-dir" || args[2] !== "--api" || !path.isAbsolute(args[1])) process.exit(64);
// Task Scheduler inherits the account environment. The installed host owns
// runtime selection; unrelated shell overrides must not replace its binaries,
// private state, API, or billing/session configuration.
for (const key of Object.keys(process.env)) if (/^(?:SHAPES_|NODE_OPTIONS$|NODE_PATH$|OPENAI_|ANTHROPIC_|CODEX_)/i.test(key)) delete process.env[key];
process.env.SHAPES_BRIDGE_HOME = args[1];
let api;
try { api = embeddedApiOrigin(args[3]); } catch { process.exit(64); }
process.env.SHAPES_BRIDGE_API = api;
const { ensureStateDir } = require("../src/state");
const { createEmbeddedHost, hostConfiguration } = require("../src/embedded-host");
const { createEmbeddedController } = require("../src/embedded");
async function main() {
  const directory = ensureStateDir();
  const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../manifest.json"), "utf8")).version;
  if (typeof version !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(version)) throw new Error("Invalid host version");
  const host = createEmbeddedHost({ controller: createEmbeddedController({ api }), ...hostConfiguration(directory), version });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void host.dispose().then(() => process.exit(0), () => process.exit(1)); });
  try { await host.start(); } catch (error) { if (error.code === "EADDRINUSE") process.exit(0); throw error; }
}
main().catch(() => process.exit(1));
