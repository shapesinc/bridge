"use strict";
const { signalOwned, ownedCleanup, waitForOwnedCleanup, disposeOwned } = require("./owned-process");

// A process group's exit and its stdio reaching EOF are different boundaries:
// a detached descendant can retain a pipe after the owned parent has exited.
// This only confirms the parent's exit, never arbitrary escaped descendants.
async function closeProcessGroup(child, { graceMs = 1500, exitTimeoutMs = 1500,
  signal = (_pid, name) => signalOwned(child, name) } = {}) {
  let exited = child.exitCode != null || child.signalCode != null || !child.pid;
  let exitCode = child.exitCode ?? null, exitSignal = child.signalCode ?? null;
  let notify;
  const exit = new Promise((resolve) => { notify = resolve; });
  const onExit = (code, name) => { exited = true; exitCode = code; exitSignal = name; notify(); };
  child.once("exit", onExit);
  const send = (name) => {
    if (!child.pid) return;
    try { signal(child.pid, name); } catch { /* The exit observation is authoritative. */ }
  };
  const wait = async (ms) => {
    if (exited) return;
    let timer;
    try { await Promise.race([exit, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    send("SIGTERM");
    // Native Job termination polls up to750ms; account-only callers request a
    // shorter POSIX grace. Keep a 1s Windows receipt window before hard kill.
    await wait(ownedCleanup(child) === undefined ? graceMs : Math.max(graceMs, 1000));
    // The parent can exit before ordinary descendants in its private group.
    send("SIGKILL");
    await wait(exitTimeoutMs);
    let cleanup = ownedCleanup(child);
    if (exited && cleanup === false) {
      let timer;
      try { cleanup = await Promise.race([waitForOwnedCleanup(child), new Promise((resolve) => { timer = setTimeout(() => resolve(false), exitTimeoutMs); })]); }
      finally { clearTimeout(timer); }
    }
    // For a Job observer, its exit is insufficient: only its private native
    // all-members-exited receipt confirms the owned process boundary.
    return { exitCode, signal: exitSignal, processExited: exited && cleanup !== false };
  } finally {
    child.removeListener("exit", onExit);
    disposeOwned(child);
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
    // A failed exit confirmation must not hold the supervisor's receipt open.
    // The caller reports the uncertainty; it must not claim cleanup succeeded.
    if (!exited) child.unref();
  }
}

module.exports = { closeProcessGroup };
