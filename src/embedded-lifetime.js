"use strict";

// Node's private IPC channel closes even when the native host/controller is
// killed. A detached daemon must never survive that boundary indefinitely.
function parentLifetime(parent = process, { timeoutMs = 8000, input, expire = () => {
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
} } = {}) {
  const controller = new AbortController();
  let timer;
  const lost = () => { if (controller.signal.aborted) return; controller.abort(); timer = setTimeout(expire, timeoutMs); timer.unref?.(); };
  if (input) { input.on("end", lost); input.on("error", lost); input.resume(); }
  else { parent.on("disconnect", lost); if (!parent.connected) lost(); }
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeListener("disconnect", lost); input?.removeListener("end", lost); input?.removeListener("error", lost); } };
}

module.exports = { parentLifetime };
