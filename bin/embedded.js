#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { ensureStateDir } = require("../src/state");
const { createEmbeddedController } = require("../src/embedded");
const { serveEmbeddedProtocol } = require("../src/embedded-protocol");

// The signed native host chooses these private values; RPC cannot override
// paths, executables, API origins, device credentials, or permission defaults.
const api = process.env.SHAPES_BRIDGE_API || "https://api.shapes.inc";
if (!process.env.SHAPES_BRIDGE_HOME || !path.isAbsolute(process.env.SHAPES_BRIDGE_HOME) ||
    !["https://api.shapes.inc", "http://127.0.0.1:8080"].includes(api)) process.exit(1);
ensureStateDir();
const protocol = serveEmbeddedProtocol({ input: process.stdin, output: process.stdout,
  controller: createEmbeddedController({ api }), onClose: (code) => process.exit(code) });
process.on("SIGTERM", () => { void protocol.close(); });
process.on("SIGINT", () => { void protocol.close(); });
