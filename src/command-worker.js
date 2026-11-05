"use strict";
const fs = require("node:fs");
const path = require("node:path");
const jobs = require("./command-jobs");
const { runCommand } = require("./server");

async function supervise(id) {
  // Even an accidental second supervisor invocation cannot replay a command.
  fs.closeSync(fs.openSync(path.join(jobs.root(), `${id}.claimed`), "wx", 0o600));
  const record = jobs.load(id), abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  const poll = () => { if (fs.existsSync(path.join(jobs.root(), `${id}.cancel`))) cancel(); };
  const timer = setInterval(poll, 200);
  try {
    poll();
    Object.assign(record, { state: "running", supervisor_pid: process.pid, started_at: Date.now() });
    jobs.save(record);
    const result = await runCommand({ ...record.command, signal: abort.signal });
    Object.assign(record, { state: abort.signal.aborted ? "cancelled" : result.termination_reason?.startsWith("timed out") ? "timed_out" : result.exit_code === 0 ? "completed" : "failed",
      finished_at: Date.now(), result });
    jobs.save(record);
    jobs.release(id);
  } finally { clearInterval(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
}

supervise(process.argv[2]).catch(() => { process.exitCode = 1; });
