"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { version } = require("../package.json");

const cli = path.resolve(__dirname, "../bin/cli.js");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    run: (...args) => spawnSync(process.execPath, [cli, "--state-dir", dir, ...args], {
      encoding: "utf8", windowsHide: true, timeout: 10000,
    }),
  };
}

test("all version forms print only the package version before pairing", (t) => {
  const { dir, run } = fixture(t);
  for (const args of [["version"], ["--version"], ["-v"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, version + "\n");
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.match(run("help").stdout, /\n\s+version\s+Print the installed version/);
});

test("unknown commands have the same error before and after pairing", (t) => {
  const { dir, run } = fixture(t);
  const unpaired = run("pause");
  assert.equal(unpaired.status, 1);
  assert.match(unpaired.stderr, /Run install first/);

  const before = run("unknown-example");
  assert.equal(before.status, 1);
  assert.match(before.stderr, /Unknown command: unknown-example\. Run help for available commands\./);

  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ device_token: "fixture-only" }));
  const after = run("unknown-example");
  assert.equal(after.status, 1);
  assert.equal(after.stderr, before.stderr);
});
