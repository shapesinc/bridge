"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { descendantGroups } = require("./embedded-children");
const { spawnOwned } = require("./owned-process");

// An app-owned process tree. No launchd registration, per-user app installation,
// standalone state, or shell command is involved in this lifecycle.
function createEmbeddedProcess({ spawnProcess = spawn, kill = process.kill.bind(process), groups = descendantGroups, graceMs = 5000, platform = process.platform, ownedSpawn = spawnOwned } = {}) {
  let child = null, stopping = null, runtimePid = null;
  const running = () => Boolean(child && child.exitCode === null && child.signalCode === null);
  async function stop() {
    if (stopping) return stopping;
    const owned = child;
    if (!owned || !Number.isInteger(owned.pid) || owned.pid <= 0) return;
    stopping = (async () => {
      const descendants = platform === "win32" ? [] : groups(owned.pid);
      const signalGroup = (pid, name) => { try { kill(-pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; } };
      const signal = (name) => { for (const pid of [...descendants, owned.pid]) signalGroup(pid, name); };
      let timer;
      const exited = new Promise((resolve) => {
        if (owned.exitCode !== null || owned.signalCode !== null) resolve();
        else owned.once("exit", resolve);
      });
      if (platform === "win32") owned.stdin.end(); else signal("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
      clearTimeout(timer);
      // Clean up any descendants left in our private process group as well.
      if (platform === "win32") {
        if (owned.exitCode === null && owned.signalCode === null) owned.kill();
      } else signal("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      if (owned.exitCode === null && owned.signalCode === null) throw new Error("Runtime did not stop");
      if (child === owned) { child = null; runtimePid = null; }
    })();
    try { await stopping; } finally { stopping = null; }
  }
  async function start() {
    if (stopping) await stopping;
    if (running()) return;
    if (platform === "win32") {
      child = ownedSpawn(process.execPath, [path.join(__dirname, "../bin/embedded-daemon.js")], {
        env: { ...process.env, SHAPES_BRIDGE_WINDOWS_SUPERVISED: "1" }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
      });
    } else child = spawnProcess(process.execPath, [path.join(__dirname, "../bin/embedded-daemon.js")], {
      env: process.env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    const owned = child;
    try {
      if (platform === "win32") await new Promise((resolve, reject) => {
        let bytes = "", finished = false;
        const finish = (error) => { if (finished) return; finished = true; clearTimeout(timer); owned.stdout.removeListener("data", read); error ? reject(error) : resolve(); };
        const read = (chunk) => {
          bytes += chunk.toString("utf8");
          if (bytes.length > 128) { finish(new Error("Invalid daemon handshake")); return; }
          if (!bytes.includes("\n")) return;
          try { const value = JSON.parse(bytes.trim()); if (!Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error(); runtimePid = value.pid; finish(); }
          catch { finish(new Error("Invalid daemon handshake")); }
        };
        const timer = setTimeout(() => finish(new Error("Daemon startup timed out")), 5000);
        owned.stdout.on("data", read); owned.once("error", finish); owned.once("exit", () => finish(new Error("Daemon exited")));
        owned.stdin.on("error", () => {});
      });
      else { await new Promise((resolve, reject) => { owned.once("spawn", resolve); owned.once("error", reject); }); runtimePid = owned.pid; }
    }
    catch (error) { if (platform === "win32" && owned.exitCode === null && owned.signalCode === null) owned.kill(); if (child === owned) { child = null; runtimePid = null; } throw error; }
  }
  return { start, stop, running, pid: () => running() ? runtimePid : null };
}

module.exports = { createEmbeddedProcess };
