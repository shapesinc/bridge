"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runCommand } = require("../src/server");
const { serviceDefinition, writeServiceDefinition } = require("../src/service");
const { elevationStatus } = require("../src/command-shell");

test("Windows service XML has the UTF-16 BOM promised by its declaration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-task-"));
  try {
    const definition = serviceDefinition({ platform: "win32", dir });
    writeServiceDefinition(definition, "win32");
    const bytes = fs.readFileSync(definition.file);
    assert.equal(bytes.subarray(0, 2).toString("hex"), "fffe");
    assert.equal(bytes.subarray(2).toString("utf16le"), definition.content);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failed elevation probes remain unknown, not administrator access", () => {
  assert.equal(elevationStatus({ platform: "win32", execute: () => ({ status: 1, stdout: "True" }) }).elevated, null);
  assert.equal(elevationStatus({ platform: "win32", execute: () => ({ status: 0, stdout: "False\r\n" }) }).elevated, false);
});

test("native Windows command and scheduled-task integration", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge windows & é-"));
  const previous = process.env.SHAPES_BRIDGE_HOME;
  process.env.SHAPES_BRIDGE_HOME = dir;
  const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
  try {
    await t.test("multiline scripts preserve variables, quotes, Unicode and cwd", async () => {
      const result = await runCommand({ cmd: "$word = 'héllo \"quoted\"'\r\nWrite-Output $word\r\nWrite-Output $env:SHAPES_BRIDGE_HOME\r\n(Get-Location).Path", cwd: dir });
      assert.equal(result.exit_code, 0, result.stderr);
      assert.match(result.stdout, /héllo "quoted"/);
      assert.equal(result.stdout.split(dir).length, 3);
      assert.equal(result.shell, "powershell");
      assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("command-")), false);
    });
    await t.test("native and PowerShell failures have nonzero exit receipts", async () => {
      for (const cmd of ["Write-Error 'test failure'", "& cmd.exe /c exit 7", "throw 'test failure'"]) {
        const result = await runCommand({ cmd });
        assert.notEqual(result.exit_code, 0, JSON.stringify(result));
      }
    });
    await t.test("explicit cmd and invalid shell handling", async () => {
      assert.match((await runCommand({ cmd: "echo cmd-ok", shell: "cmd" })).stdout, /cmd-ok/);
      assert.notEqual((await runCommand({ cmd: "echo one\necho two", shell: "cmd" })).exit_code, 0);
      assert.notEqual((await runCommand({ cmd: "echo one", shell: "sh" })).exit_code, 0);
    });
    await t.test("timeout kills descendants, not only the PowerShell wrapper", async () => {
      const marker = path.join(dir, "escaped.txt");
      const js = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),2500);setInterval(()=>{},1000)`;
      const result = await runCommand({ cmd: `& ${quote(process.execPath)} -e ${quote(js)}`, timeout: 1 });
      assert.equal(result.exit_code, -1);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.equal(fs.existsSync(marker), false);
    });
    await t.test("real Task Scheduler accepts the XML and replaces an existing registration", () => {
      const definition = serviceDefinition({ dir, home: dir });
      writeServiceDefinition(definition);
      const name = `shapes-bridge-ci-${process.pid}`;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = spawnSync("schtasks.exe", ["/Create", "/TN", name, "/XML", definition.file, "/F"], { encoding: "utf8" });
          assert.equal(result.status, 0, result.stderr + result.stdout);
        }
        const result = spawnSync("schtasks.exe", ["/Query", "/TN", name, "/XML"], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /LeastPrivilege/);
      } finally { spawnSync("schtasks.exe", ["/Delete", "/TN", name, "/F"]); }
    });
  } finally {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
