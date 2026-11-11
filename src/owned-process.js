"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const cleanupReceipts = new WeakMap();

function jobHostPath({ platform = process.platform, executable = process.execPath, sourceDirectory = __dirname,
  exists = fs.existsSync, compile = () => require("./windows-job").ensureWindowsJobHost() } = {}) {
  const paths = platform === "win32" ? path.win32 : path;
  const installed = paths.join(paths.dirname(executable), "shapes.inc Bridge Job.exe");
  if (platform !== "win32" || exists(installed)) return installed;
  // The desktop app's manifest is its installed-runtime identity. Missing
  // signed bundle resources must never trigger a local compilation fallback.
  if (exists(paths.resolve(sourceDirectory, "../../manifest.json"))) return installed;
  return compile();
}
function windowsArguments(executable, args, { parentPid = process.pid, console = false, ready = false, windowsCommand = false, releaseOnSuccess = false, cleanupReceipt = false } = {}) {
  if (!path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable) || executable.includes("\0") || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("An absolute installed Windows executable is required.");
  }
  if (windowsCommand && (path.win32.basename(executable).toLowerCase() !== "cmd.exe" || args.length !== 1 || /[\r\n]/.test(args[0]))) throw new Error("Invalid Windows command transport.");
  if (parentPid !== null && (!Number.isSafeInteger(parentPid) || parentPid <= 0)) throw new Error("Invalid Windows process owner.");
  if ((releaseOnSuccess || cleanupReceipt) && (parentPid === null || console)) throw new Error("Windows ownership handoff requires a parent and private control input.");
  return [...(parentPid === null ? [] : ["--parent-pid", String(parentPid)]), ...(ready ? ["--ready"] : []), ...(console ? ["--console"] : []),
    ...(releaseOnSuccess ? ["--release-on-success", "--stdout-fd", "3"] : []),
    ...(cleanupReceipt ? ["--control-fd", "4", "--receipt-fd", "5"] : []), ...(windowsCommand ? ["--command-string"] : []), "--", executable, ...args];
}

// Windows uses kernel-owned Jobs rather than shell/taskkill process-tree
// snapshots. Every process started through this primitive dies with its exact
// supervisor, including descendants created after a cancellation begins.
function spawnOwned(executable, args, options = {}, { platform = process.platform, spawnProcess = spawn, host = jobHostPath(), exists = fs.existsSync } = {}) {
  if (platform !== "win32") return spawnProcess(executable, args, { ...options, detached: true });
  if (!exists(host)) throw new Error("The installed Windows process supervisor is missing.");
  if (options.stdio?.includes("ipc")) throw new Error("Windows Job host does not forward Node IPC.");
  if (options.releaseOnSuccess && (!Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio.some((mode) => mode !== "pipe"))) {
    throw new Error("Windows ownership handoff requires piped control input and two captured output streams.");
  }
  if (options.cleanupReceipt && (!Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio.some((mode) => !["ignore", "pipe"].includes(mode)))) {
    throw new Error("Windows cleanup receipts require three explicit pipe/ignore stdio modes.");
  }
  // The helper can retain a second startup stdout handle independently of
  // GetStdHandle. Keep that slot on NUL and give the helper an explicit pipe
  // it owns, so output EOF can precede successful Job ownership handoff.
  const stdio = options.releaseOnSuccess ? ["pipe", "ignore", "pipe", "pipe"] : options.cleanupReceipt ? [...options.stdio, "ignore"] : options.stdio;
  if (options.cleanupReceipt) stdio.push("pipe", "pipe");
  const child = spawnProcess(host, windowsArguments(executable, args, { parentPid: options.parentPid, console: options.console, ready: options.ready,
    windowsCommand: options.windowsCommand, releaseOnSuccess: options.releaseOnSuccess, cleanupReceipt: options.cleanupReceipt }),
    { ...options, stdio, shell: false, detached: options.parentPid === null, windowsHide: true });
  if (options.releaseOnSuccess) child.stdout = child.stdio[3];
  if (options.cleanupReceipt) {
    const control = child.stdio[4], receipt = child.stdio[5];
    const state = { confirmed: false, invalid: false, requested: false, bytes: "", control, receipt, complete: null, finish: null };
    state.complete = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(state.confirmed); } };
      state.finish = finish;
      receipt.on("data", (chunk) => {
        if (state.invalid) return;
        state.bytes += chunk.toString("utf8");
        if (state.bytes.length > 10) { state.invalid = true; state.bytes = ""; }
      });
      receipt.once("end", () => { state.confirmed = !state.invalid && state.bytes === "job-empty\n"; finish(); });
      receipt.once("error", () => { state.invalid = true; state.confirmed = false; finish(); });
      receipt.once("close", () => { if (!state.confirmed) state.invalid = true; finish(); });
      child.once("close", finish);
      child.once("error", finish);
    });
    control.on("error", () => {}); // Missing observer falls back to bounded hard termination.
    cleanupReceipts.set(child, state);
  }
  return child;
}

function signalOwned(child, signal, { platform = process.platform, kill = process.kill.bind(process) } = {}) {
  if (!child?.pid || (platform === "win32" && (child.exitCode !== null || child.signalCode !== null))) return;
  try {
    const receipt = cleanupReceipts.get(child);
    if (platform === "win32" && signal === "SIGTERM" && receipt) {
      if (!receipt.requested) { receipt.requested = true; receipt.control.end("cancel\n"); }
    } else if (platform === "win32") child.kill(signal);
    else kill(-child.pid, signal);
  }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

function ownedCleanup(child) { return cleanupReceipts.has(child) ? cleanupReceipts.get(child).confirmed : undefined; }
function waitForOwnedCleanup(child) { return cleanupReceipts.get(child)?.complete || Promise.resolve(undefined); }
function disposeOwned(child) {
  const state = cleanupReceipts.get(child);
  if (!state) return;
  if (!state.confirmed) state.invalid = true;
  state.finish();
  state.control.destroy(); state.receipt.destroy();
}
module.exports = { spawnOwned, signalOwned, jobHostPath, windowsArguments, ownedCleanup, waitForOwnedCleanup, disposeOwned };
