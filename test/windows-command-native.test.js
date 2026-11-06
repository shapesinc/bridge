"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const available = process.platform === "win32" && process.env.SHAPES_TEST_JOB_HOST;

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-command-"));
  const node = path.join(directory, "node.exe");
  fs.copyFileSync(process.execPath, node);
  fs.copyFileSync(process.env.SHAPES_TEST_JOB_HOST, path.join(directory, "shapes.inc Bridge Job.exe"));
  const owned = new Set();
  // execFile has observed process/stdio closure before run() returns. Windows
  // can retain the executable mapping briefly after that notification.
  t.after(async () => {
    for (const child of owned) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "close"); }
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  let runNumber = 0;
  const run = async (cmd, options = {}) => {
    const source = "require(process.argv[1]).runCommand(JSON.parse(process.argv[2])).then(result=>process.stdout.write(JSON.stringify(result)),()=>process.exit(1))";
    const trace = path.join(directory, `command-${++runNumber}.log`);
    try {
      const { stdout } = await execute(node, ["-e", source, path.resolve(__dirname, "../src/server.js"), JSON.stringify({ cmd, cwd: directory, ...options })],
        { timeout: 15000, windowsHide: true, env: { ...process.env, SHAPES_BRIDGE_HOME: path.join(directory, "state"), SHAPES_TEST_JOB_HOST_TRACE: trace } });
      return JSON.parse(stdout);
    } finally {
      t.diagnostic(`command handoff ${runNumber}\n${fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "no helper trace"}`);
    }
  };
  return { directory, run, own: (child) => { owned.add(child); return child; } };
}
const waitFor = async (predicate, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.fail("The owned Windows command did not settle.");
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Windows runtime preserves multiline PowerShell, Unicode and failure receipts", { skip: !available, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run("$value = 'hello 🌲'\nWrite-Output $value\nWrite-Output 'second line'");
  assert.equal(result.exit_code, 0);
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
  assert.equal(result.exit_code, -1); assert.match(result.stderr, /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(fs.existsSync(marker), false);
});

test("successful Windows background launch survives its command and ends with the enclosing runtime", { skip: !available, timeout: 30000 }, async (t) => {
  const f = await fixture(t), receipt = path.join(f.directory, "receipt.json"), marker = path.join(f.directory, "started.txt");
  const script = path.join(f.directory, "background.ps1");
  fs.writeFileSync(script, `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'started')\nStart-Sleep -Seconds 30`);
  const cmd = `$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-File', '"${script.replaceAll("'", "''")}"') -WindowStyle Hidden -PassThru\nWrite-Output $child.Id`;
  const source = "require(process.argv[1]).runCommand(JSON.parse(process.argv[2])).then(result=>{const fs=require('node:fs'),file=process.argv[3];fs.writeFileSync(file+'.tmp',JSON.stringify(result));fs.renameSync(file+'.tmp',file);setInterval(()=>{},1000)},()=>process.exit(1))";
  const runtime = f.own(spawn(path.join(f.directory, "shapes.inc Bridge Job.exe"), ["--parent-pid", String(process.pid), "--", path.join(f.directory, "node.exe"), "-e", source,
    path.resolve(__dirname, "../src/server.js"), JSON.stringify({ cmd, cwd: f.directory }), receipt],
    { stdio: "ignore", windowsHide: true, env: { ...process.env, SHAPES_BRIDGE_HOME: path.join(f.directory, "state") } }));
  await waitFor(() => fs.existsSync(receipt) && fs.existsSync(marker));
  const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert.equal(result.exit_code, 0);
  const pid = Number(result.stdout.trim()); assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.equal(alive(pid), true);
  runtime.kill(); await once(runtime, "close");
  await waitFor(() => !alive(pid));
});

for (const cancellation of [false, true]) {
  test(`Windows ${cancellation ? "cancellation" : "timeout"} still owns inherited output after the shell exits successfully`, { skip: !available, timeout: 45000 }, async (t) => {
    const f = await fixture(t), resultFile = path.join(f.directory, "result.json"), pidsFile = path.join(f.directory, "pids.json");
    const started = path.join(f.directory, "descendant-started.txt"), escaped = path.join(f.directory, "must-not-write.txt");
    const cancelFile = path.join(f.directory, "cancel-requested");
    const lateWriteMs = cancellation ? 4000 : 25000;
    const descendant = path.join(f.directory, "descendant.js"), launcher = path.join(f.directory, "launcher.js");
    fs.writeFileSync(descendant, `const fs=require('node:fs'),file=${JSON.stringify(started)},startedAt=Date.now();fs.writeFileSync(file+'.tmp',JSON.stringify({startedAt}));fs.renameSync(file+'.tmp',file);setTimeout(()=>fs.writeFileSync(${JSON.stringify(escaped)},'escaped'),${lateWriteMs});setInterval(()=>{},1000);`);
    fs.writeFileSync(launcher, `const fs=require('node:fs'),file=${JSON.stringify(pidsFile)};const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit'],detached:true});fs.writeFileSync(file+'.tmp',JSON.stringify({leader:process.pid,descendant:child.pid}));fs.renameSync(file+'.tmp',file);child.unref();`);
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const command = { cmd: `& ${quote(path.join(f.directory, "node.exe"))} ${quote(launcher)}`, cwd: f.directory, timeout: cancellation ? 30 : 20 };
    // Keep the enclosing runtime alive after runCommand settles, so it cannot
    // conceal an escaped descendant by cleaning up the command for this test.
    const source = "const fs=require('node:fs'),controller=new AbortController();const timer=process.argv[4]?setInterval(()=>{if(fs.existsSync(process.argv[4]))controller.abort()},25):null;require(process.argv[1]).runCommand({...JSON.parse(process.argv[2]),signal:controller.signal}).then(result=>{clearInterval(timer);const file=process.argv[3];fs.writeFileSync(file+'.tmp',JSON.stringify(result));fs.renameSync(file+'.tmp',file);setInterval(()=>{},1000)},()=>process.exit(1));";
    f.own(spawn(path.join(f.directory, "shapes.inc Bridge Job.exe"), ["--parent-pid", String(process.pid), "--", path.join(f.directory, "node.exe"), "-e", source,
      path.resolve(__dirname, "../src/server.js"), JSON.stringify(command), resultFile, cancellation ? cancelFile : ""],
    { stdio: "ignore", windowsHide: true, env: { ...process.env, SHAPES_BRIDGE_HOME: path.join(f.directory, "state") } }));
    await waitFor(() => fs.existsSync(started) && fs.existsSync(pidsFile) && !alive(JSON.parse(fs.readFileSync(pidsFile, "utf8")).leader));
    const pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
    const descendantStarted = JSON.parse(fs.readFileSync(started, "utf8"));
    assert.equal(alive(pids.descendant), true, "descendant must retain output after its launcher exits");
    if (cancellation) {
      fs.writeFileSync(cancelFile + ".tmp", "cancel");
      fs.renameSync(cancelFile + ".tmp", cancelFile);
    }
    await waitFor(() => fs.existsSync(resultFile), 25000);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(result.exit_code, -1);
    assert.match(result.termination_reason, cancellation ? /command cancelled/ : /timed out/);
    await waitFor(() => !alive(pids.descendant));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, descendantStarted.startedAt + lateWriteMs + 1000 - Date.now())));
    assert.equal(fs.existsSync(escaped), false, "a stopped receipt must prevent the descendant's delayed side effect");
  });
}
