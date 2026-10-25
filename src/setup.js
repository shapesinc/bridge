"use strict";

// One guided pass over every computer permission, driven by the installer but
// executed by the installed background app (the only identity macOS will
// attribute the grants to). Waits while the person answers the prompts.
const { PERMISSIONS, LABELS } = require("./permissions");

const STATE_TEXT = { granted: "allowed", denied: "needs access", unknown: "not checked", unsupported: "not needed", enabled: "on", disabled: "off" };

function checklist(permissions = {}) {
  return PERMISSIONS.map((key) => `  ${LABELS[key]}: ${STATE_TEXT[permissions[key]] || "not checked"}`).join("\n");
}

function allGranted(permissions = {}) {
  return PERMISSIONS.every((key) => permissions[key] === "granted");
}

async function guidedPermissionSetup({ readState, writeState, log, platform = process.platform, timeoutMs = 5 * 60 * 1000, pollMs = 2000, skip, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (platform !== "darwin") { log("No system permissions to set up on this computer."); return readState("status")?.permissions || {}; }
  log("Setting up computer permissions. macOS will ask for:\n  Keyboard & mouse (Accessibility)\n  Screen recording\n  App control (Automation for Finder and System Events)\n  Protected files: turn on shapes.inc Bridge in the Full Disk Access pane that opens\nApprove each one; this waits until they are all set." + (skip ? " Press Enter to continue without the rest." : ""));
  writeState("permission-request", {});
  const deadline = Date.now() + timeoutMs;
  let shown = "";
  let permissions = {};
  let skipped = false;
  // macOS shows the Accessibility and Screen Recording dialogs only once per
  // app; after that the grant is a switch in System Settings. Walk the person
  // through the remaining panes one at a time, in order, opening each once.
  const opened = new Set();
  const onSkip = skip ? skip().then(() => { skipped = true; }) : null;
  while (Date.now() < deadline && !skipped) {
    await Promise.race([sleep(pollMs), onSkip].filter(Boolean));
    if (skipped) break;
    permissions = readState("status")?.permissions || {};
    const text = checklist(permissions);
    if (text !== shown) { log(text); shown = text; }
    if (allGranted(permissions)) { log("All computer permissions are set."); return permissions; }
    const next = PERMISSIONS.find((key) => permissions[key] && permissions[key] !== "granted" && permissions[key] !== "unsupported" && !opened.has(key));
    if (next) {
      opened.add(next);
      log(`Turn on shapes.inc Bridge under ${LABELS[next]} in the System Settings pane that opens.`);
      writeState("permission-request", { permission: next });
    } else writeState("permission-request", { probe: true });
  }
  const missing = PERMISSIONS.filter((key) => permissions[key] !== "granted").map((key) => LABELS[key]);
  if (missing.length) log(`Still needed: ${missing.join(", ")}. Run permissions any time to finish, or turn them on in System Settings → Privacy & Security.`);
  return permissions;
}

module.exports = { checklist, allGranted, guidedPermissionSetup };
