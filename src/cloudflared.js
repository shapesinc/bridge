"use strict";

// Locate (or download once, then cache) the `cloudflared` binary used to open a
// no-account public quick-tunnel. We keep it out of the npm package — it's a
// ~40 MB platform binary — and cache it under ~/.shapes-bridge/.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const CACHE_DIR = path.join(os.homedir(), ".shapes-bridge");
const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

function assetFor(platform, arch) {
  if (platform === "darwin") {
    const pkg = arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
    return { pkg, archive: "tgz", bin: "cloudflared" };
  }
  if (platform === "win32") {
    const pkg = arch === "arm64" ? "cloudflared-windows-arm64.exe" : "cloudflared-windows-amd64.exe";
    return { pkg, archive: "raw", bin: "cloudflared.exe" };
  }
  // linux
  let a = "amd64";
  if (arch === "arm64" || arch === "aarch64") a = "arm64";
  else if (arch === "arm") a = "arm";
  else if (arch === "ia32") a = "386";
  return { pkg: `cloudflared-linux-${a}`, archive: "raw", bin: "cloudflared" };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects) => {
      https
        .get(u, { headers: { "user-agent": "shapes-bridge" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects <= 0) return reject(new Error("too many redirects"));
            res.resume();
            return get(res.headers.location, redirects - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`download failed: HTTP ${res.statusCode}`));
          }
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", (err) => {
          fs.unlink(dest, () => reject(err));
        });
    };
    get(url, 5);
  });
}

/**
 * Return an absolute path to a runnable cloudflared binary, downloading and
 * caching it on first use. Logs progress via the provided logger.
 */
async function ensureCloudflared(log = () => {}) {
  const { pkg, archive, bin } = assetFor(process.platform, process.arch);
  const binPath = path.join(CACHE_DIR, bin);
  if (fs.existsSync(binPath)) return binPath;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const url = `${RELEASE_BASE}/${pkg}`;
  log("downloading tunnel helper (one time, ~40 MB)…");

  if (archive === "tgz") {
    const tgz = path.join(CACHE_DIR, pkg);
    await download(url, tgz);
    const r = spawnSync("tar", ["-xzf", tgz, "-C", CACHE_DIR], { stdio: "ignore" });
    fs.rmSync(tgz, { force: true });
    if (r.status !== 0 || !fs.existsSync(binPath)) {
      throw new Error("failed to extract cloudflared archive");
    }
  } else {
    await download(url, binPath);
  }

  if (process.platform !== "win32") fs.chmodSync(binPath, 0o755);
  return binPath;
}

module.exports = { ensureCloudflared, CACHE_DIR };
