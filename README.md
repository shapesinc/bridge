# Shapes Bridge

**Give your Shape hands on your own computer — with your consent.**

Your Shape lives in the chat. The bridge is a tiny program you run on your
computer that lets your Shape reach *this machine* — run a command, read or
write a file, open an app — over a secure, token-locked door that only you
control. Connect it once to your Shapes account, then allow it in the chats
where you want to use it. The connection runs in the background, survives a
closed terminal, and starts again when you sign in to your computer.

## Run it

You need [Node.js](https://nodejs.org) 18+. No DMG, Python, or administrator
installation is required.

```bash
npx --yes --package=https://github.com/shapesinc/bridge/archive/refs/heads/main.tar.gz shapes-bridge install
```

1. Open the approval link printed by the installer (it also opens your browser).
2. Sign in to Shapes and approve the matching confirmation code.
3. Approve computer permissions in your operating system when prompted.
4. Choose this computer in **Connect Computer** in a chat. You can use the same
   saved computer in other chats without installing or pairing it again.

The installer reports **Connected** only after the background process has
contacted Shapes. You can close the terminal. Changing networks or restarting
the tunnel automatically updates the endpoint without changing your account
pairing or existing chat grants.

The installed code and a private Node runtime live in `~/.shapes-bridge/runtime`;
the service never depends on an `npx` cache or an open terminal. Run `install`
again to update it without pairing again. Bare `npx --yes --package=https://github.com/shapesinc/bridge/archive/refs/heads/main.tar.gz shapes-bridge`
starts setup on a new computer and shows status on an existing installation.

Older instructions using `npx github:shapesinc/bridge` are also supported. The
package includes a `bridge` command alias so npm can choose the setup command
even though this package also contains the separate `shapes-codex` command.

## Controls and computer permissions

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

- `status`: show connection and native permission status.
- `pause`: disconnect immediately and remain paused across computer restarts.
- `resume`: reconnect and restore startup at sign-in.
- `permissions`: request Accessibility and Screen Recording from the installed
  background process. Use `permissions full_disk_access` or
  `permissions automation` to open the corresponding macOS settings panel.
- `awake off` / `awake on`: disable or enable prevention of idle system sleep.
- `logs`: show recent private activity logs.
- `uninstall`: stop the service, revoke the account's device credential, and
  remove automatic startup. Private local logs and runtime files remain for
  review; remove `~/.shapes-bridge` yourself if you no longer need them. If offline,
  the local service still stops; run `uninstall` again when online to finish
  account revocation.

On macOS, grant access to the stable installed **Shapes Bridge** runner when
the OS requests it. Setup requests permissions from the background service;
granting Terminal access does not establish that the service has access.
Accessibility and Screen Recording use native preflight checks. Full Disk
Access and Automation are separate OS decisions; Automation is also per app,
so their status remains **unknown** rather than claiming blanket permission.
The OS may require restarting the connection after a grant (`pause`, then
`resume`). Password, secure-input, lock-screen, and system-protected UI remain
subject to OS restrictions. The bridge does not bypass these protections.

Background startup uses a macOS LaunchAgent, Linux user systemd service, or
Windows Task Scheduler task in the signed-in user's interactive session.
Linux requires a working user systemd session; graphical control depends on
the desktop and display server. Windows and Linux report macOS-specific TCC
permissions as unsupported. Cross-platform service definitions are tested with
fixtures; real desktop and restart acceptance requires each supported OS.

Keep-awake is enabled by default and can be disabled at setup with `--no-awake`.
It prevents idle system sleep while the service runs, using `caffeinate`,
`systemd-inhibit`, or Windows `SetThreadExecutionState`. It does not unlock the
screen, keep the display lit, override a closed laptop lid, power on a shut-down
computer, or maintain a connection without internet. The service reconnects
after wake or network recovery. Automatic startup begins after user sign-in;
there is no desktop session available before sign-in.

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
  computer in Shapes revokes its device credential; the service notices at its
  next heartbeat and stops serving. Agent jobs already started continue until completion
  or cancellation; cancel them first if you also want that work to stop.
- The tunnel is a [Cloudflare quick-tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  — no account, no signup, temporary. The `cloudflared` helper is downloaded once
  and cached under `~/.shapes-bridge/`.

There are no new inference calls for pairing, heartbeats, native permission
checks, or keep-awake: **$0/day added provider inference spend**. Existing task
and local-agent execution charges still depend on the work you request.

For temporary legacy URL/token connections, run `foreground`. This mode ends
when its terminal closes. Enter its secret only in the private connection
dialog, never a chat message.

## What your Shape can do

These map 1:1 to the `SHAPES_BRIDGE` tool in the Shapes app.

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
| `codex_start` | start a task in local Codex                 | `POST /codex/start` |
| `codex_status` | wait for a job and read its result         | `GET /codex/status?job_id=…` |
| `codex_cancel` | request that a job stops                  | `POST /codex/cancel` |

## Troubleshooting

- **Shape says it can't connect?** Run `status`. Resume a paused connection;
  check the network and `logs` if it says reconnecting. There is no need to pair again.
- **Computer removed / revoked?** Run `install` to approve a new pairing.
- **Permissions denied?** Run `permissions` on that computer and approve the OS
  prompt. Full Disk Access and per-app Automation may need separate grants.
- **Installed but offline on macOS?** Use the default location. The OS may
  prevent a background service from loading code stored in Downloads or Desktop.
- **Want to stop?** Run `pause`, or `uninstall` to also revoke account access.

## Development

```bash
git clone https://github.com/shapesinc/bridge
cd bridge
node bin/cli.js --help
```

Zero runtime dependencies — just Node's standard library. The only external
piece is the `cloudflared` tunnel binary, fetched on first run.

For isolated development, `install --api-url http://127.0.0.1:8098 --state-dir
/absolute/private/test-directory --no-open` uses a local pairing service.
Remote API origins require HTTPS and redirects are rejected. Only one
background Shapes Bridge service may be installed per OS user; stop the
previous test installation before choosing a different state directory.

Run `npm test` for the local CLI fixtures and authenticated HTTP tests; they
make no inference calls. A 2026-10-02 smoke test also exercised a real temporary
tunnel, the Shapes connection service (with isolated test membership and
storage), and the installed CLI: token checks and cross-member rejection
passed, discovery identified signed-in Codex and signed-out Claude Code,
Claude was rejected before creating a job, and `auto` completed a Codex
read-only file task with the expected answer. Claude execution is covered by
structured fixtures; live Claude inference remains unverified while it is
signed out.

## Let your Shape use local Codex or Claude Code

Ask your Shape to use an agent on your computer for a task. Shapes can discover
local Codex and Claude Code, then delegate using the agent's existing sign-in
and settings. You do not need to supply executable paths or shell commands.
If the computer is not connected, the Shape's **Connect your computer** link
opens the private setup dialog. **Connect and continue** resumes the request
after connection succeeds. Update an older bridge with `install` to add new
endpoints without changing the saved account pairing.

Discovery runs only version, help, and authentication-status checks. `ready`
means installed, compatible, and signed in; it does **not** establish provider
availability, quota, or task success. No prompt is sent during discovery, and
no account identity, authentication output, or credentials are copied to Shapes.
Sign in to the agent locally if it reports `auth_required`.

On macOS, Codex discovery checks its ChatGPT/Codex app bundles and PATH. Claude
discovery checks PATH, `~/.local/bin`, legacy `~/.claude/local` installs,
Homebrew locations, and bounded version directories under Claude Desktop's
`Library/Application Support/Claude/claude-code`. It does not scan credential
files. `SHAPES_CODEX_BINARY` and `SHAPES_CLAUDE_BINARY` can select explicit
executables. Claude needs the current headless permission controls, including
`--permission-prompts none` (added in Claude Code 2.1.259).

All agent endpoints require the same `X-Token` header as other machine actions:

- `GET /agents` returns `agents` with `id`, `installed`, `authenticated`,
  `available`, `status`, and safe `version`/`reason` fields. Status is `ready`,
  `not_installed`, `unsupported`, `auth_required`, or `check_failed`.
  `default_agent` is the first ready agent (Codex preferred), or null.
- `POST /agents/start` accepts a required `prompt` (up to 64 KiB), optional
  `agent` (`auto`, `codex`, or `claude`; default `auto`), absolute `cwd`
  (default: bridge working directory), and boolean `workspace_write`
  (default: false). It returns HTTP 202 with `job_id`, `agent`, `state: "queued"`,
  `cwd`, and `sandbox`. Claude receipts also identify `permission_scope`.
- If no requested agent is ready, start returns HTTP 409 with
  `error_type: "agent_unavailable"`, `started: false`, and sanitized `agents`.
  No job was created. `auto` chooses a ready agent before execution; it never
  retries another agent after a job starts, because partial work may exist.
- `GET /agents/status?job_id=…` waits up to 20 seconds for a terminal result
  and returns HTTP 200 with the current state, `agent`, `final`, `error`,
  `error_type`, `permission_denials` count, and `thread_id` when reported.
- `POST /agents/cancel` accepts `{"job_id":"…"}`. `cancel_requested` confirms
  the request, not that the process stopped. Check status afterward.

Native responses exclude raw logs and local diagnostic paths. Poll until
`completed`, `failed`, `cancelled`, or `timed_out`; queued and running jobs are
not completed work. `completed` confirms a successful agent turn, not that a
purchase or other requested external effect occurred; verify that from the
actual task result. Codex browser/app permission rejections produce `failed`
with `error_type: "permission_denied"`, a positive `permission_denials` count,
and `needs_user_action: true`, even if the CLI exits zero after explaining the
blocker. Cancellation and timeout retain their own states. Claude requires an
explicit successful result, a nonempty final answer, exit code zero, and no
reported permission denials. Assistant text or tool activity alone never
counts as completion. Error details remain in private local diagnostics.

## Permissions and task lifetime

The default `workspace_write: false` uses Codex's read-only shell sandbox.
Claude uses **read-only tools**, not an OS sandbox: only its `Read`, `Grep`, and
`Glob` built-ins are exposed, with `dontAsk` mode, an empty strict MCP config,
and MCP tools denied. User hooks and other local configuration still apply.
Its receipt says `permission_scope: "read-only-tools"` to distinguish this.

For edits, set `workspace_write: true` and a dedicated Git worktree path. The
launcher refuses writes in a repository's primary checkout; create the worktree
first. A directory outside Git can also be used, but has no Git worktree
protection. Codex uses the workspace-write sandbox with approvals set to
`never` and extra configured shell writable roots cleared. Its rules, MCP
configuration, and model preferences are retained; the shell sandbox does not
constrain external MCP services.

Codex's background `exec` stream is not an interactive approval channel. It
cannot show or answer a browser permission prompt through the shapes.inc chat;
an assistant message saying it asked a question is not proof that a usable
prompt appeared. The bridge saves `thread_id` as soon as Codex reports it, so
the existing task can be found while running. Once a task fails on permission,
open that saved task in Codex on the connected computer to review access and
continue there. The [desktop thread link](https://learn.chatgpt.com/docs/reference/commands)
is `codex://threads/THREAD_ID`; it opens the task without approving or restarting
anything. Browser site permissions and the task's approval settings remain
under the user's control. The bridge never retries through another browser or
agent to bypass a denial. Deterministic status detection makes no extra AI calls.

Incremental provider cost, estimated October 4, 2026: detection itself adds
**$0/day**, but returning the task ID in earlier status replies adds an estimated
20–40 input tokens per receipt. Fleet traffic and the affected engine mix have
not been measured; the two inspected incident jobs are not a traffic baseline.
With three status reads per job and full reuse of prior receipts in later
context (six total exposures), this is 120–240 input tokens/job. Using current
[OpenRouter catalog](https://openrouter.ai/api/v1/models) Opus 5 rates of $5/M
uncached or $0.50/M cached input tokens gives **$0.006–$0.12/day at 100 jobs/day**
or **$0.06–$1.20/day at 1,000 jobs/day**. These are explicit scenarios, not an
observed bill; more polls, other engines, or cache writes change the estimate.
No classifier, output generation, retry, embedding, or retrieval is added.
Avoided retries/final replies are excluded from these gross increases. Local
agent plan usage and user credits are separate; neither rate is changed. Tests
use fake agents and incur $0 in evaluation inference spend.

Claude write jobs use `--permission-mode acceptEdits` for this run, so ordinary
requested edits can proceed. Explicit deny/ask rules, managed policy, MCP
services, hooks, and model preferences remain in effect. The launcher changes
no saved settings and adds no Bash allowlist or bypass flag. This mode also
approves common filesystem commands on in-scope paths; configured
`additionalDirectories` remain in scope. The worktree check validates the
starting directory only: it does not make Claude an OS sandbox or remove
access already granted by the user's configuration.
`--permission-prompts none` denies
requests that would need interactive permission instead of waiting for an
unattached terminal. A reported denial makes the job fail with
`error_type: "permission_denied"`; adjust local rules deliberately before a
new attempt. The receipt says `permission_scope: "accept-edits"`.
See the official [CLI reference](https://code.claude.com/docs/en/cli-reference),
[headless guide](https://code.claude.com/docs/en/headless), and
[permission modes](https://code.claude.com/docs/en/permission-modes).

Jobs run independently after start returns. **Closing the bridge does not stop
an agent job already started**; cancel first if needed. Cancellation and timeout
terminate the process group. The default timeout is 30 minutes. Prompts and
bounded logs remain under `~/.shapes-bridge/codex-jobs/` with private permissions
(directories 0700, files 0600); the historical directory name also holds Claude
jobs. Remove a finished job's directory to delete its local records.
`SHAPES_CODEX_JOB_DIR` overrides that storage location. The launcher currently
supports macOS and Linux.

Discovery adds **$0/day in inference cost**. Delegated tasks use the selected
agent's account plan or configured provider; the launcher adds no classifier,
extra inference step, or automatic retry. Provider availability is established by each
actual task result, not by discovery.

## Existing Codex integrations

`/codex/start`, `/codex/status`, and `/codex/cancel` retain the same request
shapes and only operate on Codex jobs. Start accepts `prompt`, `cwd`, and
`workspace_write`; status takes the `job_id` query parameter and cancel accepts
`{"job_id":"…"}`. The `shapes-codex` CLI also remains Codex-only:

```bash
shapes-codex start --prompt-file /absolute/task.txt --cwd /absolute/project
shapes-codex status JOB_ID
shapes-codex cancel JOB_ID
```

CLI status additionally returns the private diagnostic directory. Use
`--workspace-write` for edits and `--timeout-seconds` to change the 30-minute
timeout (maximum 24 hours). A Codex `thread_id` can be opened in its desktop app
using `codex://threads/THREAD_ID` through `open` when the user requests it;
Claude session IDs are not Codex thread links.

For a local installation independent of your development worktree:

```bash
mkdir -p ~/.shapes-bridge/local-codex
cp -R bin src package.json ~/.shapes-bridge/local-codex/
node ~/.shapes-bridge/local-codex/bin/codex.js --help
```

Use that absolute `bin/codex.js` path with Node in bridge commands, or install
this package to expose `shapes-codex` on PATH.

## License

MIT © Shapes, Inc.
