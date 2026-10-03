"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("npx can infer setup from the packed package without an explicit executable", {
  skip: process.platform === "win32" ? "This npm subprocess fixture runs on macOS/Linux." : false,
  timeout: 30000,
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-bridge-npx-"));
  const cwd = path.resolve(__dirname, "..");
  const env = { ...process.env, npm_config_cache: path.join(dir, "npm-cache"), npm_config_offline: "true", npm_config_update_notifier: "false" };
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd, env, encoding: "utf8" }));
    const pkg = `file:${path.join(dir, packed[0].filename)}`;
    // This exercises npm's real package-to-bin inference used by the legacy
    // `npx github:shapesinc/bridge` command, without downloading or installing a service.
    const output = execFileSync("npx", ["--yes", pkg, "--help"], { cwd: dir, env, encoding: "utf8" });
    assert.match(output, /Shapes Bridge\n/);
    assert.match(output, /install\s+Pair once/);
    // The original explicit sidekick command must remain independently selectable.
    const codex = execFileSync("npx", ["--yes", `--package=${pkg}`, "shapes-codex", "--help"], { cwd: dir, env, encoding: "utf8" });
    assert.match(codex, /shapes-codex/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
