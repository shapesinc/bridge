"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("worker persists the accepted command outcome when a cancellation arrives during settlement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-worker-outcome-"));
  try {
    for (const [state, result] of [
      ["completed", { exit_code: 0, stdout: "completed before cancellation", stderr: "" }],
      ["cancelled", { exit_code: -1, stdout: "", stderr: "command cancelled", termination_reason: "command cancelled" }],
      ["timed_out", { exit_code: -1, stdout: "", stderr: "timed out after 1s", termination_reason: "timed out after 1s" }],
    ]) {
      const home = path.join(directory, state), root = path.join(home, "command-jobs"), id = "a".repeat(64);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ job_id: id, state: "queued", command: {} }));
      fs.writeFileSync(path.join(root, "mutation.lock"), JSON.stringify({ id }));
      // Simulate the transport's settlement interval, then exercise the real
      // worker signal handler, persisted receipt and lock release. No command
      // or provider is executed by this fixture.
      const source = `const server=require.resolve(${JSON.stringify(path.resolve(__dirname, "../src/server"))});
        require.cache[server]={exports:{runCommand:async()=>{process.emit('SIGTERM');return ${JSON.stringify(result)}}}};
        process.argv[2]=${JSON.stringify(id)};require(${JSON.stringify(path.resolve(__dirname, "../src/command-worker"))});`;
      const child = spawnSync(process.execPath, ["-e", source], { timeout: 5000, encoding: "utf8", windowsHide: true,
        env: { ...process.env, SHAPES_BRIDGE_HOME: home } });
      assert.equal(child.status, 0, child.stderr);
      const receipt = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), "utf8"));
      assert.equal(receipt.state, state);
      assert.deepEqual(receipt.result, result);
      assert.equal(fs.existsSync(path.join(root, "mutation.lock")), false);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
