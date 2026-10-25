"use strict";

// Run these checks from the installed service. Running them from the installer
// can inspect Terminal's TCC identity instead of the background runner's.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PANELS = {
  accessibility: "Privacy_Accessibility",
  screen_recording: "Privacy_ScreenCapture",
  full_disk_access: "Privacy_AllFiles",
  automation: "Privacy_Automation",
};
const PERMISSIONS = Object.keys(PANELS);
// Apps a shape controls most often; asking for them up front means no surprise
// prompt in the middle of a task. Finder is always running; System Events is
// launched on demand by the first event.
const AUTOMATION_TARGETS = ["com.apple.finder", "com.apple.systemevents"];
const LABELS = { accessibility: "Keyboard & mouse", screen_recording: "Screen recording", full_disk_access: "Protected files", automation: "App control" };

function probeSource(request = false) {
  const requestAccessibility = request === true || request === "accessibility";
  const requestScreen = request === true || request === "screen_recording";
  return `
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
ObjC.import('CoreServices');
ObjC.import('Foundation');
var result = {};
try {
  result.accessibility = ${requestAccessibility
    ? "$.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))"
    : "$.AXIsProcessTrusted()"} ? 'granted' : 'denied';
} catch (_) { result.accessibility = 'unknown'; }
try {
  ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
  ${requestScreen ? "ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);" : ""}
  result.screen_recording = ${requestScreen
    ? "($.CGPreflightScreenCaptureAccess() || $.CGRequestScreenCaptureAccess())"
    : "$.CGPreflightScreenCaptureAccess()"} ? 'granted' : 'denied';
} catch (_) { result.screen_recording = 'unknown'; }
try {
  // Automation is decided per target app. Ask nothing here: 0 = allowed,
  // -1743 = declined, -1744 = not asked yet, -600 = target not running.
  ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
  result.automation_targets = ${JSON.stringify(AUTOMATION_TARGETS)}.map(function (bundle) {
    var target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(bundle);
    return $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2A2A2A2A, 0x2A2A2A2A, false);
  });
} catch (_) { result.automation_targets = null; }
JSON.stringify(result);
`;
}

function automationState(codes) {
  if (!Array.isArray(codes)) return "unknown";
  const decided = codes.filter((code) => code !== -600);
  if (!decided.length) return "unknown";
  if (decided.some((code) => code === -1743 || code === -1744)) return "denied";
  return decided.every((code) => code === 0) ? "granted" : "unknown";
}

// Full Disk Access has no API. The TCC database exists for every account and
// is readable only with that grant; touching it also lists the app in the
// Full Disk Access pane so the person only has to turn it on.
function fullDiskAccessState({ home = os.homedir(), open = fs.openSync, close = fs.closeSync } = {}) {
  try { close(open(path.join(home, "Library", "Application Support", "com.apple.TCC", "TCC.db"), "r")); return "granted"; }
  catch (error) { return error?.code === "EPERM" || error?.code === "EACCES" ? "denied" : "unknown"; }
}

async function macPermissions({ request = false, execute = execFileAsync } = {}) {
  try {
    const { stdout } = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", probeSource(request)], {
      timeout: request ? 30000 : 10000,
      maxBuffer: 16384,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim());
    const state = (value) => ["granted", "denied", "unknown"].includes(value) ? value : "unknown";
    return { accessibility: state(parsed.accessibility), screen_recording: state(parsed.screen_recording), automation: automationState(parsed.automation_targets) };
  } catch {
    // A failed probe is not a granted permission, and no raw native diagnostic
    // (which can contain machine paths) belongs in account status.
    return { accessibility: "unknown", screen_recording: "unknown", automation: "unknown" };
  }
}

async function getPermissions({ platform = process.platform, execute = execFileAsync, fullDisk = fullDiskAccessState } = {}) {
  if (platform === "darwin") {
    return { ...await macPermissions({ execute }), full_disk_access: fullDisk() };
  }
  return {
    // Windows/Linux don't have macOS TCC grants. Desktop access still depends
    // on an interactive session, elevation, and the display server (Wayland).
    accessibility: "unsupported",
    screen_recording: "unsupported",
    full_disk_access: "unsupported",
    automation: "unsupported",
  };
}

// The Automation prompt blocks until the person answers, so it runs detached:
// the daemon's heartbeat must not stall behind a dialog.
function requestAutomation({ spawnProcess = spawn } = {}) {
  const source = `
ObjC.import('CoreServices'); ObjC.import('Foundation');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
${JSON.stringify(AUTOMATION_TARGETS)}.forEach(function (bundle) {
  try { $.NSWorkspace; } catch (_) {}
  var target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(bundle);
  $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2A2A2A2A, 0x2A2A2A2A, true);
});
`;
  try {
    const child = spawnProcess("/usr/bin/osascript", ["-l", "JavaScript", "-e", source], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch { /* best effort */ }
}

async function requestPermissions({ permission, platform = process.platform, execute = execFileAsync, spawnProcess = spawn, fullDisk = fullDiskAccessState } = {}) {
  if (permission !== undefined && !Object.hasOwn(PANELS, permission)) {
    throw new Error("Choose accessibility, screen_recording, full_disk_access, or automation.");
  }
  if (platform !== "darwin") return getPermissions({ platform, execute });
  const all = !permission;
  if (all || permission === "accessibility" || permission === "screen_recording") {
    await macPermissions({ request: permission || true, execute });
  }
  if (all || permission === "automation") requestAutomation({ spawnProcess });
  if (all || permission === "full_disk_access") {
    // Touch protected data first so the app is already listed in the pane.
    if (fullDisk() !== "granted") await execute("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${PANELS.full_disk_access}`], { timeout: 10000, maxBuffer: 16384 });
  } else if (permission && permission !== "automation") {
    await execute("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${PANELS[permission]}`], { timeout: 10000, maxBuffer: 16384 });
  }
  return getPermissions({ platform, execute, fullDisk });
}

module.exports = { PERMISSIONS, LABELS, AUTOMATION_TARGETS, automationState, fullDiskAccessState, getPermissions, requestPermissions };
