"use strict";

const { execFile } = require("node:child_process");
const { localEnvironment } = require("./local-workspace");
const { ensureStateDir } = require("./state");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnOwned } = require("./owned-process");
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Used only by the signed native host after its human confirmation. Never an
// HTTP capability, model tool, custom OAuth flow, or provider-secret transport.
function loginCommand(agent, executable) {
  if (!["codex", "claude"].includes(agent) || typeof executable !== "string" || !path.isAbsolute(executable)
      || /[\x00-\x1f\x7f]/.test(executable)) throw new Error("Unsupported personal agent login.");
  const quoted = shellQuote(executable);
  return `exec ${quoted} ${agent === "codex" ? "login" : "auth login"}`;
}

function openPersonalLogin({ id, executable }, { run = execFile, platform = process.platform, directory = path.join(ensureStateDir(), "personal-login"), spawnProcess = spawnOwned } = {}) {
  if (platform === "win32") return openWindowsLogin({ id, executable }, { spawnProcess });
  if (platform !== "darwin") return Promise.reject(new Error("Native account sign-in requires macOS."));
  const command = loginCommand(id, executable);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Login handoff directory must be owned by this account.");
  for (const name of fs.readdirSync(directory).filter((name) => /^[a-f0-9-]{36}\.command$/.test(name)).slice(0, 100)) {
    const file = path.join(directory, name);
    if (Date.now() - fs.lstatSync(file).mtimeMs > 60 * 60 * 1000) fs.rmSync(file, { force: true });
  }
  const file = path.join(directory, `${crypto.randomUUID()}.command`);
  const environment = localEnvironment();
  // LaunchServices opens a private command file without AppleEvents automation
  // permission. It deletes itself before entering the unmodified vendor CLI.
  fs.writeFileSync(file, `#!/bin/sh\n/bin/rm -f "$0"\nexport PATH=${shellQuote(environment.PATH || "/usr/bin:/bin")}\n${command}\n`, { mode: 0o700, flag: "wx" });
  return new Promise((resolve, reject) => {
    run("/usr/bin/open", ["-a", "/System/Applications/Utilities/Terminal.app", file], { timeout: 10000, maxBuffer: 16384, env: environment },
      (error) => {
        if (error) { fs.rmSync(file, { force: true }); reject(new Error("Could not open the vendor sign-in in Terminal.")); }
        else resolve({ opened: true });
      });
  });
}

function openWindowsLogin({ id, executable }, { spawnProcess = spawnOwned } = {}) {
  if (!["codex", "claude"].includes(id) || typeof executable !== "string" || !path.win32.isAbsolute(executable)
      || !/\.exe$/i.test(executable) || /[\x00-\x1f\x7f]/.test(executable)) return Promise.reject(new Error("Unsupported personal agent login."));
  return new Promise((resolve, reject) => {
    let child, timer, text = "", finished = false;
    const finish = (error) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (error) { child?.kill(); reject(new Error("Could not open the vendor sign-in in Windows Terminal.")); }
      else { child.unref(); child.stdout.unref?.(); resolve({ opened: true }); }
    };
    try {
      child = spawnProcess(executable, id === "codex" ? ["login"] : ["auth", "login"],
        { env: localEnvironment(), console: true, ready: true, stdio: ["ignore", "pipe", "ignore"] });
      child.once("error", () => finish(true)); child.once("exit", () => { if (!finished) finish(true); });
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.length > 128) { finish(true); return; }
        if (text.includes("\n")) {
          try { finish(JSON.parse(text.trim()).started !== true); } catch { finish(true); }
        }
      });
      timer = setTimeout(() => finish(true), 10000);
    } catch { finish(true); }
  });
}

module.exports = { loginCommand, openPersonalLogin, openWindowsLogin };
