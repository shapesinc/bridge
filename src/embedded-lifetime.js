"use strict";

// Node's private IPC channel closes even when the native host/controller is
// killed. A detached daemon must never survive that boundary indefinitely.
function parentLifetime(parent = process, { timeoutMs = 8000, expire = () => {
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
} } = {}) {
  const controller = new AbortController();
  let timer;
  const lost = () => { if (controller.signal.aborted) return; controller.abort(); timer = setTimeout(expire, timeoutMs); timer.unref?.(); };
  parent.on("disconnect", lost);
  if (!parent.connected) lost();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeListener("disconnect", lost); } };
}

module.exports = { parentLifetime };
