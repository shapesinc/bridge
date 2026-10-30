# Computer connection retry latency

## Cause and change

The tunnel helper returns its public URL before that endpoint is necessarily
reachable. The first device heartbeat asks the backend to validate the endpoint;
an HTTP 409 while the tunnel warms up is retryable. Previously the daemon waited
the full 30-second healthy heartbeat interval after every failed attempt. One
brief reachability failure therefore added 30 seconds to connection setup.

Failed heartbeats now retry after 1, 2, 4, 8, 16, then 30 seconds. Further failures
remain at 30 seconds; a successful heartbeat restores the normal 30-second
cadence and resets the failure count. Every replacement tunnel starts a fresh
failure count, including after an earlier connection succeeded. Healthy
connections keep the same request frequency.

This changes scheduling inside the existing daemon primitive. It adds no API,
permission, credential, pairing, routing, or transport contract. Backend
validation still decides whether the computer is connected; a URL alone is not
success. HTTP 401 still persists revocation and disables automatic startup,
including if its response arrives during disconnect.

The same daemon behavior supports initial app-owned setup, an existing
connection recovering from an API outage, and a replacement tunnel after the
old tunnel exits. Standalone connections use the same primitive.

## Cancellation and limits

Cancellation closes the owned local server and tunnel, wakes retry sleeps, and
prevents additional heartbeats or an intervening connected status. It preserves
the existing in-flight request behavior: a heartbeat already sent can finish,
and a successful receipt records the exact URL/token for conditional offline
cleanup. This patch does not introduce immediate cancellation of the HTTP
transport or a new backend cleanup guarantee. Sustained network/provider
failures, slow permission probes, and the time needed to establish a tunnel can
still delay connection.

## Runtime verification

Tested base: `origin/main` at `358e2ec`. Candidate runtime blob:
`a93880f0694c9063c7a1278d29b417803f98d71c`.

- `node --test test/runtime.test.js test/account.test.js`: **12 passed,
  0 failed**, 300 ms in the final focused run.
- The new startup regression loaded against the unchanged base runtime failed
  as expected: **actual retry delay 30000 ms, expected 1000 ms**. The same test
  passes against the candidate. Timers are controlled in this comparison; it is
  scheduling evidence, not a live tunnel timing measurement.
- Runtime tests exercise initial HTTP 409 recovery, unchanged healthy cadence,
  bounded sustained-outage retries, success reset, replacement tunnel reset,
  cancellation during retry, persistent identity, permission handling, and
  revocation during ordinary operation and disconnect.
- Localhost HTTP tests use the real `apiRequest`/fetch transport: 409 → 200 →
  pending heartbeat → disconnect → successful receipt → matching offline
  cleanup; and a first accepted heartbeat whose response arrives after
  disconnect. The backend is a controlled local fixture; no public tunnel,
  production device, OS consent, AI provider, or payment is exercised here.
- `git diff --check`: passed.
- `node --test --test-concurrency=1`: **180 passed, 0 failed**, 41.743 seconds.
  The local run log is
  `/tmp/shapes-macos-connect-latency-20261030/full-tests.log`.

## Native UI evidence

Computer-use acceptance used native app revision `b3ed9f9` and the exact candidate
runtime blob above in a Developer ID signed arm64 Debug app, isolated bundle ID
`com.shapesinc.shapes-inc.connection-latency-20261030`. The packaged runtime
SHA-256 is `d1306617482652e8a542e19bad1516aba8abe29bcb75834825f05a7e097e77ee`.
The browser composition is the production `NativeComputerConnection` module at
Talk `392f85a4`; the surrounding test page supplies its normal adapter callbacks.

The native host, XPC transport, controller, daemon, permission probes, and
`/sysinfo` server were real. Account/pairing/heartbeat persistence and tunnel
transport were simulated on loopback. Only the staging entry point injects a
local tunnel factory through the existing daemon dependency boundary. No real
account, public tunnel, OS permission grant, or installed-app change was made.

- Native Connect → initial heartbeat 409 → retry → connected completed in
  **1,590 ms**. The actual failed-to-next-request gap was **1,105 ms**.
- The next healthy heartbeat arrived **30,139 ms** later, preserving cadence.
- Return dismissed the native sheet. Page reload settled back to connected
  using the same device, without another pairing.
- Settings disconnect → paused → native confirmation → resume recovered after
  another forced 409. The retry gap was **1,119 ms**. Only one pairing existed
  across initial setup, page reload, and existing-device resume.
- Persistent 409 produced approximately 1, 2, and 4 second retry intervals.
  Escape cancelled; persisted state became paused/offline, no further heartbeat
  arrived, and the owned daemon/tunnel processes exited. Quit/reopen retained
  paused state without reconnecting.
- Simulated HTTP 401 produced one heartbeat, a visible native failure, and
  persisted `revoked: true` with no retry.
- Final Quit exited the QA host, XPC, controller, daemon and proxy. The loopback
  fixture was stopped and port 3052 no longer listened. The installed app and
  its connection were untouched by verification.

![Signed native candidate after simulated first-heartbeat recovery](https://files.shapes.inc/api/files/macos-connect-retry-qa-connected-final-candidate-1e79acadc5c34aa099f765900f248f89.jpg)

Local evidence: `/tmp/shapes-macos-connect-latency-20261030/` contains
`ui-results.json`, `fixture-events.jsonl`, `candidate-final.json`, build/test logs,
and the isolated fixture source. These timings establish removal of the fixed
wait; they are **not live Cloudflare or production backend performance claims**.

## Release status

**Draft / NO-GO for distribution:** production tunnel startup, production
pairing/heartbeat persistence, and final notarized release acceptance remain
unverified. No change is merged, installed, or published. Release order is the
Bridge patch, then rebuild the native app with that helper, then connected
acceptance and normal notarized update publication. No backend/frontend source
change is needed for this scheduling fix.

## Cost

Incremental AI provider spend: **$0/day**. No inference call or prompt/context is
added. A failed connection can issue additional short-lived heartbeat requests
while recovering, with the retry schedule above. The steady-state heartbeat
rate and all AI billing behavior are unchanged.
