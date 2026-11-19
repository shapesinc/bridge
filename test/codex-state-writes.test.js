"use strict";
// A job's private files are replaced, never rewritten in place: a supervisor
// that cannot save its receipt is reported as lost. Real files, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { cancelJob } = require("../src/codex");

function job(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-job-writes-")), previous = process.env.SHAPES_CODEX_JOB_DIR;
  process.env.SHAPES_CODEX_JOB_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SHAPES_CODEX_JOB_DIR; else process.env.SHAPES_CODEX_JOB_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = "2b7c9e10-5d3a-4f6e-8a1b-9c0d2e3f4a5b", directory = path.join(root, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({ agent: "codex", status: "running", createdAt: new Date().toISOString() }));
  return { id, directory };
}

test("one failed replacement does not break the process's next private write", (t) => {
  const { id, directory } = job(t);
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!failed) { failed = true; throw Object.assign(new Error("simulated replacement failure"), { code: "EIO" }); }
    return rename(from, to);
  });
  assert.throws(() => cancelJob(id), { code: "EIO" });
  // The supervisor's next save (its terminal receipt, say) must still land.
  assert.equal(cancelJob(id).cancel_requested, true);
  assert.equal(fs.readFileSync(path.join(directory, "cancel"), "utf8"), "cancel\n");
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
});

test("Windows: replacing a job file that another process keeps reading never fails", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const { id, directory } = job(t);
  const file = path.join(directory, "cancel");
  fs.writeFileSync(file, "cancel\n");
  // A status poller in another process, reading as fast as it can.
  const reader = spawn(process.execPath, ["-e", `const fs=require("fs");for(;;){try{fs.readFileSync(${JSON.stringify(file)})}catch{}}`], { stdio: "ignore" });
  t.after(() => reader.kill());
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (let write = 0; write < 400; write++) cancelJob(id);
  assert.equal(fs.readFileSync(file, "utf8"), "cancel\n");
});
