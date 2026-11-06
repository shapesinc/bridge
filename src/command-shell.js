"use strict";

const fs = require("node:fs");
const path = require("node:path");
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

module.exports = { commandShell };
