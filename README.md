<p align="center">
  <img src="assets/shapes-inc-bridge.png" alt="shapes.inc Bridge" width="96" height="96">
</p>

<h1 align="center">shapes.inc Bridge</h1>

<p align="center">
  Let your shapes use your computer, only in the chats you allow.
</p>

<p align="center">
  <a href="https://github.com/shapesinc/bridge/actions/workflows/ci.yml"><img src="https://github.com/shapesinc/bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

> [!TIP]
> **Most people don't need this repo.** Get the shapes.inc app for Mac or
> Windows from **[shapes.inc/downloads](https://shapes.inc/downloads)**, sign
> in, and choose **Connect this Mac** or **Connect this PC** in a chat. Bridge
> is built into the app, so you don't need a terminal, Node or anything else.
>
> This repo is the source code, plus a terminal install for advanced users:
> Linux, headless machines, or anyone who wants to run it from source.

## What it does

Bridge is a small background app on your computer. Once you connect it to your
shapes.inc account and allow it in a chat, shapes in that chat can:

- run commands and read or write files
- open files, apps and links
- see the screen and use the keyboard and mouse (with your OS permission)
- hand tasks to Codex or Claude Code if you already use them

It keeps running in the background, reconnects after network changes, and
starts again when you sign in.

## Is it safe?

- **Account pairing and chat consent are separate.** Pairing saves the computer
  to your account; a chat receives access only after an explicit chat grant.
  The persistent device credential stays in private local state and is never
  printed in the terminal, browser approval URL, or chat message.
- **Locked with a random secret token**, generated fresh on each background
  process start. The server rejects machine actions without it. Endpoint and
  token changes are registered over the authenticated account connection.
- **Visible activity.** Bridge actions are recorded in private local logs.
  Delegated agent jobs keep their detailed diagnostics in private local files.
- **Disconnect immediately.** `pause` closes remote bridge access. Removing the
  computer in shapes.inc revokes its device credential; the service notices at its
  next heartbeat and stops serving. Agent jobs already started continue until completion
  or cancellation; cancel them first if you also want that work to stop.
- **Your OS stays in charge.** Password, secure-input, lock-screen, and
  system-protected UI remain subject to OS restrictions. The bridge does not
  bypass these protections.
- The tunnel is a [Cloudflare quick-tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  — no account, no signup, temporary. The `cloudflared` helper is downloaded once
  and cached under `~/.shapes-bridge/`.

## Using the shapes.inc app (recommended)

In the shapes.inc Mac app, choose **Computer connection…** from the shapes.inc
application menu, then **Connect**. Approve the matching code in shapes.inc and
choose which chats may use the computer. Node and the tunnel helper are
included; no terminal command or separate download is needed. **Disconnect**
stops remote access and keeps the computer disconnected after restart. This
requires a Mac app release built with Bridge 0.2.5 or later.

The native window does not grant chat access or operating-system permissions.
**Computer permissions…** explicitly requests the existing permission flow.
The app runs its embedded Bridge under **ComputerConnectionHost**: enable that
item under Privacy & Security → Accessibility. Approving the standalone Bridge
does not approve the embedded host.

## Standalone install (advanced)

For Linux, a headless machine, or a computer without the shapes.inc app. You
need [Node.js](https://nodejs.org) 18+. No DMG, Python, or administrator
installation is required.

```bash
npx --yes --package=https://github.com/shapesinc/bridge/archive/refs/heads/main.tar.gz shapes-bridge install
```

1. Open the approval link printed by the installer (it also opens your browser).
2. Sign in to shapes.inc and approve the matching confirmation code.
3. Approve computer permissions in your operating system when prompted.
4. Choose this computer in **Connect Computer** in a chat. You can use the same
   saved computer in other chats without installing or pairing it again.

You can close the terminal afterwards. Install options: `--name <name>` names
this computer, `--no-open` does not open the browser for the approval link,
`--no-awake` turns keep-awake off, and `--no-permissions` skips the guided
permission pass.

On macOS it installs as **shapes.inc Bridge** in `~/Applications`: the signed,
notarized app from the latest GitHub release (Developer ID: Circle Labs, Inc.).
If the release cannot be downloaded, the installer builds an unsigned copy from
your own Node, which macOS lists as an unidentified developer. On Linux it adds
a **shapes.inc Bridge** launcher entry and a user systemd service; on Windows it
registers a **shapes.inc Bridge** scheduled task.

### Everyday commands

The installer creates a local command that works without npm or network access.
On macOS and Linux:

```bash
~/.shapes-bridge/shapes-bridge status
```

On Windows (Command Prompt):

```cmd
"%USERPROFILE%\.shapes-bridge\shapes-bridge.cmd" status
```

Replace `status` with any of these commands. No shell profile changes are made.

- `status`: show connection, version and native permission status.
- `version` (also `--version` or `-v`): print the version, even before pairing.
- `restart`: restart the background connection. Opening the macOS app or the
  Linux launcher entry does the same.
- `open`: the same as opening the app: restart the connection, or resume it
  when paused. Local state only, no network or account calls.
- `update`: download the latest shapes.inc Bridge and reinstall it without
  pairing again.
- `pause`: disconnect immediately and remain paused across computer restarts.
- `resume`: reconnect and restore startup at sign-in.
- `permissions`: repeat the guided pass (Accessibility, Screen Recording,
  Automation for Finder and System Events, Full Disk Access) from the installed
  background process. Name one to request only it: `permissions accessibility`,
  `permissions screen_recording`, `permissions full_disk_access` or
  `permissions automation`; the last two open the corresponding macOS settings
  pane.
- `awake off` / `awake on`: disable or enable prevention of idle system sleep.
- `logs`: show recent private activity logs.
- `uninstall`: stop the service, revoke the account's device credential, and
  remove automatic startup. Private local logs and runtime files remain for
  review; remove `~/.shapes-bridge` yourself if you no longer need them. If offline,
  the local service still stops; run `uninstall` again when online to finish
  account revocation.

### Troubleshooting

- **Shape says it can't connect?** Run `status`. Resume a paused connection;
  check the network and `logs` if it says reconnecting. There is no need to pair again.
- **Computer removed / revoked?** Run `install` to approve a new pairing.
- **Permissions denied?** Run `permissions` on that computer and approve the OS
  prompt. Full Disk Access and per-app Automation may need separate grants.
- **Installed but offline on macOS?** Use the default location. The OS may
  prevent a background service from loading code stored in Downloads or Desktop.
- **Windows: "The task XML is malformed"?** Fixed in November 2026. Run the
  install command again to pick up the fix.
- **Want to stop?** Run `pause`, or `uninstall` to also revoke account access.

Still stuck? [Open an issue](https://github.com/shapesinc/bridge/issues/new)
with your OS, the command you ran and its full output.

## What your shapes can do

These map 1:1 to the `SHAPES_BRIDGE` tool in shapes.inc.

| Action    | What it does                                    | Bridge endpoint  |
| --------- | ----------------------------------------------- | ---------------- |
| `run`     | run a shell command (with a timeout)            | `POST /run`      |
| `write`   | create or replace a file                        | `POST /write`    |
| `read`    | read a file back                                | `GET /read`      |
| `ls`      | list a directory                                | `GET /ls`        |
| `open`    | open a file / app / url with the OS default     | `POST /open`     |
| `sysinfo` | harmless machine stats (os, cpu, mem, disk)     | `GET /sysinfo`   |
| `health`  | check the bridge is alive (no token needed)     | `GET /health`    |
| `agents` | discover local Codex and Claude Code readiness | `GET /agents` |
| `agent_start` | start a task with a ready local agent | `POST /agents/start` |
| `agent_status` | wait for an agent job and read its result | `GET /agents/status?job_id=…` |
| `agent_cancel` | request that an agent job stops | `POST /agents/cancel` |
| `agent_jobs` | list recent agent jobs to find a `job_id` again | `GET /agents/jobs` |
| `agent_send` | send the next message to a session a chat started | `POST /agents/send` |
| `agent_read` | read a session's recent messages, yours included | `GET /agents/read` |
| `agent_status` (session) | is a session running, open elsewhere, its last turn | `GET /agents/session` |
| `agent_cancel` (session) | stop a session's running turn | `POST /agents/session/stop` |
| `codex_start` | start a task in local Codex                 | `POST /codex/start` |
| `codex_status` | wait for a job and read its result         | `GET /codex/status?job_id=…` |
| `codex_cancel` | request that a job stops                  | `POST /codex/cancel` |
| `codex_jobs` | list recent Codex jobs                     | `GET /codex/jobs` |

### Your own Claude Code and Codex sessions

When a shape uses your Claude Code or Codex, it works in a real session in your own
apps, on your own sign-in and plan. The Claude Code session is named after the shape
and the task (for example "Tod: Fix the build"); open it in the Claude app with
`claude://resume?session=<id>` or in a terminal with `claude --resume <id>`. The Codex
thread shows in your Codex app's thread list; open it with `codex://threads/<id>` or
`codex resume <id>`. Follow-ups from the same chat continue that same session, so
you can watch, steer or take over at any point. A chat can only reach the sessions it
started. While a Claude Code session is open in your Claude app or a terminal, shapes
won't send to it. If your Codex config names a model your account doesn't offer, the
shape's turn uses your account's default model and says so.

Claude Code keeps your own permission settings: your allow, ask and deny rules,
additional directories and default permission mode (auto when you haven't set
one, as in the Claude app). When it needs your OK, the chat shows the exact
command or file and its folder with **Approve once** and **Deny**; only you, as
this computer's owner, can answer, and the same session carries on. Nothing is
approved for you, and a folder outside the task's folder is reached only through
such an approval. A run that finishes its work is reported as done, with anything
that was denied listed alongside its result. The chat's task card shows what the
agent is doing right now and has Stop.

## Documentation

| Topic | |
| --- | --- |
| Standalone install details, legacy `foreground` mode, dev notes | [docs/standalone-reference.md](docs/standalone-reference.md) |
| Permissions, background service, Windows, keep-awake | [docs/platform-details.md](docs/platform-details.md) |
| Screen, keyboard and mouse control | [docs/computer-control.md](docs/computer-control.md) · [Windows](scripts/windows/COMPUTER_CONTROL.md) |
| Recoverable shell commands | [docs/commands.md](docs/commands.md) |
| Local Codex and Claude Code | [docs/local-agents.md](docs/local-agents.md) |
| Account autofill for input forms | [docs/autofill-metadata.md](docs/autofill-metadata.md) |
| Native app integration | [docs/native-app-integration.md](docs/native-app-integration.md) · [embedded contract](docs/embedded-native-control.md) · [Windows host](docs/windows-native-host.md) |
| Releasing | [docs/releasing.md](docs/releasing.md) · [AGENTS.md](AGENTS.md) |

## Development

```bash
git clone https://github.com/shapesinc/bridge
cd bridge
node bin/cli.js --help
npm test
```

Zero runtime dependencies — just Node's standard library. The only external
piece is the `cloudflared` tunnel binary, fetched on first run. CI runs
`npm test` and `npm pack --dry-run` on every push to `main` and every pull
request.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for what we're
looking for. Report security issues privately as described in
[SECURITY.md](SECURITY.md). AI coding agents should follow [AGENTS.md](AGENTS.md).

## License

MIT © Shapes, Inc.
