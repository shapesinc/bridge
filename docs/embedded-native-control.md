# App-owned computer connection

The macOS app can compose the same pairing API and Bridge runtime without opening the standalone controls app or installing its LaunchAgent. The standalone CLI, controls, per-user installation, and state remain unchanged. No AI calls are added: incremental provider spend is $0/day.

## Private host contract

The signed native app's bundled XPC service launches the bundled Node runtime with `Contents/Resources/runtime/bin/embedded.js`. It supplies an absolute, app-specific `SHAPES_BRIDGE_HOME`; this directory must never be the standalone `~/.shapes-bridge`. State is private (directory 0700, JSON 0600). Production defaults to `https://api.shapes.inc`; the signed DEBUG host may supply `SHAPES_BRIDGE_API` as `http://127.0.0.1:<port>`, with an explicit canonical numeric port1–65535. No alternate host/IP spelling, credentials, trailing slash, path, query or fragment is accepted. An invalid explicit value fails before state or IPC startup. This keeps the original `http://127.0.0.1:8080` fixture and permits an isolated `http://127.0.0.1:8040` fixture when another task owns8080. The signed native host restricts this setting to Debug builds; RPC cannot select paths, origins, executables, or credentials.

Requests are one JSON object per line: `{version:1,id,operation,params}`. Replies contain `{version:1,id,result}` or `{version:1,id,error:{code,message}}`. Requests are limited to 16 KiB, replies to 64 KiB, and concurrent request IDs to 32. Unknown fields and operations are rejected. stdout carries only protocol replies; daemon diagnostics stay in its private log.

- `status({})` reads sanitized current state. It never authenticates, launches a runtime, probes permissions, or requests consent.
- `updateAccount({userId,deviceIds,verified})` supplies the host's independently verified current account and device membership. Sign-out, failed verification, account change, or removed device stops access. A saved enabled device resumes only for its verified owner and current membership. The native host must verify this using the current authenticated session; a web page's asserted IDs alone are insufficient.
- `beginConnect({attemptId,expectedUserId})` returns `{attemptId,userCode}` for a new pairing, or `{attemptId,deviceId}` for a verified existing device. Exactly one field is present. Repeating the active attempt is idempotent.
- `completeConnect({attemptId})` polls the private pairing and verifies its server-proven `owner_user_id` against the host account and fresh device list. The page must refresh that list after approval. It returns success only after the owned daemon publishes a fresh matching heartbeat. `pairing_pending` and `connection_pending` are retryable on the same attempt. Each readiness wait is bounded to 20 seconds; the host should allow a 90-second overall setup deadline and cancel on navigation or timeout.
- `cancelConnect({attemptId})` cancels that setup, including the exact latest completed attempt when its success reply was lost. New pairing cancellation uses its private cancellation capability and revokes only the device issued by that pairing. Cancelling a resume of an explicitly paused device leaves it paused without revoking its grants. Cancelling a retry of an already-enabled device stops the current runtime but preserves its existing reopen consent. It never clears a newer pause or revocation; resuming still requires verified owner and device membership. Old attempt IDs cannot stop a newer attempt.
- `disconnect({})` persists pause before stopping the app-owned runtime. Subsequent account refresh cannot silently resume it.
- `requestPermission({permission})` requests exactly one of `accessibility`, `screen_recording`, `full_disk_access`, or `automation` from the app-owned daemon. It requires a verified active device. No connect or status operation requests OS consent.

Status is `{state,online,deviceId?,deviceName?,permissions,error?}`. States are `disconnected`, `connecting`, `connected`, `paused`, and `error`. Permission values are `granted`, `denied`, `unknown`, or `unsupported`. Error values are fixed codes; raw diagnostics, paths, device tokens, private pairing codes, and tunnel credentials never cross this boundary. Device metadata is hidden from unverified or different accounts.

While an explicit setup is waiting for its first heartbeat, a transient tunnel
reachability retry remains `connecting` with `online:false`. Revocation, an
explicit runtime failure, and connection loss after an acknowledged heartbeat
remain errors. The host cancels its exact attempt after a terminal failure or
its overall deadline, allowing a fresh attempt after cleanup.

## Lifetimes and cancellation

Closing an app window leaves its native process and connection running. Explicit Quit closes stdin and disposes the controller: unfinished approval is cancelled, owned runtime/jobs stop, and established enabled opt-in remains saved. Reopening requires fresh same-account verification before resuming. Explicit Disconnect remains paused across reopen.

The daemon is a private child process group with a Node IPC parent-lifetime watchdog. Controller death closes IPC, aborts the daemon, and bounds cleanup. Detached agent supervisors and their groups are identified by actual process ancestry before shutdown; no global process name or saved arbitrary PID grants kill authority. Agent job state is isolated under the app's private directory. Existing standalone jobs are not touched.

A failed server cancellation retains the private cancellation capability for retry until expiry. Local access still stops. A restarted controller cancels orphaned approval before it can resume or start another pairing. The server's cancellation endpoint must tombstone a just-issued device during approval races; an old server without cancellation and approved-poll owner fields is not compatible with enabling this feature.

Before starting a newly approved runtime, the persisted pairing receipt replaces its bare private code with the full `sbd_UUID.secret` device credential. Existing backend tool-result redaction recognizes that credential. Cancellation derives the private code in memory; the pending receipt cannot introduce an unrecognized bare secret into a computer file-read result.

## Compositions and validation

The original app setup composition is verify account → begin → approve in the current authenticated page → refresh verified devices → complete → explicitly request named OS permissions. Alternatives use the same primitives: reopen an enabled device after verified account sync; resume an explicitly paused existing device without a new pairing; or inspect status and disconnect without opening setup or prompting for permissions.

Focused tests cover those compositions, cancelled/late approval, owner mismatch, removed membership, missing verification, readiness retries, lost success replies, cancelled resume, orphaned private cancellation, malformed/oversized IPC, private stdio EOF, fresh-PID status, and real child-process cleanup after controller SIGKILL. Provider responses and OS permission grants in controller tests are simulated; process lifecycle and stdio tests launch actual local Node processes. Standalone account/controller/runtime regressions are run separately.

Local verification on October 29, 2026: the full bounded Node suite passed 167 tests before the final credential-storage and in-flight removal hardening; 41 focused controller/protocol/process/account/standalone-runtime tests passed after that change, including an actual authenticated local `/read` of the synthetic pending receipt. Signed universal packaging is validated separately. No permission or live AI requests were made by these tests.

**NO-GO until integrated acceptance:** the exact signed native candidate must demonstrate current-session pairing, connection/permissions UI, macOS consent attributed to shapes.inc, cancellation and retry, account switch/removal, window close, Quit/reopen, and unchanged standalone behavior against the candidate backend. Passing focused tests or a signed build does not establish those outcomes. Deploy backend cancellation/owner support before enabling the native and web slices.

Permission recovery follow-up: an explicit single App control action now opens
macOS Automation settings as well as issuing the existing per-target request.
macOS can suppress a previously denied prompt, so retry no longer appears to do
nothing. The target list, OS consent, passive probes, and all-permissions
standalone setup are unchanged. The 26 focused permission/controller tests pass;
first-request and denied recovery use simulated OS transport. Actual denial →
Settings → grant/retry on the final signed app remains required.

First-heartbeat status follow-up (October 30, 2026): the installed combined
QA85 candidate at native187dc1a/helper2adfda6 recorded a backend HTTP409
readiness failure before any successful heartbeat and displayed unavailable
while setup was still pending. The scope of this correction is that transient
status; the triggering attempt's provenance was not established. Two regression
cases failed before the fix. The final36 focused embedded controller/protocol,
standalone controller, and runtime tests pass. Simulated transport/process-state
cases cover retry→connected, cancellation and runtime failure→disconnected→new
attempt, and preserved revocation/later-loss errors. Real private stdio and
local file-read boundary tests also passed. Corrected native button/status,
live pairing, tunnel readiness, and OS consent still require the rebuilt
integrated candidate; this is not live connection acceptance.
