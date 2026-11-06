"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const available = process.platform === "win32" && process.env.SHAPES_TEST_JOB_HOST;

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-command-"));
  const node = path.join(directory, "node.exe");
  fs.copyFileSync(process.execPath, node);
  fs.copyFileSync(process.env.SHAPES_TEST_JOB_HOST, path.join(directory, "shapes.inc Bridge Job.exe"));
  // execFile has observed process/stdio closure before run() returns. Windows
  // can retain the executable mapping briefly after that notification.
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const run = async (cmd, options = {}) => {
    const source = "require(process.argv[1]).runCommand(JSON.parse(process.argv[2])).then(result=>process.stdout.write(JSON.stringify(result)),()=>process.exit(1))";
    const { stdout } = await execute(node, ["-e", source, path.resolve(__dirname, "../src/server.js"), JSON.stringify({ cmd, cwd: directory, ...options })],
      { timeout: 15000, windowsHide: true, env: { ...process.env, SHAPES_BRIDGE_HOME: path.join(directory, "state") } });
    return JSON.parse(stdout);
  };
  return { directory, run };
}

test("Windows runtime preserves multiline PowerShell, Unicode and failure receipts", { skip: !available, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run("$value = 'hello 🌲'\nWrite-Output $value\nWrite-Output 'second line'");
  assert.equal(result.exit_code, 0); assert.equal(result.shell, "powershell");
  assert.match(result.stdout, /hello 🌲\r?\nsecond line/);
  const failure = await f.run("throw 'intentional failure'");
  assert.equal(failure.exit_code, 1); assert.match(failure.stderr, /intentional failure/);
  const cmd = await f.run("echo one & echo two", { shell: "cmd" });
  assert.equal(cmd.exit_code, 0); assert.match(cmd.stdout, /one[\s\S]*two/);
});

test("Windows command timeout kills descendants before a delayed write", { skip: !available, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.directory, "must-not-exist.txt");
  const child = path.join(f.directory, "delayed.ps1");
  fs.writeFileSync(child, `Start-Sleep -Seconds 4\n[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'unexpected')`);
  const script = `Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-File', '"${child.replaceAll("'", "''")}"') -WindowStyle Hidden\nStart-Sleep -Seconds 30`;
  const result = await f.run(script, { timeout: 1 });
  assert.equal(result.exit_code, -1); assert.match(result.termination_reason, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(fs.existsSync(marker), false);
});
