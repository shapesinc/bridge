"use strict";

const { spawn } = require("node:child_process");

// The shape's on-screen pointer (macOS): one long-lived accessory process of
// the signed computer helper, started on demand and fed one JSON command per
// line. It only draws; it never posts input. It exits on EOF (including when
// this runtime exits) or after a minute without commands, and is restarted on
// the next action.
function createShapeCursor({ platform = process.platform, binary, spawnImpl = spawn } = {}) {
  let child = null;
  function ensure() {
    if (platform !== "darwin" || !binary) return null;
    if (child && child.exitCode === null && child.signalCode === null && child.stdin?.writable) return child;
    try {
      const started = spawnImpl(binary, ["--cursor"], { stdio: ["pipe", "ignore", "ignore"] });
      const forget = () => { if (child === started) child = null; };
      started.on("error", forget);
      started.on("exit", forget);
      started.stdin.on("error", forget);
      // The pointer must never keep the runtime alive on its own.
      started.unref?.();
      started.stdin.unref?.();
      child = started;
    } catch { child = null; }
    return child;
  }
  function send(command) {
    const target = ensure();
    if (!target) return false;
    try { target.stdin.write(`${JSON.stringify(command)}\n`); return true; } catch { return false; }
  }
  function close() {
    const target = child;
    child = null;
    try { target?.stdin.end(); } catch {}
  }
  return { send, close };
}

module.exports = { createShapeCursor };
