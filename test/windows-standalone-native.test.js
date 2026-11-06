"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ensureWindowsJobHost } = require("../src/windows-job");

test("standalone Windows source compiles and launches owned commands without app resources", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-job-standalone-"));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const executable = ensureWindowsJobHost({ directory });
  const { stdout } = await promisify(execFile)(executable, ["--parent-pid", String(process.pid), "--", process.execPath, "-e", "process.stdout.write('standalone 🌲')"], { encoding: "utf8", timeout: 5000 });
  assert.equal(stdout, "standalone 🌲");
  assert.equal(ensureWindowsJobHost({ directory }), executable);
});
