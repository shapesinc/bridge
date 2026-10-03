"use strict";

// Run these checks from the installed service. Running them from the installer
// can inspect Terminal's TCC identity instead of the background runner's.
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PANELS = {
  accessibility: "Privacy_Accessibility",
  screen_recording: "Privacy_ScreenCapture",
  full_disk_access: "Privacy_AllFiles",
  automation: "Privacy_Automation",
};

function probeSource(request = false) {
  const requestAccessibility = request === true || request === "accessibility";
  const requestScreen = request === true || request === "screen_recording";
  return `
ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
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
JSON.stringify(result);
`;
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
    return { accessibility: state(parsed.accessibility), screen_recording: state(parsed.screen_recording) };
  } catch {
    // A failed probe is not a granted permission, and no raw native diagnostic
    // (which can contain machine paths) belongs in account status.
    return { accessibility: "unknown", screen_recording: "unknown" };
  }
}

async function getPermissions({ platform = process.platform, execute = execFileAsync } = {}) {
  if (platform === "darwin") {
    return {
      ...await macPermissions({ execute }),
      // macOS grants Automation per target app and exposes no public blanket
      // Full Disk Access preflight. Do not infer either from a readable folder.
      full_disk_access: "unknown",
      automation: "unknown",
    };
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

async function requestPermissions({ permission, platform = process.platform, execute = execFileAsync } = {}) {
  if (permission !== undefined && !Object.hasOwn(PANELS, permission)) {
    throw new Error("Choose accessibility, screen_recording, full_disk_access, or automation.");
  }
  if (platform !== "darwin") return getPermissions({ platform, execute });
  if (!permission || permission === "accessibility" || permission === "screen_recording") {
    await macPermissions({ request: permission || true, execute });
  }
  if (permission) {
    await execute("/usr/bin/open", [
      `x-apple.systempreferences:com.apple.preference.security?${PANELS[permission]}`,
    ], { timeout: 10000, maxBuffer: 16384 });
  }
  return getPermissions({ platform, execute });
}

module.exports = { getPermissions, requestPermissions };
