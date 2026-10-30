#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { ensureStateDir } = require("../src/state");
const { createEmbeddedController } = require("../src/embedded");
const { serveEmbeddedProtocol } = require("../src/embedded-protocol");
const { embeddedApiOrigin } = require("../src/embedded-config");

// The signed native host chooses these private values; RPC cannot override
// paths, executables, API origins, device credentials, or permission defaults.
let api;
try { api = embeddedApiOrigin(process.env.SHAPES_BRIDGE_API); }
catch { process.exit(1); }
if (!process.env.SHAPES_BRIDGE_HOME || !path.isAbsolute(process.env.SHAPES_BRIDGE_HOME)) process.exit(1);
ensureStateDir();
const protocol = serveEmbeddedProtocol({ input: process.stdin, output: process.stdout,
  controller: createEmbeddedController({ api }), onClose: (code) => process.exit(code) });
process.on("SIGTERM", () => { void protocol.close(); });
process.on("SIGINT", () => { void protocol.close(); });
