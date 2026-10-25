"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { extractArchive } = require("../src/update");

test("update extracts the GitHub main tarball layout and finds the package folder", { skip: process.platform === "win32" }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-update-"));
  try {
    fs.mkdirSync(path.join(base, "bridge-main", "bin"), { recursive: true });
    fs.writeFileSync(path.join(base, "bridge-main", "bin", "cli.js"), "");
    fs.writeFileSync(path.join(base, "bridge-main", "package.json"), JSON.stringify({ version: "9.9.9" }));
    const archive = path.join(base, "bridge.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", archive, "-C", base, "bridge-main"]).status, 0);
    const source = extractArchive(archive, path.join(base, "out"));
    assert.equal(source, path.join(base, "out", "bridge-main"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")).version, "9.9.9");
    fs.writeFileSync(path.join(base, "junk.tar.gz"), "not an archive");
    assert.throws(() => extractArchive(path.join(base, "junk.tar.gz"), path.join(base, "out2")), /could not be extracted/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
