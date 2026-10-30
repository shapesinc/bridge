"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { embeddedApiOrigin } = require("../src/embedded-config");

const invalid = [
  "", null, 8040, "https://api.shapes.inc/", "https://api.shapes.inc:443",
  "https://other.example", "http://other.example:8040", "https://127.0.0.1:8040",
  "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536",
  "http://127.0.0.1:08040", "http://127.0.0.1:+8040", "http://127.0.0.1:8e3",
  "http://127.0.0.1:8040/", "http://127.0.0.1:8040/bridge", "http://127.0.0.1:8040//",
  "http://127.0.0.1:8040?", "http://127.0.0.1:8040#",
  "http://user:password@127.0.0.1:8040", "http://@127.0.0.1:8040",
  " http://127.0.0.1:8040", "http://127.0.0.1:8040\n",
  "http://127.1:8040", "http://2130706433:8040", "http://0x7f000001:8040",
  "http://127.0.0.2:8040", "http://localhost.:8040", "http://localhost.example:8040",
  "http://LOCALHOST:8040", "http://localhost:8040", "http://[::1]:8040", "http://[::ffff:127.0.0.1]:8040",
];

test("embedded API defaults to production and accepts only explicit literal loopback origins", () => {
  assert.equal(embeddedApiOrigin(), "https://api.shapes.inc");
  assert.equal(embeddedApiOrigin("https://api.shapes.inc"), "https://api.shapes.inc");
  for (const port of [1, 80, 8080, 8040, 65535]) {
    const origin = `http://127.0.0.1:${port}`;
    assert.equal(embeddedApiOrigin(origin), origin);
  }
  for (const value of invalid) assert.throws(() => embeddedApiOrigin(value), /Invalid embedded API origin/);
});

test("actual embedded entry accepts default, original8080 and isolated QA origins without starting a runtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-embedded-config-"));
  try {
    for (const [index, api] of [undefined, "http://127.0.0.1:8080", "http://127.0.0.1:8040"].entries()) {
      const home = path.join(directory, String(index));
      const env = { ...process.env, SHAPES_BRIDGE_HOME: home };
      delete env.SHAPES_BRIDGE_API;
      if (api !== undefined) env.SHAPES_BRIDGE_API = api;
      const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/embedded.js")], {
        env, input: JSON.stringify({ version: 1, id: "status", operation: "status", params: {} }) + "\n",
        encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const reply = JSON.parse(result.stdout);
      assert.equal(reply.id, "status");
      assert.equal(reply.result.state, "disconnected");
      assert.equal(reply.result.online, false);
      assert.deepEqual(fs.readdirSync(home), []);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("actual embedded entry rejects invalid and remote configuration before state or protocol startup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-embedded-invalid-config-"));
  const home = path.join(directory, "must-not-exist");
  try {
    for (const api of invalid.filter((value) => typeof value === "string")) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/embedded.js")], {
        env: { ...process.env, SHAPES_BRIDGE_HOME: home, SHAPES_BRIDGE_API: api },
        input: JSON.stringify({ version: 1, id: "status", operation: "status", params: {} }) + "\n",
        encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 1, api);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(fs.existsSync(home), false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
