"use strict";

const { spawn } = require("node:child_process");

function keepAwake({ enabled = true, platform = process.platform, spawnProcess = spawn } = {}) {
  if (!enabled) return { status: () => "disabled", stop() {} };
  let command, args;
  if (platform === "darwin") {
    command = "/usr/bin/caffeinate";
    // Prevent idle system sleep while the bridge runs; leave display and lock settings alone.
    args = ["-i", "-w", String(process.pid)];
  } else if (platform === "linux") {
    command = "systemd-inhibit";
    args = ["--what=idle:sleep", "--who=shapes.inc Bridge", "--why=Computer connection enabled", "--mode=block", "sleep", "infinity"];
  } else if (platform === "win32") {
    command = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-Command", `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ShapesAwake { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'; if ([ShapesAwake]::SetThreadExecutionState(2147483649) -eq 0) { exit 1 }; Write-Output ready; while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }`];
  } else return { status: () => "unsupported", stop() {} };
  let current = "unknown";
  const child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  child.once("spawn", () => { if (platform !== "win32") current = "enabled"; });
  child.stdout?.once("data", () => { current = "enabled"; });
  child.once("error", () => { current = "unsupported"; });
  child.once("exit", () => { current = "disabled"; });
  return { status: () => current, stop() { current = "disabled"; child.kill(); } };
}

module.exports = { keepAwake };
