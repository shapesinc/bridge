"use strict";

// A process group's exit and its stdio reaching EOF are different boundaries:
// a detached descendant can retain a pipe after the owned parent has exited.
// This only confirms the parent's exit, never arbitrary escaped descendants.
async function closeProcessGroup(child, { graceMs = 1500, exitTimeoutMs = 1500,
  signal = (pid, name) => process.kill(-pid, name) } = {}) {
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
    await wait(graceMs);
    // The parent can exit before ordinary descendants in its private group.
    send("SIGKILL");
    await wait(exitTimeoutMs);
    return { exitCode, signal: exitSignal, processExited: exited };
  } finally {
    child.removeListener("exit", onExit);
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
    // A failed exit confirmation must not hold the supervisor's receipt open.
    // The caller reports the uncertainty; it must not claim cleanup succeeded.
    if (!exited) child.unref();
  }
}

module.exports = { closeProcessGroup };
