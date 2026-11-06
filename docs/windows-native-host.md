# Windows app-owned computer connection

The Windows desktop app composes the same embedded-controller operations as the macOS app. The controller retains pairing ownership, cancellation receipts, account membership, device pause/revocation, local task idempotency, provider funding and existing gateway budget checks. No AI calls, prompts, classifier work or retries are added by this port: incremental provider spend for existing traffic is **$0/day**. Additional adoption may increase existing metered task usage; that traffic is not measured by this change and is not a new per-request cost.

## Primitive contracts

- `spawnOwned(executable, args, options)` launches an installed executable as one owned process tree. POSIX retains existing process groups. Windows uses the bundled `shapes.inc Bridge Job.exe`, which joins a non-breakaway Job before creating its child. Closing or killing the wrapper closes the only Job handle and terminates descendants. The wrapper also watches its exact launching parent handle. Arguments remain an array, with a separate, explicitly selected `cmd` command-string transport. It never discovers processes by name or trusts saved PIDs to authorize cleanup.
- `createEmbeddedHost({controller, token, version, endpoint})` owns one controller and one authenticated foreground attachment. Requests remain the existing bounded embedded protocol. A lost attachment invokes `detach`, cancelling unfinished setup while preserving an established connection. Only disposal of the durable host terminates that controller and its runtime. The 256-bit attachment capability is stored in the app's private ACL-protected state directory and never reaches a web document.
- `commandShell(cmd, shell)` chooses a shell transport independently of execution. Windows PowerShell uses a private UTF-8 script with BOM, preserving multiline and non-ASCII commands without a second command parser. `cmd` is explicitly selected and accepts one line. A command timeout/cancellation ends the exact owned tree. Script files are removed after completion.
- Local task start, status, events, response, cancellation and retry contracts are unchanged. Windows native provider executables and bundled `codex-app-server.exe` now use owned process trees. Personal sign-in opens the provider's official login command in its own console only after the native app's confirmation; no credential is returned over the bridge.

The installed native app registers an app-specific, least-privilege Task Scheduler task under the signed-in interactive Windows user. Its Job wrapper launches `bin/embedded-host.js` with fixed installed paths and a dedicated state directory. A foreground quit closes only its authenticated attachment. Host replacement first probes the packaged version and retires only the exact old task before forwarding mutations. After a logon/reboot, a fresh host needs current-account verification before resuming a saved device.

Package layout is `computer-connection/{manifest.json,node.exe,shapes.inc Bridge Job.exe,shapes.inc Bridge Computer.exe,cloudflared.exe,bridge/{bin,src,assets,package.json},codex/x64/**}`. `manifest.json.version` identifies the packaged app/helper revision. Windows binaries must be compiled from the pinned source and the complete pinned official Codex Windows package must be included; startup must not download executable code.

## Compositions

1. Initial native setup: independent current-session verification → native Connect confirmation → begin pairing → existing authenticated web approval → refreshed verified device list → complete → status. Cancel, navigation and app quit end the exact unfinished attempt.
2. Reopen: attach to the same durable host → independently verify the same account → read status and existing task events. The existing device and task continue after foreground quit. A different account or removed membership suspends access through the existing controller.
3. Explicit pause: disconnect → close/reopen foreground app → verify account → status remains paused. Resuming is an explicit native-approved attempt; no new pairing or funding source is invented.
4. Local work: choose a workspace independently → grant it through the existing authenticated web flow → start a funded built-in or personal-provider task → observe events/respond/cancel through existing primitives. Provider login is separate from discovery and execution.

## Verification and remaining release gates

Portable regression checks exercise native-host account/document races, bounded independent account verification, fixed operation envelopes, lost acknowledgements, private pipe authentication, detach/reconnect/pause, and unchanged POSIX cleanup. Existing local-agent/RPC tests use simulated provider executables and do not make inference calls. Windows CI compiles the native Job helper and exercises actual Windows argv/stdin/stdout, child/grandchild termination, and abrupt-parent cleanup. Computer-helper tests use a throwaway native window.

**NO-GO until final Windows acceptance:** the exact signed installed candidate still needs interactive current-account sign-in, live pairing/tunnel readiness, screen/input operations, personal-provider sign-in, built-in budget failures, account switch/removal, cancel/retry, foreground close/Quit/reopen, logon, update and uninstall checks. A portable test pass or cross-compilation is not evidence for those behaviors. Live provider/payment behavior must be distinguished from simulations.

Known semantic boundary: an individual Windows command's Job ends all of its descendants when the command exits. Intentionally durable work should use the existing supervised local-task/session primitives; arbitrary detached children are not a durable process API. This must be evaluated against required product flows before declaring platform parity.

The PowerShell script transport, elevation metadata and expanded command receipts were adapted from bielmorales's concurrent [Bridge #31](https://github.com/shapesinc/bridge/pull/31), commit `77da236`. This branch substitutes kernel Job ownership for that draft's PID-based command-tree termination. It does not merge or claim readiness for the draft's broader recovery work; reconcile shared files before integrating either branch.

Implementation references: [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [nested Job lifetime rules](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs).
