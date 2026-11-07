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
const controller = createEmbeddedController({ api });
const startup = controller.resumeSavedConnection();
const protocol = serveEmbeddedProtocol({ input: process.stdin, output: process.stdout,
  controller, allowLifecycle: true, onClose: (code) => process.exit(code) });
// This stdio endpoint belongs only to the signed native XPC service. The web
// and Windows pipe protocols do not enable its private lifecycle query.
void startup.catch(() => protocol.close());
process.on("SIGTERM", () => { void protocol.close(); });
process.on("SIGINT", () => { void protocol.close(); });
