"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { stateDir, ensureStateDir } = require("./state");

const LABEL = "inc.shapes.bridge";
const APP_NAME = "shapes.inc Bridge";
const TASK_NAME = "shapes.inc Bridge";
const LEGACY_TASK_NAME = "Shapes Bridge";
const VERSION = require("../package.json").version;
const xml = (value) => String(value).replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[char]));
const unitQuote = (value) => '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\n/g, "\\n") + '"';
const unitCommandQuote = (value) => unitQuote(value).replace(/\$/g, () => "$$");

function defaultStateDir(home = os.homedir()) {
  return path.join(home, ".shapes-bridge");
}

function runtimePaths(dir = stateDir(), platform = process.platform, home = os.homedir()) {
  const launcher = path.join(dir, platform === "win32" ? "shapes-bridge.cmd" : "shapes-bridge");
  if (platform === "darwin") {
    // A real app bundle: Finder, Spotlight, Login Items and permission prompts
    // show the shapes.inc name and icon instead of an anonymous "node" binary.
    const parent = path.resolve(dir) === path.resolve(defaultStateDir(home)) ? path.join(home, "Applications") : dir;
    const app = path.join(parent, `${APP_NAME}.app`);
    const runtime = path.join(app, "Contents", "Resources", "runtime");
    return {
      app, runtime, launcher,
      node: path.join(app, "Contents", "MacOS", APP_NAME),
      cli: path.join(runtime, "bin", "cli.js"),
      plist: path.join(app, "Contents", "Info.plist"),
      icon: path.join(app, "Contents", "Resources", `${APP_NAME}.icns`),
      legacyRuntime: path.join(dir, "runtime"),
    };
  }
  const runtime = path.join(dir, "runtime");
  const cli = path.join(runtime, "bin", "cli.js");
  if (platform === "win32") return { runtime, cli, launcher, node: path.join(runtime, `${APP_NAME}.exe`), legacyNode: path.join(runtime, "node.exe") };
  return {
    runtime, cli, launcher,
    node: path.join(runtime, "shapes.inc-bridge"),
    legacyNode: path.join(runtime, "node"),
    icon: path.join(runtime, `${APP_NAME}.png`),
    desktop: path.join(home, ".local", "share", "applications", `${LABEL}.desktop`),
  };
}

function launcherContent(dir = stateDir(), platform = process.platform, home = os.homedir()) {
  const paths = runtimePaths(dir, platform, home);
  if (platform === "win32") {
    const batch = (value) => String(value).replace(/%/g, "%%");
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "SHAPES_BRIDGE_HOME=${batch(dir)}"\r\n"${batch(paths.node)}" "${batch(paths.cli)}" %*\r\n`;
  }
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  return `#!/bin/sh\nSHAPES_BRIDGE_HOME=${quote(dir)} exec ${quote(paths.node)} ${quote(paths.cli)} "$@"\n`;
}

function infoPlist({ dir = stateDir(), home = os.homedir() } = {}) {
  const paths = runtimePaths(dir, "darwin", home);
  // Opening the app from Finder or Spotlight starts Node with no script;
  // LaunchServices applies this environment only to that launch path, so the
  // open hook restarts the connection while launchd's daemon launch is untouched.
  const openHook = path.join(paths.runtime, "bin", "open.js");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>CFBundleName</key><string>${APP_NAME}</string>
<key>CFBundleDisplayName</key><string>${APP_NAME}</string>
<key>CFBundleIdentifier</key><string>${LABEL}</string>
<key>CFBundleExecutable</key><string>${APP_NAME}</string>
<key>CFBundleIconFile</key><string>${APP_NAME}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleShortVersionString</key><string>${xml(VERSION)}</string>
<key>CFBundleVersion</key><string>${xml(VERSION)}</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>LSEnvironment</key><dict><key>NODE_OPTIONS</key><string>--require "${xml(openHook)}"</string></dict>
<key>NSAppleEventsUsageDescription</key><string>shapes.inc Bridge controls apps on this computer for the chats you allowed.</string>
<key>NSHumanReadableCopyright</key><string>© Shapes, Inc.</string>
</dict></plist>\n`;
}

function desktopEntry({ dir = stateDir(), home = os.homedir() } = {}) {
  const paths = runtimePaths(dir, "linux", home);
  const value = (text) => String(text).replace(/\n/g, " ");
  const exec = (text) => '"' + String(text).replace(/[\\"`$]/g, (char) => `\\${char}`) + '"';
  return `[Desktop Entry]\nType=Application\nName=${value(APP_NAME)}\nComment=Computer connection for shapes.inc\nExec=${exec(paths.launcher)} open\nIcon=${value(paths.icon)}\nTerminal=false\nCategories=Utility;\nStartupNotify=false\n`;
}

function serviceDefinition({ platform = process.platform, home = os.homedir(), dir = stateDir(), envPath = process.env.PATH || "", user = os.userInfo().username } = {}) {
  const { node, cli } = runtimePaths(dir, platform, home);
  if (platform === "darwin") return {
    file: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>AssociatedBundleIdentifiers</key><array><string>${LABEL}</string></array>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>daemon</string></array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string><key>SHAPES_BRIDGE_HOME</key><string>${xml(dir)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(dir, "service.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(dir, "service.log"))}</string>
</dict></plist>\n`,
  };
  if (platform === "linux") return {
    file: path.join(home, ".config", "systemd", "user", `${LABEL}.service`),
    content: `[Unit]\nDescription=shapes.inc Bridge\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${unitCommandQuote(node)} ${unitCommandQuote(cli)} daemon\nWorkingDirectory=${unitQuote(home)}\nEnvironment=${unitQuote(`PATH=${envPath}`)}\nEnvironment=${unitQuote(`SHAPES_BRIDGE_HOME=${dir}`)}\nRestart=always\nRestartSec=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
  };
  if (platform === "win32") return {
    file: path.join(dir, "service-task.xml"),
    content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>shapes.inc Bridge</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(`"${cli}" daemon --state-dir "${dir}"`)}</Arguments><WorkingDirectory>${xml(home)}</WorkingDirectory></Exec></Actions></Task>\n`,
  };
  throw new Error(`Background installation is not supported on ${platform}.`);
}

function command(binary, args, { optional = false } = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true });
  if (!optional && (result.error || result.status !== 0)) {
    throw new Error(`${binary} could not configure the shapes.inc background service: ${(result.error?.message || result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result;
}

function detachedCommand(binary, args) {
  try {
    const child = spawn(binary, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* The service manager is unavailable; the definition file is already gone. */ }
}

function copyFiles(source, runtime) {
  for (const folder of ["src", "bin", "assets"]) {
    const from = path.join(source, folder);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(path.join(runtime, folder), { recursive: true, force: true });
    fs.cpSync(from, path.join(runtime, folder), { recursive: true });
  }
  for (const file of ["package.json", "README.md", "LICENSE"]) {
    if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(runtime, file));
  }
}

function buildMacApp(source, paths, { sign = (app) => command("codesign", ["--force", "--sign", "-", "--identifier", LABEL, app]) } = {}) {
  // Build next to the installed app, then swap, so a running runner (this
  // installer, or the daemon) never has its own executable re-signed in place.
  const staging = `${paths.app}.staging`;
  const stagedRuntime = path.join(staging, "Contents", "Resources", "runtime");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(stagedRuntime, { recursive: true });
  copyFiles(source, stagedRuntime);
  const icon = path.join(stagedRuntime, "assets", "shapes-inc-bridge.icns");
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(staging, "Contents", "Resources", path.basename(paths.icon)));
  fs.writeFileSync(path.join(staging, "Contents", "Info.plist"), infoPlist());
  fs.writeFileSync(path.join(staging, "Contents", "PkgInfo"), "APPL????");
  const node = path.join(staging, "Contents", "MacOS", APP_NAME);
  fs.copyFileSync(process.execPath, node);
  fs.chmodSync(node, 0o755);
  sign(staging);
  const previous = `${paths.app}.previous`;
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(paths.app)) fs.renameSync(paths.app, previous);
  fs.renameSync(staging, paths.app);
  fs.rmSync(previous, { recursive: true, force: true });
}

function copyRuntime(source = path.resolve(__dirname, "..")) {
  const paths = runtimePaths(ensureStateDir());
  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(paths.app), { recursive: true });
    buildMacApp(path.resolve(source) === path.resolve(paths.runtime) ? paths.runtime : source, paths);
    if (path.resolve(paths.legacyRuntime) !== path.resolve(paths.runtime)) fs.rmSync(paths.legacyRuntime, { recursive: true, force: true });
  } else {
    fs.mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
    if (path.resolve(source) !== path.resolve(paths.runtime)) copyFiles(source, paths.runtime);
    if (path.resolve(process.execPath) !== path.resolve(paths.node)) fs.copyFileSync(process.execPath, paths.node);
    if (process.platform !== "win32") fs.chmodSync(paths.node, 0o700);
    if (paths.legacyNode && path.resolve(paths.legacyNode) !== path.resolve(process.execPath)) fs.rmSync(paths.legacyNode, { force: true });
    const png = path.join(paths.runtime, "assets", "shapes-inc-bridge.png");
    if (paths.icon && fs.existsSync(png)) fs.copyFileSync(png, paths.icon);
  }
  fs.writeFileSync(paths.launcher, launcherContent(), { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(paths.launcher, 0o700);
  return paths;
}

function assertServiceOwner(definition = serviceDefinition()) {
  if (!fs.existsSync(definition.file)) return;
  const current = fs.readFileSync(definition.file, process.platform === "win32" ? "utf16le" : "utf8");
  const paths = runtimePaths();
  const accepted = [paths.cli, paths.legacyRuntime && path.join(paths.legacyRuntime, "bin", "cli.js")].filter(Boolean)
    .map((cli) => process.platform === "linux" ? unitCommandQuote(cli) : xml(cli));
  if (!accepted.some((expected) => current.includes(expected))) {
    throw new Error("Another shapes.inc Bridge installation owns this background service. Pause or uninstall that installation before using a different --state-dir.");
  }
}

function waitForStopped(isRunning, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (isRunning()) {
    if (Date.now() >= deadline) return false;
    // Service managers acknowledge a stop before the process finishes its
    // short offline heartbeat. Wait for that graceful shutdown, not just ACK.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return true;
}

function stopService({ remove = false } = {}) {
  const definition = serviceDefinition();
  assertServiceOwner(definition);
  if (process.platform === "darwin") {
    command("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { optional: true });
    if (!waitForStopped(() => command("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`], { optional: true }).status === 0)) {
      throw new Error("The background connection could not be stopped. Check launchctl before continuing.");
    }
  } else if (process.platform === "linux") {
    command("systemctl", ["--user", "disable", "--now", `${LABEL}.service`], { optional: true });
    if (!waitForStopped(() => command("systemctl", ["--user", "is-active", "--quiet", `${LABEL}.service`], { optional: true }).status === 0)) {
      throw new Error("The background connection could not be stopped. Check your user systemd service before continuing.");
    }
    if (remove) fs.rmSync(runtimePaths().desktop, { force: true });
  } else {
    for (const name of [TASK_NAME, LEGACY_TASK_NAME]) {
      command("schtasks.exe", ["/End", "/TN", name], { optional: true });
      command("schtasks.exe", ["/Change", "/TN", name, "/Disable"], { optional: true });
    }
    if (!waitForStopped(() => command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if ((Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State -eq 'Running' -or (Get-ScheduledTask -TaskName '${LEGACY_TASK_NAME}' -ErrorAction SilentlyContinue).State -eq 'Running') { exit 1 }`], { optional: true }).status !== 0)) {
      throw new Error("Could not confirm that the Windows background task stopped. Check Task Scheduler before continuing.");
    }
    // The task was renamed; an older installation's task must not start a second copy at sign-in.
    command("schtasks.exe", ["/Delete", "/TN", LEGACY_TASK_NAME, "/F"], { optional: true });
    if (remove) command("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], { optional: true });
  }
  if (remove || process.platform === "darwin") fs.rmSync(definition.file, { force: true });
}

function startService({ install = false, source } = {}) {
  ensureStateDir();
  stopService();
  if (install) copyRuntime(source);
  const definition = serviceDefinition();
  fs.mkdirSync(path.dirname(definition.file), { recursive: true });
  const logFile = path.join(stateDir(), "service.log");
  fs.closeSync(fs.openSync(logFile, "a", 0o600));
  if (process.platform !== "win32") fs.chmodSync(logFile, 0o600);
  fs.writeFileSync(definition.file, definition.content, { mode: 0o600, encoding: process.platform === "win32" ? "utf16le" : "utf8" });
  if (process.platform === "darwin") {
    command("launchctl", ["bootstrap", `gui/${process.getuid()}`, definition.file]);
  } else if (process.platform === "linux") {
    const paths = runtimePaths();
    try {
      fs.mkdirSync(path.dirname(paths.desktop), { recursive: true });
      fs.writeFileSync(paths.desktop, desktopEntry(), { mode: 0o644 });
    } catch { /* No desktop launcher directory; the service still runs. */ }
    command("systemctl", ["--user", "daemon-reload"]);
    command("systemctl", ["--user", "enable", "--now", `${LABEL}.service`]);
  } else {
    command("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", definition.file, "/F"]);
    command("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
  }
}

// Called from inside the daemon once the account has removed this computer:
// drop automatic startup so it does not relaunch at every sign-in and idle.
function disableStartup() {
  const definition = serviceDefinition();
  if (process.platform === "win32") {
    detachedCommand("schtasks.exe", ["/Change", "/TN", TASK_NAME, "/Disable"]);
    return;
  }
  fs.rmSync(definition.file, { force: true });
  if (process.platform === "darwin") detachedCommand("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]);
  else detachedCommand("systemctl", ["--user", "disable", "--now", `${LABEL}.service`]);
}

module.exports = { LABEL, APP_NAME, TASK_NAME, runtimePaths, launcherContent, infoPlist, desktopEntry, serviceDefinition, assertServiceOwner, buildMacApp, copyRuntime, startService, stopService, disableStartup };
