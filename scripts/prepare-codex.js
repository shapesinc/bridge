#!/usr/bin/env node
"use strict";

// Build-time only. Package the complete, checksum-pinned official distribution;
// neither Bridge startup nor a model request downloads executable code.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const manifest = require("../assets/codex/runtime.json");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1]) throw new Error(`Missing ${name}`);
  return argv[index + 1];
};
const cache = path.resolve(option("--cache", path.join(os.homedir(), ".cache/shapes-bridge-codex", manifest.version)));
const output = option("--out");
const platform = option("--platform", "darwin");
const architectures = option("--arch") ? [option("--arch")] : platform === "win32" ? ["x64"] : Object.keys(manifest.packages);
async function main() {
  if (!output) throw new Error("--out directory is required");
  if (!["darwin", "win32"].includes(platform)) throw new Error("Unsupported package platform.");
  fs.mkdirSync(cache, { recursive: true });
  for (const arch of architectures) {
    const artifact = platform === "darwin" ? manifest.packages[arch] : manifest.platformPackages[`${platform}-${arch}`];
    if (!artifact) throw new Error("Only arm64 and x64 packages are supported.");
    const archive = path.join(cache, platform === "darwin" ? `${arch}.tar.gz` : `${platform}-${arch}.tar.gz`);
    if (!fs.existsSync(archive)) {
      const url = `${manifest.repository}/releases/download/${manifest.tag}/${artifact.asset}`;
      const temporary = `${archive}.${process.pid}.download`;
      try {
        execFileSync("curl", ["-fL", "--retry", "2", "--output", temporary, url], { stdio: "inherit" });
        fs.renameSync(temporary, archive);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) throw new Error(`Codex ${arch} archive checksum mismatch.`);
    const destination = path.resolve(output, arch);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(destination), `.${arch}-`));
    try {
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    const packaged = JSON.parse(fs.readFileSync(path.join(staging, "codex-package.json"), "utf8"));
    const suffix = platform === "win32" ? ".exe" : "";
    const target = platform === "win32" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
    if (packaged.version !== manifest.version || packaged.variant !== "codex-app-server"
        || packaged.entrypoint !== `bin/codex-app-server${suffix}` || packaged.target !== target) throw new Error("Unexpected Codex package layout.");
    for (const binary of ["bin/codex-app-server", "bin/codex-code-mode-host", "bin/codex-exec-server", "codex-path/rg"].map(file => file + suffix)
      .concat(platform === "win32" ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"] : [])) {
      fs.accessSync(path.join(staging, binary), fs.constants.X_OK);
    }
    fs.cpSync(path.resolve(__dirname, "../assets/codex"), path.join(staging, "licenses"), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    process.stdout.write(`Verified Codex ${manifest.version} ${platform}/${arch}: ${artifact.sha256}\n`);
  }
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
