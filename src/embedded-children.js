"use strict";

const { execFileSync } = require("node:child_process");

// Inspect ancestry while the daemon is alive, including detached supervisors.
// Neither a global process name nor a saved PID authorizes killing a process.
function descendants(root, { snapshot = () => execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }) } = {}) {
  const rows = snapshot().trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);
  let grew = true;
  while (grew) { grew = false; for (const [pid, parent] of rows) if (pid > 1 && owned.has(parent) && !owned.has(pid)) { owned.add(pid); grew = true; } }
  owned.delete(root);
  return [...owned];
}

function descendantGroups(root) {
  const snapshot = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const owned = new Set(descendants(root, { snapshot: () => snapshot }));
  return snapshot.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, , group]) => owned.has(pid) && group === pid).map(([pid]) => pid);
}

async function stopDescendants({ root = process.pid, collect = descendants, groups = descendantGroups, kill = process.kill.bind(process), graceMs = 1800 } = {}) {
  const signal = (pid, name) => { try { kill(pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  const owned = collect(root);
  const ownedGroups = groups(root);
  for (const pid of owned.reverse()) signal(pid, "SIGTERM");
  if (owned.length) await new Promise((resolve) => setTimeout(resolve, graceMs));
  // A detached supervisor may already have exited, leaving its child orphaned.
  // Its private process group was proven to belong to this daemon before TERM.
  for (const group of ownedGroups) signal(-group, "SIGKILL");
  // Recheck ancestry at escalation. Supervisors also perform their established
  // group cleanup, even for a child that has its own process group.
  for (const pid of collect(root).reverse()) signal(pid, "SIGKILL");
}

module.exports = { descendants, descendantGroups, stopDescendants };
