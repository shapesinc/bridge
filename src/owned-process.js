"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function jobHostPath() { return path.join(path.dirname(process.execPath), "shapes.inc Bridge Job.exe"); }
function windowsArguments(executable, args, { parentPid = process.pid, console = false, ready = false, windowsCommand = false } = {}) {
  if (!path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable) || executable.includes("\0") || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("An absolute installed Windows executable is required.");
  }
  if (windowsCommand && (path.win32.basename(executable).toLowerCase() !== "cmd.exe" || args.length !== 1 || /[\r\n]/.test(args[0]))) throw new Error("Invalid Windows command transport.");
  return ["--parent-pid", String(parentPid), ...(ready ? ["--ready"] : []), ...(console ? ["--console"] : []),
    ...(windowsCommand ? ["--command-string"] : []), "--", executable, ...args];
}

// Windows uses kernel-owned Jobs rather than shell/taskkill process-tree
// snapshots. Every process started through this primitive dies with its exact
// supervisor, including descendants created after a cancellation begins.
function spawnOwned(executable, args, options = {}, { platform = process.platform, spawnProcess = spawn, host = jobHostPath(), exists = fs.existsSync } = {}) {
  if (platform !== "win32") return spawnProcess(executable, args, { ...options, detached: true });
  if (!exists(host)) throw new Error("The installed Windows process supervisor is missing.");
  if (options.stdio?.includes("ipc")) throw new Error("Windows Job host does not forward Node IPC.");
  return spawnProcess(host, windowsArguments(executable, args, { console: options.console, ready: options.ready, windowsCommand: options.windowsCommand }),
    { ...options, shell: false, detached: false, windowsHide: true });
}

function signalOwned(child, signal, { platform = process.platform, kill = process.kill.bind(process) } = {}) {
  if (!child?.pid || (platform === "win32" && (child.exitCode !== null || child.signalCode !== null))) return;
  try { if (platform === "win32") child.kill(signal); else kill(-child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

module.exports = { spawnOwned, signalOwned, jobHostPath, windowsArguments };
