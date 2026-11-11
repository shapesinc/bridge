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
    for (const [state, result, locked = false] of [
      ["completed", { exit_code: 0, stdout: "completed before cancellation", stderr: "" }],
      ["cancelled", { exit_code: -1, stdout: "", stderr: "command cancelled", termination_reason: "command cancelled", stopped: "cancelled", cleanup_confirmed: true }],
      ["timed_out", { exit_code: -1, stdout: "", stderr: "timed out after 1s", termination_reason: "timed out after 1s", stopped: "timed out after 1s", cleanup_confirmed: true }],
      ["failed", { exit_code: 1, stdout: "", stderr: "command failed", stopped: null, cleanup_confirmed: true }],
      ["interrupted", { exit_code: -1, stdout: "", stderr: "observer failed", stopped: null, cleanup_confirmed: false,
        outcome_unknown: true, error_type: "command_exit_unconfirmed" }, true],
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
      assert.equal(fs.existsSync(path.join(root, "mutation.lock")), locked);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("legacy receipt lookup preserves an unproven observer outcome after settlement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-legacy-outcome-"));
  try {
    const result = { exit_code: -1, stdout: "", stderr: "observer failed", stopped: null, cleanup_confirmed: false,
      outcome_unknown: true, error_type: "command_exit_unconfirmed" };
    const source = `const primitive=require.resolve(${JSON.stringify(path.resolve(__dirname, "../src/command-process"))});
      require.cache[primitive]={exports:{runCommand:()=>({result:Promise.resolve(${JSON.stringify(result)}),snapshot:()=>({}),cancel(){}})}};
      const commands=require(${JSON.stringify(path.resolve(__dirname, "../src/commands"))});
      const first=commands.startCommand({scope_id:'fixture',request_key:'once',cmd:'never executed'});
      setImmediate(()=>console.log(JSON.stringify(commands.commandStatus({command_id:first.command_id,scope_id:'fixture'}))));`;
    const child = spawnSync(process.execPath, ["-e", source], { timeout: 5000, encoding: "utf8", windowsHide: true,
      env: { ...process.env, SHAPES_BRIDGE_HOME: directory } });
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout);
    assert.equal(receipt.state, "failed"); assert.equal(receipt.outcome_unknown, true);
    assert.equal(receipt.error_type, "command_exit_unconfirmed"); assert.equal(receipt.cleanup_confirmed, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
