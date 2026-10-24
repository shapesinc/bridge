"use strict";

// What opening the app (Finder, Spotlight, the Linux launcher, or `open`)
// should do, from the saved local state alone. No network, no account calls.
const { spawn } = require("node:child_process");

const COMPUTERS_PAGE = "https://talk.shapes.inc/settings/computers";

function describeOpenAction(config) {
  if (!config?.device_token) return { action: "setup", message: "This computer is not connected yet. Finish setup from the Computers page in shapes.inc.", openPage: true };
  if (config.revoked) return { action: "reinstall", message: "This computer was removed from your shapes.inc account. Run install again to reconnect it.", openPage: true };
  if (config.paused) return { action: "resume", message: "Reconnecting this computer to shapes.inc…", openPage: false };
  return { action: "restart", message: "Restarting the shapes.inc connection…", openPage: false };
}

function notify(message, { platform = process.platform, spawnProcess = spawn } = {}) {
  const run = (binary, args) => {
    try {
      const child = spawnProcess(binary, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => {});
      child.unref();
    } catch { /* Notifications are best effort. */ }
  };
  if (platform === "darwin") {
    const quoted = String(message).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    run("/usr/bin/osascript", ["-e", `display notification "${quoted}" with title "shapes.inc Bridge"`]);
  } else if (platform === "linux") run("notify-send", ["shapes.inc Bridge", String(message)]);
}

function openPage(url = COMPUTERS_PAGE, { platform = process.platform, spawnProcess = spawn } = {}) {
  const executable = platform === "darwin" ? "open" : platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawnProcess(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* No browser available. */ }
}

async function openApp({ readState, writeState, startService, notifier = notify, opener = openPage, log = () => {}, waitMs = 20000, pollMs = 1000 } = {}) {
  const state = readState || require("./state").readState;
  const write = writeState || require("./state").writeState;
  const start = startService || require("./service").startService;
  const config = state("config");
  const decision = describeOpenAction(config);
  log(decision.message);
  notifier(decision.message);
  if (decision.openPage) { opener(); return decision; }
  if (decision.action === "resume") write("config", { ...config, paused: false });
  start();
  const deadline = Date.now() + waitMs;
  let status = state("status");
  while (Date.now() < deadline && status?.connection !== "connected" && status?.connection !== "revoked") {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    status = state("status");
  }
  const result = status?.connection === "connected" ? "Connected. Your computer is ready in shapes.inc."
    : status?.connection === "revoked" ? "This computer was removed from your shapes.inc account. Run install again to reconnect it."
    : "Still connecting. It keeps retrying in the background.";
  log(result);
  notifier(result);
  return { ...decision, result };
}

module.exports = { COMPUTERS_PAGE, describeOpenAction, notify, openPage, openApp };
