"use strict";

const os = require("node:os");
const path = require("node:path");

// Finder and launchd provide only the system PATH. Keep any explicitly supplied
// entries first, then include the standard locations for local developer tools.
// Never source login scripts: discovery and each action must stay bounded and
// must not run unrelated shell startup commands.
function localEnvironment({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== "darwin") return { ...env };
  const inherited = env.PATH === undefined ? "/usr/bin:/bin:/usr/sbin:/sbin" : env.PATH;
  const additions = [
    path.join(home, ".local/bin"),
    "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin",
    path.join(home, "Library/pnpm"), path.join(home, ".bun/bin"), path.join(home, ".cargo/bin"),
  ];
  return { ...env, PATH: [...new Set([...inherited.split(":"), ...additions])].join(":") };
}

function expandHome(value, home = os.homedir(), platform = process.platform) {
  if (value === "~") return home;
  const homeRelative = typeof value === "string"
    && (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\")));
  return homeRelative ? (platform === "win32" ? path.win32 : path).join(home, value.slice(2)) : value;
}

module.exports = { localEnvironment, expandHome };
