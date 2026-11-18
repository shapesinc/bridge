# Scoped shell commands

`/capabilities.features.command_jobs=true` advertises token-authenticated command
primitives. The authenticated `/sysinfo.command_protocol=1` selects the wire
contract; the capability boolean alone does not select a protocol.

- `POST /commands/start` accepts `cmd`, optional `cwd` and `shell`, required
  `timeout` (1–600 seconds), `scope` and `request_key` (64 lowercase hex digits).
  The backend derives scope from the authorized actor/chat/computer binding.
  `job_id` is SHA-256 of compact JSON `[scope, request_key]`. Starts return 202;
  identical retries return the same receipt with `deduplicated:true`. A changed
  payload under the same key returns 409. There is no uncertain-start replay.
- `GET /commands/status?job_id=…&scope=…` reads the durable receipt, waiting up to
  15 seconds unless `wait=0`. Wrong scope and unknown jobs return 404.
- `POST /commands/cancel` accepts only `job_id` and `scope`. It acknowledges a
  cancellation request; callers must then read the terminal receipt. Repeated
  cancellation is safe, and a late request does not rewrite a terminal result.
  A deterministic ID not yet recorded gets a durable scoped tombstone. Its
  `cancelled_before_start:true`, `command_hash:null`, `cancel_requested:true` and
  `cleanup_confirmed:true` mean no command started; no command hash is invented.
  Exclusive initial receipt creation prevents a delayed start overwriting it.

Protocol 1 uses numeric millisecond timestamps, `job_id`, `command_hash`, state,
exit status and bounded stdout/stderr. States are `queued`, `running`,
`completed`, `failed`, `cancelled`, `timed_out` and `interrupted`. A detached
supervisor owns execution and the deadline, independently of the tunnel. Linux
user-service installations use a separate systemd scope. Completed results are
eligible for expiry after 24 hours.

## Commands run in parallel

Commands do not wait for each other. Any number of chats can use the computer
at once, and several commands sent together in one chat (a model issuing
several tool calls in one step) all start immediately.

- There is no lock between commands, between chats, or between a command and a
  file write, open or legacy `/run`. Two commands that touch the same files at
  the same moment behave like two terminal windows doing so.
- What still keeps one job from running twice is per job, not per chat:
  `job_id` is derived from `[scope, request_key]`, the first receipt is created
  exclusively, and a supervisor claims its job exclusively. The same start sent
  twice, even at the same instant, runs once and the second reply says
  `deduplicated:true`.
- Receipts, status, cancel and timeouts are per job. Each command has its own
  supervisor and deadline; stopping or timing out one does not touch another.
- `command-jobs/running/<job_id>.json` marks a running command. It is removed
  when the command ends. It fences nothing; it exists so the count below works
  and so a command whose supervisor died gets its receipt settled.
- Runaway guard: at most 64 commands running on a computer at once
  (`MAX_RUNNING` in `src/command-jobs.js`; raise it freely). Past that a start
  gets `409 computer_busy` with `busy_reason:"limit"` and no `job_id`. Nothing
  is recorded, so the same request can be sent again; the backend already
  waits and resends for 60 seconds on `computer_busy`. This is the only case in
  which Bridge answers a command with `computer_busy`.
- Receipts: 1,024 are kept (`MAX_RECEIPTS`). When the store is full the oldest
  finished receipts are dropped to make room; a new command is never refused
  for storage, and a running command's receipt is never dropped. A start
  repeated with the same `request_key` after its receipt was dropped would run
  again; that needs 1,024 newer commands in between.
- On Windows a supervisor does not repeat the state directory's ACL rewrite:
  the Bridge process that starts it has just done so and passes
  `SHAPES_BRIDGE_STATE_SECURED`. Repeating it per command made commands that
  start together time each other out.
- `/sysinfo`, `/health`, `/read`, `/ls`, status, cancel and the agent routes
  never waited on commands and still do not.

What still runs one at a time, on purpose:

- `POST /computer` (screenshots, mouse and keyboard): one action at a time,
  because there is one screen and one pointer. A second action sent while one
  is in flight gets `computer_busy` from `src/computer.js`.
- A bundled session accepts one turn at a time (`src/sessions.js`).
- Protocol 0 commands (helpers from build 109 and earlier): 32 at once.

Bridge 0.2.11 and earlier used one whole-computer lock, `command-jobs/mutation.lock`.
It is no longer written and no longer stops anything. One left by a command
that was running across the update is treated as that command's running
marker: its old supervisor removes it on finishing, and otherwise the next
start or `status` settles its receipt and removes it. A damaged one is removed.
Old receipts stay readable. An older Bridge does not read `running/`, so after
a downgrade it does not see commands the newer one started.

Cancellation acknowledgement is not cleanup confirmation. On POSIX, the shell
process group and descendant groups observed before termination receive TERM,
then KILL; a bounded exit check establishes `cleanup_confirmed`. Signal denial or
missing ancestry evidence remains `outcome_unknown:true`. Unconfirmed termination
keeps the running marker only until the command's supervisor has exited; the
receipt keeps `outcome_unknown:true` (see below). Saved
PIDs alone never authorize a new reader to signal a process. Already orphaned
daemons are outside the ancestry boundary; earlier writes cannot be undone.

Windows retains PowerShell/cmd execution through the owned Job helper. Command,
provider and account processes opt into a private cancellation/receipt channel;
their ordinary stdin/stdout contracts remain separate. `CreateProcess` atomically
assigns the child to its kill-on-close Job using `PROC_THREAD_ATTRIBUTE_JOB_LIST`
(Windows10+), while `HANDLE_LIST` inherits only the child's three standard handles.
The observer remains outside that private Job but inside any enclosing runtime
Job. Breakaway is never enabled. The older outer-host CLI mode is unchanged.

On Stop, timeout or bounded provider close, the native observer terminates its
private Job and queries its accounting until `ActiveProcesses == 0`, for at most
750ms. Only that observation emits the exact private `job-empty` receipt. The JS
owner allows at least1s before hard fallback, requires the complete receipt and
EOF, and otherwise reports interrupted/unknown and keeps its running marker.
Missing/malformed receipts, query failures, observer death and hard fallback are
not cleanup confirmation. A nonzero observer exit without proof is also unknown
when no explicit Stop was requested: protocol1 persists `interrupted` and keeps
its running marker, while historical protocol0 receipt lookup preserves its
`failed` plus `outcome_unknown` shape. An ordinary nonzero command exit with
native proof remains `failed`; successful intentional background handoff remains
`completed`. A late cancellation cannot rewrite either accepted outcome. Private pipes are disposed at final bounded settlement;
late data cannot upgrade an unknown receipt. No remote acknowledgement is added: the marker is cleared locally once
the command's supervisor is gone. These adapters add no AI call, retry or authorization.

A running marker stays only while its command's supervisor is alive (or,
before a first receipt, its launcher). When a new start, a status poll or
the local `status` command finds a marker whose process is gone, it settles the
receipt and removes the marker itself; the owner does nothing. On Windows the
command's kernel Job ends with its supervisor, and on POSIX its process groups
have already been signalled, so nothing from that command is still running
under Bridge's ownership. The receipt keeps what is known:

- A supervisor replaces its receipt by writing the complete record beside it
  and renaming it into place. If Windows refuses the rename it retries for five
  seconds, then exits, leaving the record in `<job>.json.<pid>.tmp` and its
  reason in `<job>.worker-error`. A terminal record found there becomes the
  real result; a record that only shows the start could not be saved means the
  command never ran and is reported as failed.
- Otherwise the receipt stays `interrupted` with `outcome_unknown`, marked
  `released_automatically`. It is never replayed.

A marker that cannot be parsed is removed once it is older than a launch can
take (60 seconds). Nothing is left for the owner to clear by hand.

Successful command stdout/stderr EOF still commits the existing explicit
background handoff. An atomic native terminal decision orders cancellation
against that handoff: cancellation that wins kills the Job, whereas completed
handoff intentionally preserves background children in the enclosing runtime.
A released Job does not issue an empty-Job receipt. Earlier side effects are not
rolled back. Windows-native CI must exercise exact compiled helper bytes,
including inherited output, provider stdin, owner/observer death, failed creation
and successful background lifetime; portable mocks do not establish those facts.

Existing environment handling, 4 MiB capture cap per stream, 20,000-character
returned tails and 600-second maximum remain. Private records are 0600 in the
0700 state directory. Interrupted supervisors never automatically replay work.

## Upgrade compatibility

Build 109 and earlier task helpers used protocol 0: no `command_protocol` field,
`scope_id`/`command_id`, SHA-256 of `scope_id + "\0" + request_key`, ISO timestamps,
and daemon-owned commands. New helpers retain protocol 0 receipt reads/cancels,
including truthful unknown outcomes after a helper restart. New protocol 0
starts receive `command_protocol_mismatch`; clients must negotiate before start.
Deploy the version-negotiating backend before the new helper. A client must pin
the selected wire and identity across lost responses, status and cancellation;
it must never fall back to another hash/protocol after a possibly executed start.
Older upstream protocol 1 helpers may lack cleanup evidence and tombstones, so
version 1 alone is not proof of either. Inspect the actual receipt fields.
