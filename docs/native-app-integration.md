# Native app integration

How the shapes.inc desktop apps drive Bridge. Moved from the README; the full app-owned contract is in [embedded-native-control.md](embedded-native-control.md).

`src/desktop.js` exposes independent `connect`, `status`, `pause`, `permissions`
and `dispose` contracts. `bin/desktop.js` exposes the first four as fixed newline
commands over private stdin, with JSON status snapshots on stdout. No device
credential or private polling code is returned. Repeated connect during approval
resumes that operation; pause/EOF cancels unfinished approval. Status requires a
fresh heartbeat from the matching device and a live PID before claiming a
connection. The same primitives cover first pairing, resuming a paused device
and reconnecting a revoked device. They do not introduce AI calls: **+$0/day**
provider inference spend; existing requested task execution costs are unchanged.

`bin/embedded.js` is the separate app-owned contract: the signed host launches
it with its own absolute `SHAPES_BRIDGE_HOME` (never the standalone
`~/.shapes-bridge`) and speaks one JSON object per line over private stdio
(`status`, `updateAccount`, `beginConnect`, `completeConnect`, `cancelConnect`,
`disconnect`, `detach`, `requestPermission`). The standalone CLI, controls app,
LaunchAgent and state are untouched. [embedded-native-control.md](embedded-native-control.md) holds
the full contract and its acceptance status.

## Mac app connection window

restart. Closing the window cancels unfinished approval; an established
connection keeps running until disconnected. This requires a Mac app release
built with Bridge 0.2.5 or later; older app releases do not include these controls.

The native window does not grant chat access or operating-system permissions.
**Computer permissions…** explicitly requests the existing permission flow.
Pairing remains separate from the web app's current signed-in session; the
account approving the displayed code owns the computer connection.

## Standalone macOS app

On macOS it installs as **shapes.inc Bridge** in `~/Applications`: the signed,
notarized app from the latest GitHub release (Developer ID: Circle Labs, Inc.),
with the shapes.inc icon in Finder, Spotlight, Login Items and permission
prompts. Opening the app restarts the connection (or resumes it when paused).
