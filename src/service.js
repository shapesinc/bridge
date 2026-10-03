"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stateDir, ensureStateDir } = require("./state");

const LABEL = "inc.shapes.bridge";
const TASK_NAME = "Shapes Bridge";
const xml = (value) => String(value).replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[char]));
const unitQuote = (value) => '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\n/g, "\\n") + '"';
const unitCommandQuote = (value) => unitQuote(value).replace(/\$/g, () => "$$");

function runtimePaths(dir = stateDir(), platform = process.platform) {
  const runtime = path.join(dir, "runtime");
  return { runtime, node: path.join(runtime, platform === "win32" ? "node.exe" : platform === "darwin" ? "Shapes Bridge" : "node"), cli: path.join(runtime, "bin", "cli.js"), launcher: path.join(dir, platform === "win32" ? "shapes-bridge.cmd" : "shapes-bridge") };
}

function launcherContent(dir = stateDir(), platform = process.platform) {
  const paths = runtimePaths(dir, platform);
  if (platform === "win32") {
    const batch = (value) => String(value).replace(/%/g, "%%");
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "SHAPES_BRIDGE_HOME=${batch(dir)}"\r\n"${batch(paths.node)}" "${batch(paths.cli)}" %*\r\n`;
  }
  const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
  return `#!/bin/sh\nSHAPES_BRIDGE_HOME=${quote(dir)} exec ${quote(paths.node)} ${quote(paths.cli)} "$@"\n`;
}

function serviceDefinition({ platform = process.platform, home = os.homedir(), dir = stateDir(), envPath = process.env.PATH || "", user = os.userInfo().username } = {}) {
  const { node, cli } = runtimePaths(dir, platform);
  if (platform === "darwin") return {
    file: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
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
    content: `[Unit]\nDescription=Shapes computer connection\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${unitCommandQuote(node)} ${unitCommandQuote(cli)} daemon\nWorkingDirectory=${unitQuote(home)}\nEnvironment=${unitQuote(`PATH=${envPath}`)}\nEnvironment=${unitQuote(`SHAPES_BRIDGE_HOME=${dir}`)}\nRestart=always\nRestartSec=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
  };
  if (platform === "win32") return {
    file: path.join(dir, "service-task.xml"),
    content: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(`"${cli}" daemon --state-dir "${dir}"`)}</Arguments><WorkingDirectory>${xml(home)}</WorkingDirectory></Exec></Actions></Task>\n`,
  };
  throw new Error(`Background installation is not supported on ${platform}.`);
}

function command(binary, args, { optional = false } = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", windowsHide: true });
  if (!optional && (result.error || result.status !== 0)) {
    throw new Error(`${binary} could not configure the Shapes background service: ${(result.error?.message || result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result;
}

function copyRuntime(source = path.resolve(__dirname, "..")) {
  const paths = runtimePaths(ensureStateDir());
  fs.mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  if (path.resolve(source) !== path.resolve(paths.runtime)) {
    for (const folder of ["src", "bin"]) fs.cpSync(path.join(source, folder), path.join(paths.runtime, folder), { recursive: true });
    for (const file of ["package.json", "README.md", "LICENSE"]) {
      if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(paths.runtime, file));
    }
  }
  if (path.resolve(process.execPath) !== path.resolve(paths.node)) fs.copyFileSync(process.execPath, paths.node);
  if (process.platform !== "win32") fs.chmodSync(paths.node, 0o700);
  fs.writeFileSync(paths.launcher, launcherContent(), { mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(paths.launcher, 0o700);
  return paths;
}

function assertServiceOwner(definition = serviceDefinition()) {
  if (!fs.existsSync(definition.file)) return;
  const current = fs.readFileSync(definition.file, process.platform === "win32" ? "utf16le" : "utf8");
  const cli = runtimePaths().cli;
  const expected = process.platform === "linux" ? unitCommandQuote(cli) : xml(cli);
  if (!current.includes(expected)) {
    throw new Error("Another Shapes Bridge installation owns this background service. Pause or uninstall that installation before using a different --state-dir.");
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
  } else {
    command("schtasks.exe", ["/End", "/TN", TASK_NAME], { optional: true });
    command("schtasks.exe", ["/Change", "/TN", TASK_NAME, "/Disable"], { optional: true });
    if (!waitForStopped(() => command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if ((Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State -eq 'Running') { exit 1 }`], { optional: true }).status !== 0)) {
      throw new Error("Could not confirm that the Windows background task stopped. Check Task Scheduler before continuing.");
    }
    if (remove) command("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], { optional: true });
  }
  if (remove || process.platform === "darwin") fs.rmSync(definition.file, { force: true });
}

function startService({ install = false } = {}) {
  ensureStateDir();
  stopService();
  if (install) copyRuntime();
  const definition = serviceDefinition();
  fs.mkdirSync(path.dirname(definition.file), { recursive: true });
  const logFile = path.join(stateDir(), "service.log");
  fs.closeSync(fs.openSync(logFile, "a", 0o600));
  if (process.platform !== "win32") fs.chmodSync(logFile, 0o600);
  fs.writeFileSync(definition.file, definition.content, { mode: 0o600, encoding: process.platform === "win32" ? "utf16le" : "utf8" });
  if (process.platform === "darwin") {
    command("launchctl", ["bootstrap", `gui/${process.getuid()}`, definition.file]);
  } else if (process.platform === "linux") {
    command("systemctl", ["--user", "daemon-reload"]);
    command("systemctl", ["--user", "enable", "--now", `${LABEL}.service`]);
  } else {
    command("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", definition.file, "/F"]);
    command("schtasks.exe", ["/Run", "/TN", TASK_NAME]);
  }
}

module.exports = { LABEL, runtimePaths, launcherContent, serviceDefinition, assertServiceOwner, copyRuntime, startService, stopService };
