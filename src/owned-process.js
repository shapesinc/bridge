"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
function windowsArguments(executable, args, { parentPid = process.pid, console = false, ready = false, windowsCommand = false, releaseOnSuccess = false } = {}) {
  if (!path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable) || executable.includes("\0") || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("An absolute installed Windows executable is required.");
  }
  if (windowsCommand && (path.win32.basename(executable).toLowerCase() !== "cmd.exe" || args.length !== 1 || /[\r\n]/.test(args[0]))) throw new Error("Invalid Windows command transport.");
  if (parentPid !== null && (!Number.isSafeInteger(parentPid) || parentPid <= 0)) throw new Error("Invalid Windows process owner.");
  return [...(parentPid === null ? [] : ["--parent-pid", String(parentPid)]), ...(ready ? ["--ready"] : []), ...(console ? ["--console"] : []),
    ...(releaseOnSuccess ? ["--release-on-success"] : []), ...(windowsCommand ? ["--command-string"] : []), "--", executable, ...args];
}

// Windows uses kernel-owned Jobs rather than shell/taskkill process-tree
// snapshots. Every process started through this primitive dies with its exact
// supervisor, including descendants created after a cancellation begins.
function spawnOwned(executable, args, options = {}, { platform = process.platform, spawnProcess = spawn, host = jobHostPath(), exists = fs.existsSync } = {}) {
  if (platform !== "win32") return spawnProcess(executable, args, { ...options, detached: true });
  if (!exists(host)) throw new Error("The installed Windows process supervisor is missing.");
  if (options.stdio?.includes("ipc")) throw new Error("Windows Job host does not forward Node IPC.");
  return spawnProcess(host, windowsArguments(executable, args, { parentPid: options.parentPid, console: options.console, ready: options.ready,
    windowsCommand: options.windowsCommand, releaseOnSuccess: options.releaseOnSuccess }),
    { ...options, shell: false, detached: options.parentPid === null, windowsHide: true });
}

function signalOwned(child, signal, { platform = process.platform, kill = process.kill.bind(process) } = {}) {
  if (!child?.pid || (platform === "win32" && (child.exitCode !== null || child.signalCode !== null))) return;
  try { if (platform === "win32") child.kill(signal); else kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

module.exports = { spawnOwned, signalOwned, jobHostPath, windowsArguments };
