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
  const run = async (cmd, options = {}) => {
    const source = "require(process.argv[1]).runCommand(JSON.parse(process.argv[2])).then(result=>process.stdout.write(JSON.stringify(result)),()=>process.exit(1))";
    const { stdout } = await execute(node, ["-e", source, path.resolve(__dirname, "../src/server.js"), JSON.stringify({ cmd, cwd: directory, ...options })],
      { timeout: 15000, windowsHide: true, env: { ...process.env, SHAPES_BRIDGE_HOME: path.join(directory, "state") } });
    return JSON.parse(stdout);
  };
  return { directory, run, own: (child) => { owned.add(child); return child; } };
}
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
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
  const source = "require(process.argv[1]).runCommand(JSON.parse(process.argv[2])).then(result=>{require('node:fs').writeFileSync(process.argv[3],JSON.stringify(result));setInterval(()=>{},1000)},()=>process.exit(1))";
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
  test(`Windows ${cancellation ? "cancellation" : "timeout"} still owns inherited output after the shell exits successfully`, { skip: !available, timeout: 30000 }, async (t) => {
    const f = await fixture(t), resultFile = path.join(f.directory, "result.json"), pidsFile = path.join(f.directory, "pids.json");
    const started = path.join(f.directory, "descendant-started.txt"), escaped = path.join(f.directory, "must-not-write.txt");
    const descendant = path.join(f.directory, "descendant.js"), launcher = path.join(f.directory, "launcher.js");
    fs.writeFileSync(descendant, `require('node:fs').writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(escaped)},'escaped'),4000);setInterval(()=>{},1000);`);
    fs.writeFileSync(launcher, `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit'],detached:true});require('node:fs').writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({leader:process.pid,descendant:child.pid}));child.unref();`);
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    const command = { cmd: `& ${quote(path.join(f.directory, "node.exe"))} ${quote(launcher)}`, cwd: f.directory, timeout: cancellation ? 15 : 2 };
    // Keep the enclosing runtime alive after runCommand settles, so it cannot
    // conceal an escaped descendant by cleaning up the command for this test.
    const source = "const controller=new AbortController();const timer=process.argv[4]==='cancel'?setTimeout(()=>controller.abort(),2000):null;require(process.argv[1]).runCommand({...JSON.parse(process.argv[2]),signal:controller.signal}).then(result=>{clearTimeout(timer);require('node:fs').writeFileSync(process.argv[3],JSON.stringify(result));setInterval(()=>{},1000)},()=>process.exit(1));";
    f.own(spawn(path.join(f.directory, "shapes.inc Bridge Job.exe"), ["--parent-pid", String(process.pid), "--", path.join(f.directory, "node.exe"), "-e", source,
      path.resolve(__dirname, "../src/server.js"), JSON.stringify(command), resultFile, cancellation ? "cancel" : "timeout"],
    { stdio: "ignore", windowsHide: true, env: { ...process.env, SHAPES_BRIDGE_HOME: path.join(f.directory, "state") } }));
    await waitFor(() => fs.existsSync(started) && fs.existsSync(pidsFile));
    const pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
    await waitFor(() => !alive(pids.leader));
    assert.equal(alive(pids.descendant), true, "descendant must retain output after its launcher exits");
    await waitFor(() => fs.existsSync(resultFile));
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.equal(result.exit_code, -1);
    assert.match(result.termination_reason, cancellation ? /command cancelled/ : /timed out/);
    await waitFor(() => !alive(pids.descendant));
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(fs.existsSync(escaped), false, "a stopped receipt must prevent the descendant's delayed side effect");
  });
}
