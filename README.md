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
terminal open — it's what keeps the door open. Every action your Shape runs
prints in that terminal, live. Press `Ctrl+C` to shut the door instantly.

## Is it safe?

- **Locked with a random secret token**, generated fresh on every run. No token,
  no access — the server rejects the request. Connect it through the private dialog.
- **You see everything.** Every command, file write, and open prints live in your
  terminal.
- **Instant off switch.** `Ctrl+C` closes the door immediately. A new run means a
  brand-new URL and token; nothing lingers.
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

## Let your Shape use local Codex

The `shapes-codex` launcher runs Codex on your computer using your existing
Codex sign-in and settings. On macOS it prefers the CLI bundled with ChatGPT
or Codex over an older executable on your PATH. `SHAPES_CODEX_BINARY` can
select an explicit executable. No credentials are copied to Shapes.

Ask your Shape to do the task in Codex on your computer. Shapes uses the
bridge's native `codex_start`, `codex_status`, and `codex_cancel` actions; you
do not need to supply launcher paths or shell commands. If the computer is not
connected, the Shape's **Connect your computer** link opens the private setup
dialog. **Connect and continue** resumes the request after connection succeeds.
An older running bridge needs to be restarted with the current package to add
the Codex endpoints.

For integrations, `POST /codex/start` accepts JSON with a required `prompt`
(up to 64 KiB), optional absolute `cwd` (defaults to the bridge's working
directory), and optional boolean `workspace_write` (defaults to false). It
returns HTTP 202 with `job_id`, `state: "queued"`, `cwd`, and `sandbox`.
`GET /codex/status?job_id=…` waits up to 20 seconds for a terminal result and
returns HTTP 200 with the current job state. `POST /codex/cancel` accepts
`{"job_id":"…"}`; its `cancel_requested` receipt is not confirmation that the
process has stopped. Check status afterward. Every Codex endpoint requires the
same `X-Token` header as the other machine actions. Native responses exclude
local diagnostic paths and raw logs.

The separate `shapes-codex` CLI remains available for terminal use:

```bash
shapes-codex start --prompt-file /absolute/task.txt --cwd /absolute/project
shapes-codex status JOB_ID
shapes-codex cancel JOB_ID
```

The responses are JSON with `job_id` and `state`; status also returns `final`,
`error`, and `thread_id` (when reported by Codex). CLI status additionally
returns the private local diagnostics directory. Raw Codex output is never
included: MCP startup logs may contain credentials. Poll until `completed`, `failed`,
`cancelled`, or `timed_out`. Only `completed` confirms success. The default
timeout is 30 minutes; the CLI's `--timeout-seconds` changes it (maximum 24 hours).
Queued and running jobs are not completed work. A returned `thread_id` can be
opened in the desktop app using `codex://threads/THREAD_ID` through the bridge's
`open` action when the user requests it.

The default sandbox is read-only. For edits, set `workspace_write: true` (CLI:
`--workspace-write`) and a
dedicated Git worktree path. The launcher refuses writes in a repository's
primary checkout; create the worktree first. A directory outside Git can also
be used, but has no Git worktree protection. Approvals are set to `never`, so
shell commands cannot escalate beyond the selected sandbox; approval-dependent tasks
fail rather than wait for a terminal that is not attached. User Codex rules,
MCP configuration, and model preferences are retained. Extra configured shell
writable roots are cleared. MCP tools retain the access granted by your Codex
configuration; the shell sandbox does not constrain external MCP services. This launcher currently
supports macOS and Linux.

Jobs run independently after the start command returns. **Closing the bridge
does not stop a Codex job already started**; use `cancel` first if needed.
Cancellation and timeout terminate the Codex process group. Prompts and bounded
logs remain locally under `~/.shapes-bridge/codex-jobs/` with private permissions
(directories 0700, files 0600). Remove a finished job's directory to delete its
local records. `SHAPES_CODEX_JOB_DIR` overrides that storage location.

For a local installation independent of your development worktree:

```bash
mkdir -p ~/.shapes-bridge/local-codex
cp -R bin src package.json ~/.shapes-bridge/local-codex/
node ~/.shapes-bridge/local-codex/bin/codex.js --help
```

Use that absolute `bin/codex.js` path with Node in bridge commands, or install
this package to expose `shapes-codex` on PATH. Codex inference uses your Codex
account's plan or configured provider; this helper adds no separate model call.

## License

MIT © Shapes, Inc.
