#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const stateIndex = argv.indexOf("--state-dir");
if (stateIndex !== -1) {
  if (!argv[stateIndex + 1]) throw new Error("--state-dir needs a directory.");
  process.env.SHAPES_BRIDGE_HOME = path.resolve(argv[stateIndex + 1]);
  argv.splice(stateIndex, 2);
}
const { stateDir, ensureStateDir, readState, writeState, removeState } = require("../src/state");
const { DEFAULT_API, validateApi, pairDevice, apiRequest } = require("../src/account");
const { startService, stopService, runtimePaths, APP_NAME } = require("../src/service");

const log = (value) => process.stdout.write(`${value}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${name} needs a value.`);
  return argv[index + 1];
}

function openBrowser(url) {
  const executable = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(executable, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

function showStatus() {
  const config = readState("config");
  if (!config) { log("This computer is not connected. Run: npx --yes --package=https://github.com/shapesinc/bridge/archive/refs/heads/main.tar.gz shapes-bridge install"); return; }
  const status = readState("status");
  const recent = status?.updated_at && Date.now() - Date.parse(status.updated_at) < 90000;
  const connection = config.paused ? "paused" : config.revoked ? "removed from your account" : recent ? status.connection : "offline";
  log(`shapes.inc Bridge: ${connection}\nComputer: ${config.name}\nVersion: ${require("../package.json").version}\nKeep awake: ${config.keep_awake === false ? "off" : "on"}`);
  if (config.revoked) log("Run install to connect this computer again.");
  if (status?.last_heartbeat) log(`Last connected: ${status.last_heartbeat}`);
  if (recent && status?.permissions) {
    for (const [name, value] of Object.entries(status.permissions)) log(`${name.replace(/_/g, " ")}: ${value}`);
  }
  if (recent && status?.error && !config.revoked) log(status.error);
  log("Manage computers and chat access in shapes.inc. Local controls: status, restart, pause, resume, update, permissions, logs, uninstall.");
}

async function install() {
  ensureStateDir();
  let config = readState("config");
  if (!config?.device_token || config.revoked) {
    log("Connect this computer once to your shapes.inc account. Approve access for each chat in shapes.inc.");
    config = await pairDevice({
      api: validateApi(option("--api-url", DEFAULT_API)),
      name: option("--name", undefined),
      onCode: async (pairing) => {
        log(`\nOpen ${pairing.verification_uri_complete}\nConfirmation code: ${pairing.user_code}\nWaiting for you to approve this computer…`);
        if (!argv.includes("--no-open")) openBrowser(pairing.verification_uri_complete);
      },
    });
  }
  config = { ...config, keep_awake: argv.includes("--no-awake") ? false : config.keep_awake !== false, paused: false, revoked: false };
  writeState("config", config);
  log("Installing the background connection for your account…");
  removeState("status");
  await startService({ install: true, log });
  log("Background startup is installed. Waiting for the connection…");
  const deadline = Date.now() + 45000;
  let status;
  do {
    await delay(1000);
    status = readState("status");
  } while (Date.now() < deadline && status?.connection !== "connected" && status?.connection !== "revoked");
  if (!status) throw new Error("The background service has not started. Run logs for details. Use the default install location; macOS may block background apps stored in Downloads or Desktop.");
  if (status.connection === "connected") log("Connected. shapes.inc Bridge starts automatically when you sign in to this computer.");
  else log("Setup saved. The background service is still connecting; it will retry automatically. Run status or logs to check progress.");
  log("Keep awake is " + (config.keep_awake ? "on (display lock and lid settings stay in place)." : "off."));
  if (!argv.includes("--no-permissions")) await guidedPermissions();
  log("You can close this terminal.");
  if (process.platform === "darwin") log(`${APP_NAME} is installed in ${runtimePaths().app}. Open it any time to restart the connection.`);
  log(`Local controls (no internet required): "${runtimePaths().launcher}" status | restart | pause | resume | update | permissions | logs | uninstall`);
  showStatus();
}

function pressEnter() {
  if (!process.stdin.isTTY) return null;
  return () => new Promise((resolve) => {
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.once("line", () => { rl.close(); resolve(); });
  });
}

async function guidedPermissions() {
  const { guidedPermissionSetup } = require("../src/setup");
  const permissions = await guidedPermissionSetup({ readState, writeState, log, skip: pressEnter() });
  if (process.stdin.isTTY) process.stdin.pause();
  return permissions;
}

async function waitForConnection(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  do {
    await delay(1000);
    status = readState("status");
  } while (Date.now() < deadline && status?.connection !== "connected" && status?.connection !== "revoked");
  return status;
}

async function main() {
  const command = argv[0] || (readState("config") ? "status" : "install");
  if (command === "install" || command === "setup") return install();
  if (command === "status") return showStatus();
  if (command === "open") { await require("../src/open").openApp({ log }); return; }
  if (command === "foreground") { require("./foreground"); return; }
  if (command === "daemon") {
    const { runDaemon, enablePrivateLog } = require("../src/runtime");
    ensureStateDir(); enablePrivateLog();
    try { await runDaemon(); } finally {
      // Nothing useful outlives the connection loop; never linger as an
      // orphaned process behind a stray handle after a stop or restart.
      process.exit(process.exitCode || 0);
    }
  }
  if (command === "logs") {
    const file = path.join(stateDir(), "service.log");
    if (fs.existsSync(file)) log(fs.readFileSync(file, "utf8").slice(-24000));
    else log("No local activity log yet.");
    return;
  }
  if (["--help", "help", "-h"].includes(command)) {
    log("shapes.inc Bridge\n  install       Pair once and install the background connection\n  status        Connection and native permission status\n  restart       Restart the background connection\n  update        Install the latest shapes.inc Bridge without pairing again\n  open          What opening the app does: restart, or resume when paused\n  pause         Disconnect and stop automatic startup\n  resume        Reconnect and restore automatic startup\n  permissions   Set up every computer permission in one pass (or name one:\n                accessibility, screen_recording, full_disk_access, automation)\n  awake on|off  Keep the computer awake while connected\n  logs          Recent local activity (may contain private command text)\n  uninstall     Revoke account access and remove the background service\n  foreground    Temporary legacy connection until the terminal closes\n\nInstall options: --name <name>, --no-open, --no-awake, --no-permissions\nDevelopment: --api-url http://127.0.0.1:<port>, --state-dir <directory>");
    return;
  }
  const config = readState("config");
  if (!config?.device_token) throw new Error("Run install first to connect this computer to shapes.inc.");
  if (command === "pause") {
    stopService();
    writeState("config", { ...config, paused: true });
    try { await apiRequest(config.api, "/devices/offline", {}, config.device_token, "POST", 2500); }
    catch { log("Computer access is stopped locally. Account status will update when its last heartbeat expires."); }
    log("Paused. This computer is disconnected and will stay paused after restart. Run resume to reconnect.");
  } else if (command === "restart") {
    if (config.revoked) throw new Error("This computer was removed from shapes.inc. Run install to reconnect.");
    if (config.paused) throw new Error("This computer is paused. Run resume to reconnect.");
    removeState("status");
    await startService();
    log("Restarting the background connection…");
    const status = await waitForConnection();
    if (!status) throw new Error("The background service has not started. Run logs for details.");
    showStatus();
  } else if (command === "update") {
    if (config.revoked) throw new Error("This computer was removed from shapes.inc. Run install to reconnect.");
    log("Downloading the latest shapes.inc Bridge…");
    const update = await require("../src/update").downloadRuntime();
    try {
      if (config.paused) { stopService(); await require("../src/service").copyRuntime(update.source, { log }); log(`Updated to ${update.version}. This computer stays paused; run resume to reconnect.`); return; }
      removeState("status");
      await startService({ install: true, source: update.source, log });
      log(`Updated to ${update.version}. Reconnecting in the background…`);
      await waitForConnection();
      showStatus();
    } finally { update.cleanup(); }
  } else if (command === "resume") {
    if (config.revoked) throw new Error("This computer was removed from shapes.inc. Run install to reconnect.");
    writeState("config", { ...config, paused: false });
    await startService(); log("Reconnecting in the background. Automatic startup restored.");
  } else if (command === "permissions") {
    if (config.paused || config.revoked) throw new Error("Resume the computer connection before requesting native permissions.");
    const permission = argv[1];
    if (permission && !["accessibility", "screen_recording", "full_disk_access", "automation"].includes(permission)) throw new Error("Unknown permission. Run help for the supported permission names.");
    if (!permission) { await guidedPermissions(); return; }
    writeState("permission-request", { permission });
    log("Permission requested from the installed background app. Approve the prompt or turn on shapes.inc Bridge in the System Settings pane that opens.");
    await delay(3000); showStatus();
  } else if (command === "awake") {
    if (!["on", "off"].includes(argv[1])) throw new Error("Use awake on or awake off.");
    writeState("config", { ...config, keep_awake: argv[1] === "on" });
    if (!config.paused && !config.revoked) await startService();
    log(`Keep awake ${argv[1]}.`);
  } else if (command === "uninstall") {
    stopService({ remove: true });
    writeState("config", { ...config, paused: true });
    if (!config.revoked) {
      try { await apiRequest(config.api, "/devices/current", undefined, config.device_token, "DELETE"); }
      catch (error) {
        if (error.status !== 401) throw new Error("Background connection stopped. Could not remove it from your account; reconnect to the internet and run uninstall again, or remove it in shapes.inc settings.");
      }
    }
    removeState("config"); removeState("status"); removeState("permission-request");
    log("Disconnected and removed from your shapes.inc account. Automatic startup is removed. Local runtime and private logs remain in " + stateDir() + ".");
  } else throw new Error(`Unknown command: ${command}. Run help for available commands.`);
}

main().catch((error) => { process.stderr.write(`shapes.inc Bridge: ${error.message}\n`); process.exitCode = 1; });
