# Permissions, background service and platform notes

How the standalone install handles operating-system permissions, background startup, Windows commands, recoverable commands and keep-awake. Moved from the README.

On macOS, `install` ends with one guided permission pass: the installed app asks
for Accessibility and Screen Recording, triggers the Automation prompts for
Finder and System Events, and opens the Full Disk Access pane with shapes.inc
Bridge already listed so it only has to be turned on. The installer shows the
checklist and waits until everything is allowed (Enter skips; `--no-permissions`
skips the pass). `permissions` repeats it any time. Grant access to the
installed **shapes.inc Bridge** app for the standalone installation. The native
shapes.inc app instead runs its embedded Bridge under **ComputerConnectionHost**:
enable that item under Privacy & Security → Accessibility. The native setup's
**Show app in Finder** action reveals the exact bundled app if it must be added
to the list. Approving the standalone Bridge does not approve the embedded host.
Setup requests permissions from the background service;
granting Terminal access does not establish that the service has access.
Accessibility and Screen Recording use native preflight checks. Full Disk
Access is checked by opening a protected system file; Automation is checked per
target app (Finder, System Events) without prompting.
Recovery links select the Privacy & Security extension on macOS 13 and newer,
and retain the Security preference pane on older macOS. Opening a pane or
requesting access never changes the reported permission until the native probe
confirms it. The standalone guided setup, explicit per-permission requests and
embedded native requests share this recovery implementation.
The OS may require restarting the connection after a grant (`pause`, then
`resume`). Password, secure-input, lock-screen, and system-protected UI remain
subject to OS restrictions. The bridge does not bypass these protections.

Background startup uses a macOS LaunchAgent (listed in Login Items as
shapes.inc Bridge), Linux user systemd service, or Windows Task Scheduler task
in the signed-in user's interactive session. When the account removes this
computer, the service stops and removes its own automatic startup; run `install`
to connect it again.
Linux requires a working user systemd session; graphical control depends on
the desktop and display server. Windows and Linux report macOS-specific TCC
permissions as unsupported. Cross-platform service definitions are tested with
fixtures; real desktop and restart acceptance requires each supported OS.

Windows command scripts default to PowerShell and retain newlines, `$env`
variables, quotes and Unicode. Use `shell=cmd` explicitly for a single-line
cmd.exe command. The scheduled task remains **LeastPrivilege**: sharing a
computer with another chat member does not grant administrator rights.
`sysinfo.elevated` reports the actual token (or null if it cannot be checked).
For a task needing elevation, the owner must review and perform that specific
operation in an Administrator terminal. `update` or `restart` rewrites the
scheduled task with a valid UTF-16 BOM; existing pairing is retained.

Recoverable commands use `/commands/start`, `/commands/status` and
`/commands/cancel` with server-issued scope and request keys. A detached local
supervisor enforces the command deadline independently of the HTTP connection.
On Linux user-service installations, each supervisor runs in a separate systemd
user scope so restarting the connection does not kill an in-flight command.
Native app-owned runtimes keep their existing cancellation boundary: explicit
pause, logout, disconnect, update retirement or owner termination stops owned
commands too. An interrupted command keeps its receipt and mutation lock until
the local owner reconciles it; reopening the app never replays it. A foreground
close or Quit merely detaches from an established background connection and
does not retire its runtime. This differs from an explicit disconnect.
Poll the receipt after a timeout; never submit a second command to recover a
lost response. Receipts under the private `command-jobs` directory retain job
identity, command hash, timing, exit status and bounded output for 24 hours
(maximum 256 records). A missing supervisor is an unknown outcome, never an
automatic replay. Its mutation lock is held only while the command's supervisor
(or, before a first receipt, its launcher) is alive. After that the next
command, status poll or `shapes-bridge status` releases it; nothing has to be
run by hand, and restart, update and re-pairing no longer leave a computer
refusing commands. The receipt keeps its unknown outcome and the command never
reruns. `shapes-bridge acknowledge-command` still exists and does the same
release on request. There is no remote acknowledgement endpoint.
The public tunnel is reverified on every heartbeat; three endpoint failures
replace the tunnel without pairing again or replaying commands. Windows CI
tests actual Task Scheduler registration, script execution and cancellation.

Keep-awake is enabled by default and can be disabled at setup with `--no-awake`.
It prevents idle system sleep while the service runs, using `caffeinate`,
`systemd-inhibit`, or Windows `SetThreadExecutionState`. It does not unlock the
screen, keep the display lit, override a closed laptop lid, power on a shut-down
computer, or maintain a connection without internet. The service reconnects
after wake or network recovery. Automatic startup begins after user sign-in;
there is no desktop session available before sign-in.
