"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFile } = require("node:child_process");
const { runCommand, startServer } = require("../src/server");
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

test("failed elevation probes remain unknown, not administrator access", async () => {
  for (const [error, stdout, expected] of [[new Error("failed"), "True", null], [null, "False\r\n", false], [null, "True", true], [null, "invalid", null]]) {
    assert.equal((await elevationStatus({ platform: "win32", execute: (_file, _args, options, done) => {
      assert.equal(options.timeout, 5000); assert.equal(options.windowsHide, true); done(error, stdout);
    } })).elevated, expected);
  }
  assert.equal((await elevationStatus({ platform: "win32", execute: () => { throw new Error("spawn failed"); } })).elevated, null);
});

test("HTTP status and cancellation remain responsive during a pending elevation probe", { timeout: 10000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-elevation-")), gate = path.join(dir, "release");
  let begin, probeFinished = false, child, discovery;
  const started = new Promise((resolve) => { begin = resolve; });
  const server = await startServer({ port: 0, token: "elevation-test", readElevation: () => elevationStatus({ platform: "win32", execute: (_file, _args, options, done) => {
    child = execFile(process.execPath, ["-e", `const fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(t);process.stdout.write('False');}},20)`], options, (error, stdout) => { probeFinished = true; done(error, stdout); });
    begin();
  } }) });
  const base = `http://127.0.0.1:${server.address().port}`, headers = { "x-token": "elevation-test", "content-type": "application/json" };
  try {
    discovery = fetch(base + "/sysinfo", { headers }).then((r) => r.json());
    await started;
    assert.deepEqual(await (await fetch(base + "/health", { signal: AbortSignal.timeout(2000) })).json(), { ok: true });
    const cancel = await fetch(base + "/commands/cancel", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(2000) });
    assert.equal(cancel.status, 403); await cancel.text();
    assert.equal(probeFinished, false);
    fs.writeFileSync(gate, "release");
    assert.equal((await discovery).elevated, false);
    assert.equal(probeFinished, true);
  } finally {
    fs.writeFileSync(gate, "release");
    if (discovery) await discovery.catch(() => {});
    if (child && child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once("exit", resolve));
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.equal(lines[1], dir);
      // Windows can spell the same directory with its 8.3 or long name.
      assert.equal(fs.statSync(lines[2]).ino, fs.statSync(dir).ino);
      assert.equal(fs.statSync(lines[2]).dev, fs.statSync(dir).dev);
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
      const script = path.join(dir, "child.js");
      fs.writeFileSync(script, js);
      const result = await runCommand({ cmd: `& ${quote(process.execPath)} ${quote(script)}`, timeout: 1 });
      assert.equal(result.exit_code, -1, JSON.stringify(result));
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
        // Task Scheduler omits default-valued fields in exported XML. Read
        // the registered principal rather than assuming the XML round-trips.
        const level = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-ScheduledTask -TaskName '${name}').Principal.RunLevel`], { encoding: "utf8" });
        assert.equal(level.status, 0, level.stderr);
        assert.equal(level.stdout.trim(), "Limited");
      } finally { spawnSync("schtasks.exe", ["/Delete", "/TN", name, "/F"]); }
    });
  } finally {
    if (previous === undefined) delete process.env.SHAPES_BRIDGE_HOME; else process.env.SHAPES_BRIDGE_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
