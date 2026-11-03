# Local tasks from the macOS app

The macOS app launches Bridge with a small system `PATH`. Before this change,
authenticated `/run` requests could not find installed Homebrew or user-local
tools, and native agent probes and runners inherited the same incomplete
environment. The native app also needs to launch Bridge in the user's home
directory; that integration change belongs to the macOS app repository.

## Primitive contracts

- `localEnvironment` preserves inherited variables and PATH order. On macOS it
  appends standard Homebrew, `/usr/local`, `~/.local/bin`, pnpm, Bun and Cargo
  locations. Commands, agent discovery/probes, Git validation, detached job
  supervisors and Codex RPC share this environment. Other platforms retain their
  existing environment. It does not run shell startup scripts.
- `expandHome` expands only `~` and `~/...`. Shell working directories and file
  operations use the same rule. Explicit working directories and the standalone
  CLI's launch directory retain their existing semantics.
- `/run` remains an authenticated shell-command primitive with bounded stdout and
  stderr, a numeric exit code, and a 1–600 second timeout. On macOS/Linux, timeout
  or excess output sends SIGTERM to the command's process group, followed by
  SIGKILL after at most one second. It then closes its own pipes and settles the
  HTTP result even if a detached descendant retained the other ends.
- Agent discovery/start/status/jobs/cancel, durable receipts, request-key
  deduplication, sandbox selection, and authorization retain their contracts.
  No workflow-specific tools or permission changes were added.

## Replay and verification

The implementation was prepared from Bridge revision `9d4df37`; the containing
commit identifies the candidate. Request-level tests use the real loopback HTTP
server, real shell processes, throwaway files, and a deterministic fake agent CLI.
They make no provider calls and do not inspect production data.

Three compositions exercise the shared primitives:

1. A shell task finds a user-installed executable with only the native app's
   system PATH inherited. Before the fix the same fixture returned command not
   found; afterward it returns the expected output without changing daemon env.
2. Write a file under `~/Project with spaces`, append through a shell command in
   that directory, then read/list it and verify the persisted content.
3. Discover a fake signed-in CLI, start a task whose own subprocess uses the
   local tool PATH, retry with the same request key, retrieve completion, list the
   durable job, and start/cancel another running task.

Additional real-process cases cover unauthorized requests without side effects,
invalid cwd and missing files, nonzero command exits, ordinary child completion,
timeout without a late write by a child in the command group, SIGTERM-resistant
children, output limits, and a detached descendant holding inherited pipes.
The escaped fixture is stopped by its recorded test-owned PID after verifying
that the HTTP timeout remains bounded.

Validation commands:

```sh
node --test test/local-workspace.test.js test/server.test.js
node --test --test-concurrency=1 test/agents.test.js test/codex-server.test.js test/codex-rpc.test.js test/interactive-jobs.test.js
```

The affected agent/RPC regression subset passed 67 tests. The final timeout
follow-up was checked with the focused timeout cases instead of repeating those
unchanged suites. Native app/browser flows and live provider behavior require
separate integration verification; these fixtures are not evidence of either.

## Limits and cost

Shell aliases/functions, arbitrary nvm/asdf installations, and environment
variables created only by startup scripts are not loaded. Explicit PATH and
executable overrides remain available.

Process-group cancellation does not guarantee termination of arbitrary detached
daemons that deliberately escape the command's group. Such a process can keep
running and produce side effects after the timeout; the receipt guarantees a
bounded wait, not rollback or containment of escaped processes. Intentional
background commands and the existing HTTP-disconnect behavior are unchanged.
Windows retains its existing process termination scope.

No AI calls or prompt context were added. Incremental recurring provider cost is
**$0/day** at every traffic level; the local replay fixtures also incur no
provider spend.
