# Shapes Bridge

**Give your Shape hands on your own computer — with your consent.**

Your Shape lives in the chat. The bridge is a tiny program you run on your
computer that lets your Shape reach *this machine* — run a command, read or
write a file, open an app — over a secure, token-locked door that only you
control. You run one command, connect it privately in Shapes, and your Shape
can act for you. Close the terminal and the door vanishes.

## Run it

You need [Node.js](https://nodejs.org) 18+ (nothing else — no Python, no setup).

```bash
npx github:shapesinc/bridge
```

It prints one line:

```
BRIDGE https://something-random.trycloudflare.com AbC123secretkey
```

**Open Connect Computer in Shapes and enter the URL and token privately. Never
paste the `BRIDGE …` line or token into chat messages.** Leave the
terminal open — it's what keeps the door open. Every bridge request
prints in that terminal, live. Press `Ctrl+C` to disconnect remote access.

## Is it safe?

- **Locked with a random secret token**, generated fresh on every run. No token,
  no access — the server rejects the request. Connect it through the private dialog.
- **Visible activity.** Every bridge action prints live in your terminal.
  Delegated agent jobs keep their detailed diagnostics in private local files.
- **Disconnect immediately.** `Ctrl+C` closes bridge access. A new run means a
  brand-new URL and token. Agent jobs already started continue until completion
  or cancellation; cancel them first if you also want that work to stop.
- The tunnel is a [Cloudflare quick-tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  — no account, no signup, temporary. The `cloudflared` helper is downloaded once
  and cached under `~/.shapes-bridge/`.

> Treat the `BRIDGE …` line like a password: it grants access to this computer
> for as long as the terminal stays open. Enter it only in Connect Computer,
> and quit when you're done.

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

- **Shape says it can't connect?** The terminal probably got closed. Run the
  command again and reconnect through Connect Computer.
- **Wrong token / 401?** Reconnect with the current URL and token through Connect Computer.
- **Want to stop?** `Ctrl+C` in the terminal. The door closes immediately.

## Development

```bash
git clone https://github.com/shapesinc/bridge
cd bridge
node bin/cli.js
```

Zero runtime dependencies — just Node's standard library. The only external
piece is the `cloudflared` tunnel binary, fetched on first run.

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
after connection succeeds. Restart an older bridge with the current package
and reconnect to add these endpoints.

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
not completed work. Only `completed` confirms success. Claude requires an
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
