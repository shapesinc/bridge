"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { descendantGroups } = require("./embedded-children");

// An app-owned process tree. No launchd registration, per-user app installation,
// standalone state, or shell command is involved in this lifecycle.
function createEmbeddedProcess({ spawnProcess = spawn, kill = process.kill.bind(process), groups = descendantGroups, graceMs = 5000 } = {}) {
  let child = null, stopping = null;
  const running = () => Boolean(child && child.exitCode === null && child.signalCode === null);
  async function stop() {
    if (stopping) return stopping;
    const owned = child;
    if (!owned || !Number.isInteger(owned.pid) || owned.pid <= 0) return;
    stopping = (async () => {
      const descendants = groups(owned.pid);
      const signalGroup = (pid, name) => { try { kill(-pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; } };
      const signal = (name) => { for (const pid of [...descendants, owned.pid]) signalGroup(pid, name); };
      let timer;
      const exited = new Promise((resolve) => {
        if (owned.exitCode !== null || owned.signalCode !== null) resolve();
        else owned.once("exit", resolve);
      });
      signal("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
      clearTimeout(timer);
      // Clean up any descendants left in our private process group as well.
      signal("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
      clearTimeout(timer);
      if (owned.exitCode === null && owned.signalCode === null) throw new Error("Runtime did not stop");
      if (child === owned) child = null;
    })();
    try { await stopping; } finally { stopping = null; }
  }
  async function start() {
    if (stopping) await stopping;
    if (running()) return;
    child = spawnProcess(process.execPath, [path.join(__dirname, "../bin/embedded-daemon.js")], {
      env: process.env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    const owned = child;
    try { await new Promise((resolve, reject) => { owned.once("spawn", resolve); owned.once("error", reject); }); }
    catch (error) { if (child === owned) child = null; throw error; }
  }
  return { start, stop, running, pid: () => running() ? child.pid : null };
}

module.exports = { createEmbeddedProcess };
