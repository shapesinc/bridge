# Scoped shell commands

`/capabilities.features.command_jobs=true` advertises independent, token-authenticated
command primitives. The backend composes them for the existing `run` action; no
model polling or new inference call is needed.

- `POST /commands/start` accepts `cmd`, optional `cwd`, optional `timeout` (default
  60, maximum 600 seconds), `scope_id` and `request_key`. Scope and request keys are
  strings of 1–128 ASCII letters, numbers, `_`, `-` or `:`. The backend derives the
  scope from its authorized actor/chat/computer binding. The command ID is SHA-256
  of `scope_id + "\0" + request_key`. New starts return 202; retries of the same
  payload return 200 and the same command. A changed payload returns 409.
- `GET /commands/status?command_id=…&scope_id=…` reads that command, with current
  bounded stdout/stderr. Wrong scope and unknown commands return 404.
- `POST /commands/cancel` accepts only `command_id` and `scope_id`. It requests
  termination, then callers poll status for the terminal receipt. Repeated cancel
  is safe; a late cancel never rewrites an already completed/failed result.
  Cancelling a not-yet-recorded deterministic ID creates a durable tombstone, so
  a delayed or retried start cannot run after Stop.

Receipts contain `command_id`, `state`, `stdout`, `stderr`, `exit_code`,
`cancel_requested`, `cleanup_confirmed`, `started_at`, `finished_at` and `deadline`.
States are `running`, `completed`, `failed`, `cancelled` and `timed_out`. Cancellation
acknowledgement is not cleanup confirmation. The command and observed descendant
process groups receive TERM, then KILL after at most one second; a further bounded
exit check establishes `cleanup_confirmed`. Separate commands retain separate
process groups. Already orphaned daemons are outside this ancestry boundary;
earlier file writes cannot be undone.

The daemon allows at most 32 active commands. Existing shell environment handling,
4 MiB capture cap per output stream, 20,000-character returned tails and 600-second
deadline remain. Private state files use 0600 under a 0700 command directory.
Terminal results survive helper restart. An unfinished record without its live
process object becomes a failed `command_interrupted` receipt with
`outcome_unknown=true` and `cleanup_confirmed=false`; it is never re-executed and
saved PIDs are never signalled. HTTP/tunnel interruption alone does not cancel a
command, allowing polling to resume on the same helper.

The legacy `/run` response is unchanged. Older helpers do not advertise
`command_jobs`; the backend must identify their unconfirmed cancellation instead
of claiming that closing an HTTP request stopped the shell.
Windows explicitly advertises `command_jobs=false` until process-tree termination
is supported. A direct new-command request there also leaves
`cleanup_confirmed=false`: observing the parent's exit does not prove descendant
cleanup. The regression simulates parent-only signalling on the host OS; it is
not a Windows execution test.

Actual native 106 acceptance found the original bug: a plain request started a
120-second Node script, the human clicked Stop, and the script still wrote its
delayed marker after the original deadline. The child then exited normally. The
local receipt is `native 106-direct-shell-stop-failure.json`. This change remains
**NO-GO for release until the updated signed helper repeats that actual UI flow**
with no late marker and confirmed child exit.

`test/commands.test.js` uses actual loopback HTTP and local child processes for
file creation, output/status and cancellation compositions. It verifies scoped
authorization, exactly-once writes, conflicting retries, cancel-before-start,
concurrent isolation, detached descendant cleanup, deadlines, bounded output and
terminal receipt reads from a new process. The interrupted-state control is a
simulated persisted record, not a real helper crash. These tests use no provider
and incur no inference spend. The primitives add no AI calls or model schema;
keeping their control metadata internal preserves a **$0/day normal-path provider
cost increase** at unchanged task usage.
