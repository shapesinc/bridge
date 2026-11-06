#!/usr/bin/env node
"use strict";

// Finite installed-runtime primitive. Deliberately imports no daemon, service,
// account/network client or credential/config mutation code.
const path = require("node:path");
const { createAccountRevocation } = require("../src/account-revocation");
try {
  if (!process.env.SHAPES_BRIDGE_HOME || !path.isAbsolute(process.env.SHAPES_BRIDGE_HOME) || process.argv.length !== 3) throw new Error();
  const store = createAccountRevocation();
  const command = process.argv[2];
  const result = command === "read-revocation" ? store.read() : command === "record-revocation" ? store.record() : null;
  if (!result) throw new Error();
  process.stdout.write(JSON.stringify({ version: 1, revocationToken: result.revocationToken }) + "\n");
} catch (error) {
  process.stderr.write("Account revocation state is unavailable.\n");
  if (process.env.SHAPES_BRIDGE_STATE_DIAGNOSTICS === "1") {
    const code = typeof error?.code === "string" && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : "UNKNOWN";
    process.stderr.write(`Private state failure: ${code}\n`);
  }
  process.exitCode = 1;
}
