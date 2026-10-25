"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const RUNTIME_ARCHIVE = "https://github.com/shapesinc/bridge/archive/refs/heads/main.tar.gz";

function download(url, destination, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "user-agent": "shapes-bridge" } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error("The update download redirected too many times."));
        return download(new URL(response.headers.location, url).toString(), destination, redirects - 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error(`The update download failed (HTTP ${response.statusCode}).`)); }
      const file = fs.createWriteStream(destination, { mode: 0o600 });
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// Extract a source archive (the GitHub main tarball layout: one top-level
// folder holding bin/, src/, package.json) and return that folder.
function extractArchive(archive, into) {
  fs.mkdirSync(into, { recursive: true, mode: 0o700 });
  const result = spawnSync("tar", ["-xzf", archive, "-C", into], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`The update archive could not be extracted: ${(result.error?.message || result.stderr || "tar failed").trim()}`);
  const folders = fs.readdirSync(into, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(into, entry.name));
  const source = folders.find((folder) => fs.existsSync(path.join(folder, "bin", "cli.js")) && fs.existsSync(path.join(folder, "package.json")));
  if (!source) throw new Error("The update archive does not contain shapes.inc Bridge.");
  return source;
}

async function downloadRuntime({ url = RUNTIME_ARCHIVE, into = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-bridge-update-")) } = {}) {
  const archive = path.join(into, "bridge.tar.gz");
  await download(url, archive);
  const source = extractArchive(archive, path.join(into, "source"));
  return { source, version: JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version, cleanup: () => fs.rmSync(into, { recursive: true, force: true }) };
}

module.exports = { RUNTIME_ARCHIVE, downloadFile: download, extractArchive, downloadRuntime };
