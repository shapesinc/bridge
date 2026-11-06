"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const available = process.platform === "win32" && process.env.SHAPES_TEST_JOB_HOST;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail("Windows launch did not settle"); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function subsystem(file) {
  const bytes = fs.readFileSync(file), pe = bytes.readUInt32LE(60);
  assert.equal(bytes.readUInt32LE(pe), 0x4550); assert.equal(bytes.readUInt16LE(pe + 4), 0x8664);
  return bytes.readUInt16LE(pe + 24 + 68);
}

test("ordinary OS launch is headless; explicit provider console remains opt-in", { skip: !available, timeout: 60000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-gui-launch-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const probe = path.join(directory, "ConsoleLaunch.exe"), previous = path.join(directory, "ConsoleJob.exe");
  await execute(compiler, ["/nologo", "/platform:x64", "/target:winexe", `/out:${probe}`, path.join(__dirname, "fixtures/windows/ConsoleLaunch.cs")], { windowsHide: true, timeout: 20000 });
  // Positive control: the same supervisor code with the old packaging creates
  // a console. Thus a headless CI session or hidden inspector cannot fake pass.
  await execute(compiler, ["/nologo", "/platform:x64", "/target:exe", `/out:${previous}`, path.join(__dirname, "../scripts/windows/JobHost.cs")], { windowsHide: true, timeout: 20000 });
  assert.equal(subsystem(previous), 3); assert.equal(subsystem(process.env.SHAPES_TEST_JOB_HOST), 2);
  for (const [name, host, consoleMode, wrapperConsole] of [
    ["old-console-control", previous, false, true],
    ["background", process.env.SHAPES_TEST_JOB_HOST, false, false],
    ["provider-console", process.env.SHAPES_TEST_JOB_HOST, true, false],
  ]) {
    await t.test(name, { timeout: 18000 }, async () => {
      const wrapperReceipt = path.join(directory, name + "-wrapper.json"), childReceipt = path.join(directory, name + "-child.json");
      const release = path.join(directory, name + "-release");
      const source = "const fs=require('node:fs');if(process.argv[3]==='write'){process.stdout.write('stdout works');process.stderr.write('stderr works');}fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify({pid:process.pid}));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);const end=setTimeout(()=>process.exit(1),12000);const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);clearTimeout(end);}},20);";
      // The old console build is only a positive attachment control. The new
      // build additionally exercises NUL stdio or its opt-in child console.
      const launcher = spawn(probe, ["launch", wrapperReceipt, host, ...(consoleMode ? ["--console"] : []), "--", process.execPath, "-e", source, childReceipt, release, wrapperConsole ? "skip" : "write"], { stdio: "ignore", windowsHide: true });
      let launchError, wrapperPid, childPid; launcher.once("error", error => { launchError = error; });
      try {
        await until(() => fs.existsSync(wrapperReceipt) || launchError || launcher.exitCode !== null);
        if (launchError) throw launchError;
        wrapperPid = JSON.parse(fs.readFileSync(wrapperReceipt, "utf8")).pid;
        await until(() => fs.existsSync(childReceipt) || launcher.exitCode !== null);
        childPid = JSON.parse(fs.readFileSync(childReceipt, "utf8")).pid;
        assert.ok(alive(wrapperPid)); assert.ok(alive(childPid));
        for (const [kind, pid, expected] of [["wrapper", wrapperPid, wrapperConsole], ["child", childPid, consoleMode]]) {
          const receipt = path.join(directory, name + "-" + kind + "-console.json");
          await execute(probe, ["inspect", String(pid), receipt], { windowsHide: true, timeout: 5000 });
          const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
          assert.equal(result.attached, expected, `${name} ${kind}: ${JSON.stringify(result)}`);
          if (expected) assert.ok(result.processCount > 0);
          else assert.equal(result.error, 6, "ERROR_INVALID_HANDLE proves target has no console");
        }
        fs.writeFileSync(release, "release");
        await until(() => launcher.exitCode !== null);
        assert.equal(launcher.exitCode, 0);
        await until(() => !alive(wrapperPid) && !alive(childPid));
      } finally {
        fs.writeFileSync(release, "release");
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
        await until(() => launcher.exitCode !== null || launcher.signalCode !== null);
        if (wrapperPid) await until(() => !alive(wrapperPid));
        if (childPid) await until(() => !alive(childPid));
      }
    });
  }
});
