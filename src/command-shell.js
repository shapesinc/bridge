"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ensureStateDir, stateDir } = require("./state");

const powershell = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function commandShell(cmd, shell = process.platform === "win32" ? "powershell" : "sh") {
  if (shell === "sh" && process.platform !== "win32") {
    return { executable: "/bin/sh", args: ["-c", cmd], shell, cleanup() {} };
  }
  if (shell === "cmd" && process.platform === "win32") {
    if (/[\r\n]/.test(cmd)) throw new Error("Use shell=powershell for multiline Windows scripts; cmd accepts one line.");
    return { executable: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      args: [cmd], shell, windowsCommand: true, cleanup() {} };
  }
  if (shell !== "powershell" || process.platform !== "win32") throw new Error(`Shell ${shell} is not supported on ${process.platform}.`);
  // -File preserves newlines, quotes, $env variables and non-ASCII text without
  // a cmd.exe parsing pass or Windows' command-line length limit. PowerShell
  // 5.1 needs the BOM to interpret a UTF-8 script containing non-ASCII text.
  ensureStateDir();
  const dir = fs.mkdtempSync(path.join(stateDir(), "command-"));
  const file = path.join(dir, "script.ps1");
  const script = "\ufeff$ErrorActionPreference = 'Stop'\n" +
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n" +
    "$global:LASTEXITCODE = 0\ntry {\n" + cmd +
    "\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }\nexit $LASTEXITCODE\n";
  try { fs.writeFileSync(file, script, { mode: 0o600 }); }
  catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  return { executable: powershell(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    shell, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function elevationStatus({ platform = process.platform, execute = spawnSync } = {}) {
  if (platform !== "win32") return { elevated: typeof process.getuid === "function" ? process.getuid() === 0 : null };
  const result = execute(powershell(), ["-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"],
  { encoding: "utf8", timeout: 5000, windowsHide: true });
  const value = result.stdout?.trim();
  return { elevated: !result.error && result.status === 0 && /^(True|False)$/.test(value) ? value === "True" : null,
    elevation_guidance: "Chat sharing does not grant Windows administrator rights. For an operation requiring elevation, the owner must review and run that specific operation in an Administrator terminal. The background Bridge stays at least privilege." };
}

module.exports = { commandShell, elevationStatus };
