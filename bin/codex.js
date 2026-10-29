#!/usr/bin/env node
"use strict";

const { startJob, getStatus, listJobs, cancelJob, supervise } = require("../src/codex");

const HELP = `Usage:
  shapes-codex start --prompt-file FILE --cwd DIR [--workspace-write] [--timeout-seconds 1800] [--request-key KEY]
  shapes-codex status JOB_ID
  shapes-codex list [--request-key KEY]
  shapes-codex cancel JOB_ID

Jobs use your local Codex sign-in and configuration. The default sandbox is
read-only. Workspace writes require a linked Git worktree when DIR is in Git.
Results are JSON. Poll status for completed, failed, cancelled, or timed_out.
Repeating start with the same --request-key returns the existing job instead of
starting a duplicate; list finds recent jobs, or the job for a request key.
Use SHAPES_CODEX_BINARY to select a CLI and SHAPES_CODEX_JOB_DIR for job storage.
`;

async function main(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "_supervise" && rest.length === 1) {
    await supervise(rest[0]);
    return;
  }
  let result;
  if (command === "start") {
    const options = {};
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--workspace-write") options.sandbox = "workspace-write";
      else if (["--prompt-file", "--cwd", "--timeout-seconds", "--request-key"].includes(flag)) {
        if (!rest[i + 1] || rest[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
        const key = { "--prompt-file": "promptFile", "--cwd": "cwd", "--timeout-seconds": "timeoutSeconds", "--request-key": "requestKey" }[flag];
        options[key] = rest[++i];
      } else throw new Error(`Unknown option: ${flag}`);
    }
    result = await startJob(options);
  } else if (command === "status" && rest.length === 1) result = getStatus(rest[0], "codex");
  else if (command === "list" && (rest.length === 0 || (rest.length === 2 && rest[0] === "--request-key"))) {
    result = listJobs({ requestKey: rest[1], agent: "codex" });
  }
  else if (command === "cancel" && rest.length === 1) result = cancelJob(rest[0], "codex");
  else throw new Error("Expected start, status JOB_ID, list, or cancel JOB_ID; use --help.");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
