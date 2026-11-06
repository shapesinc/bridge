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
user-service installations use a separate systemd scope. One mutation fence
serializes commands with legacy `/run`, file writes and opens. At most 256
receipts are retained, with completed results eligible for expiry after 24 hours.

Cancellation acknowledgement is not cleanup confirmation. On POSIX, the shell
process group and descendant groups observed before termination receive TERM,
then KILL; a bounded exit check establishes `cleanup_confirmed`. Signal denial or
missing ancestry evidence remains `outcome_unknown:true`. Unconfirmed termination
keeps the mutation fence until the owner reconciles the command locally. Saved
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
EOF, and otherwise reports interrupted/unknown and retains the mutation fence.
Missing/malformed receipts, query failures, observer death and hard fallback are
not cleanup confirmation. A nonzero observer exit without proof is also unknown
when no explicit Stop was requested: protocol1 persists `interrupted` and keeps
its mutation fence, while historical protocol0 receipt lookup preserves its
`failed` plus `outcome_unknown` shape. An ordinary nonzero command exit with
native proof remains `failed`; successful intentional background handoff remains
`completed`. A late cancellation cannot rewrite either accepted outcome. Private pipes are disposed at final bounded settlement;
late data cannot upgrade an unknown receipt. The local `acknowledge-command`
operation remains the owner's reconciliation path; no remote acknowledgement is
added. These adapters add no AI call, retry or authorization.

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

## Verification and cost

Actual native 106 testing reproduced a shell surviving UI Stop and writing a
late marker. Build 108 repeated that ordinary request through the new primitives:
UI Stop ended the captured Node process/group, persisted cancellation, and the
marker stayed absent beyond its original deadline. Build 109 additionally
completed a repository fix, CSV arithmetic and HTML editing through ordinary
native chats. These are historical candidate receipts, not acceptance of this
integrated protocol 1 package; its affected UI flows remain pending.

`test/command-jobs.test.js` exercises actual HTTP, local independent supervisors,
exactly-once writes, scope isolation, disconnected readers, a cross-process
cancel/initial-save race, tombstones, detached descendants and delayed side
effects. `test/commands.test.js` preserves legacy receipt/primitive checks and
injects signal denial without changing real permissions. Missing-supervisor and
storage-failure cases are explicit simulations. No test uses a paid provider.

Version negotiation, status and cancellation add no inference calls. Native
cleanup proof and private revocation tokens never enter model context. Durable
command receipt fields may enter existing tool continuations, so the integrated
protocol is not assumed to have zero context cost. Adoption and serialized
receipt sizes are unmeasured: an explicit upper scenario of 200 extra input
tokens/result, read 1–5 times, with 20% retry overhead and $1–10/million input
(fully cached to fully fresh) is **+$0.024–1.20/day at 100 results,
+$0.24–12/day at 1,000, or +$2.40–120/day at 10,000**. This covers receipt history
and retries, with no added classifier/embedding/output calls. It is provider
spend, not user credits, and is separate from the 24k→32k retained-history
projection in `docs/bundled-sessions.md`. No savings or measured adoption are
assumed. Regression fixtures themselves spend $0.
