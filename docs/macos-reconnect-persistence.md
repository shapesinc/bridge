# Preserve the Mac connection across interrupted retries

October 30, 2026

An enabled saved device can temporarily fail its first heartbeat after the app
reopens. If the person chooses Connect to retry and that attempt is cancelled,
the previous controller persisted `paused: true`, even though the device was
enabled before the retry. Future launches then required Connect again.

The controller now records whether an existing, verified device was enabled at
`beginConnect`. Cancellation stops the current attempt/runtime without adding a
pause in that case. The same decision travels with the completed-attempt receipt
so a lost success reply has the same behavior. Cancellation never writes
`paused: false`, so a newer Disconnect, device removal, or revocation still wins.

The public operation inputs/results, device credentials, existing room grants,
account verification, and OS permission prompts are unchanged. Explicit
Disconnect still persists a pause. Cancelling a resume that began paused still
leaves it paused. Cancelling new pairing still revokes that pairing's device.
Previously saved pauses are deliberately not migrated: the stored state cannot
distinguish an intentional Disconnect from the old retry bug.

## Tested candidate

- Bridge parent: `358e2ecaf7b2a87cb1f2296a5a960bc5d34dbadc` plus this change.
- Exact tested `src/embedded.js` SHA-256:
  `2092b24abb712f1a56b99cea1bb5f9e0712e1df881e053e6ff454ad4f8564823`.
- Native host/XPC: `shapes-inc-native-apps` at `b3ed9f9`.
- Production frontend connection composition: `shapes-chat` at `1bd4f24b7`.
- Both original and patched Debug apps were Developer ID signed, with the
  isolated bundle ID `com.shapesinc.shapes-inc.reconnect-qa`. Builds ran
  sequentially through the shared machine-wide compiler queue.
- Native AppKit/WebKit, XPC, private stdio, controller, daemon, file persistence,
  and child-process cleanup were real. Account/pairing/heartbeat APIs and the
  public tunnel were simulated on loopback. Heartbeat success required the real
  daemon's authenticated `/sysinfo` through an owned local proxy. No OS grants,
  production writes, AI calls, or room actions were performed.

## Results

The original signed app reproduced the bug: connect an existing device, reopen
with a simulated heartbeat failure, retry, then Escape/Cancel persisted
`paused: true`. Normal settled-connection Quit preserved consent. Two rapid
Quit-during-retry trials also preserved consent; the native shutdown/cancellation
race did not deterministically reproduce a pause. The confirmed defect is the
retry cancellation primitive used by interruption/cleanup paths, not every Quit.

The patched signed app passed these actual UI and persisted-state checks:

1. **Enabled retry and reopen:** retry during failed startup, Escape/Cancel,
   Quit, restore transport, reopen without Connect. Saved `paused` stayed false;
   the native sheet showed Connected, the same device ID returned, and pairing
   count stayed one. A page reload retained connection and device identity.
2. **Explicitly paused device:** native Disconnect persisted `paused: true`;
   Quit/reopen stayed paused with no daemon. A Settings-initiated resume followed
   by cancellation also retained that pause.
3. **New setup:** after revoking the fixture device, a fresh Settings pairing
   was approved but its first heartbeat failed. Cancellation revoked the new
   device, removed local config and pending pairing, and settled disconnected.
4. **Account boundary:** page verification succeeded while independent native
   verification returned 503. The UI showed an error, the daemon stopped, and
   the fixture recorded offline. Restoring verification resumed the same device.
   Removed membership hid the old device and did not restart it.
5. **Lifecycle and keyboard:** Return dismissed Done; Escape cancelled pending
   setup; Command-Q stopped the owned app, XPC controller, daemon and tunnel.
   Final fixture state had zero online devices. The fixture server was stopped
   and its listener checked closed.

![Signed candidate automatically reconnected after restart](https://files.shapes.inc/api/files/macos-reconnect-qa-reconnected-after-restart-846c13f564ba405bb5516d1ecc59b477.jpg)

The full bounded Node suite passed **180/180 tests**. The focused controller
suite passed **23/23**; loading the original controller with the new tests failed
three regressions. Tests additionally cover completed and duplicate cancellation,
fresh-controller verification, disconnect/revocation races, membership removal,
account switching, credential identity, and no replacement pairing. Provider
responses in these controller tests are simulated.

Private fixture inputs, sanitized event observations, build logs, and persisted
state receipts are in `/tmp/shapes-macos-reconnect-20261030` on the test machine.
Screenshot upload was verified by matching SHA-256 after download. No raw local
credentials, account cookies, or private user transcripts are committed.

## Release gate

**NO-GO for distribution until the final packaged app is accepted.** This change
must ship in the bundled Bridge inside a newly built macOS app; merging the
Bridge PR alone does not update the installed app. Build/sign/notarize that exact
combined release, then verify live test-account pairing, Cloudflare reachability,
restart and existing room grants against the connected backend on supported Mac
architectures. Those live-provider, room-action, Intel and distribution checks
were not performed here. No production installation, merge or release occurred.

No API shape, AI calls, prompt/context, billing, or traffic volume changes are
introduced. Incremental recurring provider inference cost: **$0/day**.
