#!/usr/bin/env node
"use strict";

// Only the signed host's private controller launches this child. Its ancestor
// remains the native application; it never installs the standalone LaunchAgent.
const path = require("node:path");
const { ensureStateDir, readState, stateDir } = require("../src/state");
const { runDaemon, enablePrivateLog } = require("../src/runtime");
const { stopDescendants } = require("../src/embedded-children");
const { requestPermissions } = require("../src/permissions");
const { spawn } = require("node:child_process");
const { parentLifetime } = require("../src/embedded-lifetime");
async function main() {
  const windows = process.platform === "win32" && process.env.SHAPES_BRIDGE_WINDOWS_SUPERVISED === "1";
  if ((!windows && (typeof process.send !== "function" || !process.connected)) || !process.env.SHAPES_BRIDGE_HOME || readState("config")?.mode !== "embedded") throw new Error("Missing app-owned configuration");
  ensureStateDir();
  if (windows) process.stdout.write(JSON.stringify({ pid: process.pid }) + "\n");
  enablePrivateLog();
  process.env.SHAPES_CODEX_JOB_DIR = path.join(stateDir(), "jobs");
  let stopping;
  // Windows Job handles own descendants; exiting this daemon closes its exact
  // wrapper's Job instead of inspecting unrelated machine-wide PIDs.
  const cleanup = () => stopping ||= windows ? Promise.resolve() : stopDescendants();
  const signal = () => { void cleanup().catch(() => {}); };
  process.on("SIGTERM", signal); process.on("SIGINT", signal);
  const parent = parentLifetime(process, { ...(windows ? { input: process.stdin } : {}) });
  parent.signal.addEventListener("abort", signal, { once: true });
  try {
    await runDaemon({ signal: parent.signal, disableStartup() {}, requestNativePermissions: (options) => requestPermissions({ ...options,
      // An unanswered prompt belongs to this app lifetime too.
      spawnProcess: (file, args, settings) => spawn(file, args, { ...settings, detached: false }) }) });
  } finally {
    await cleanup();
    parent.dispose(); parent.signal.removeEventListener("abort", signal);
    process.removeListener("SIGTERM", signal); process.removeListener("SIGINT", signal);
  }
}
function exit(code) {
  // The controller creates this private process group. After cleanup, terminate
  // inherited shell grandchildren as well, including ones reparented on TERM.
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(code); }
}
main().then(() => exit(0), () => exit(1));
