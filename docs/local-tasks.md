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
- `expandHome` expands only `~`, `~/...`, and Windows-native `~\...` on Windows. Shell working directories and file
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

## Limits

Shell aliases/functions, arbitrary nvm/asdf installations, and environment
variables created only by startup scripts are not loaded. Explicit PATH and
executable overrides remain available.

Process-group cancellation also captures descendant groups that still have
observable ancestry at Stop/timeout. Already orphaned daemons can remain outside
that boundary and produce later side effects; this is not rollback or general
process containment. Intentional background commands and the existing legacy
HTTP-disconnect behavior are unchanged. [Scoped command start/status/cancel](commands.md)
provide explicit cancellation instead of relying on closing an HTTP request.
Windows uses the owned Job and independently confirmed cleanup receipt described
in the command contract; uncertain termination keeps its running marker.
