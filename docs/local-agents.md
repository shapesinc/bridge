# Local Codex and Claude Code

How shapes delegate tasks to Codex or Claude Code already installed on your computer. Moved from the README.

Ask a shape to use an agent on your computer for a task. Shapes can discover
local Codex and Claude Code, then delegate using the agent's existing sign-in
and settings. You do not need to supply executable paths or shell commands.
If the computer is not connected, the Shape's **Connect your computer** link
opens the private setup dialog. **Connect and continue** resumes the request
after connection succeeds. Update an older bridge with `install` to add new
endpoints without changing the saved account pairing.

Discovery runs only version, help, and authentication-status checks. `ready`
means installed, compatible, and signed in; it does **not** establish provider
availability, quota, or task success. No prompt is sent during discovery, and
no account identity, authentication output, or credentials are copied to shapes.inc.
Sign in to the agent locally if it reports `auth_required`.

On macOS, Codex discovery checks its ChatGPT/Codex app bundles and PATH. Claude
discovery checks PATH, `~/.local/bin`, legacy `~/.claude/local` installs,
Homebrew locations, and bounded version directories under Claude Desktop's
`Library/Application Support/Claude/claude-code`. It does not scan credential
files. `SHAPES_CODEX_BINARY` and `SHAPES_CLAUDE_BINARY` can select explicit
executables. Claude needs the current headless permission controls, including
`--permission-prompts none` (added in Claude Code 2.1.259).

The app-owned Windows host checks native `.exe` installs on PATH, the user's
local bin directory and official npm Codex platform packages. Its bundled Job
helper owns discovery and execution subprocesses. Installed native hosts ignore
shell overrides of their runtime binaries. [Windows host contracts and release
gates](windows-native-host.md) describe foreground quit, task lifetime and
the same pairing, account and budget boundaries used by macOS.

All agent endpoints require the same `X-Token` header as other machine actions:

- `GET /agents` returns `agents` with `id`, `installed`, `authenticated`,
  `available`, `status`, and safe `version`/`reason` fields. Status is `ready`,
  `not_installed`, `unsupported`, `auth_required`, or `check_failed`.
  `default_agent` is the first ready agent (Codex preferred), or null.
- `POST /agents/start` accepts a required `prompt` (up to 64 KiB), optional
  `agent` (`auto`, `codex`, or `claude`; default `auto`), absolute `cwd`
  (default: bridge working directory), and boolean `workspace_write`
  (default: false). The authenticated shapes.inc integration can also set
  `interactive: true` for Codex. It returns HTTP 202 with `job_id`, `agent`,
  `state: "queued"`, `interactive`, `cwd`, and `sandbox`. Claude receipts also
  identify `permission_scope`; Claude continues to use its headless runner.
  Once the agent checks pass, the job is saved as `queued` (and bound to its
  `request_key`) before its runner launches, so its ID can be listed even if
  the start response is lost.
- Start also accepts an optional `request_key` (16-128 letters, digits, `-`,
  or `_`). Repeating a start with the same key and task returns HTTP 200 with
  the existing job's current receipt and `deduplicated: true` instead of
  running the task again. Only a job that failed before it began running can
  be started again with the same key. Reusing a key for a different task
  returns HTTP 409.
- `GET /agents/jobs` lists up to `limit` (default 10, max 50) recent jobs,
  newest first, with `job_id`, `state`, `agent`, `cwd`, `created_at`,
  `error`, and a short `task_preview`. `?request_key=…` returns only the job
  started with that key. `GET /codex/jobs` lists Codex jobs only.
- If no requested agent is ready, start returns HTTP 409 with
  `error_type: "agent_unavailable"`, `started: false`, and sanitized `agents`.
  No job was created. `auto` chooses a ready agent before execution; it never
  retries another agent after a job starts, because partial work may exist.
- `GET /agents/status?job_id=…` waits up to 20 seconds for a terminal result
  and returns HTTP 200 with the current state, `agent`, `final`, `error`,
  `error_type`, `permission_denials` count, and `thread_id` when reported.
  `waiting_on_user` returns immediately with a bounded `pending_requests` form;
  `wait=0` makes any status read immediate. Pending forms are private to the
  authenticated requesting human, not model tool context or other room members.
- `POST /agents/cancel` accepts `{"job_id":"…"}`. `cancel_requested` confirms
  the request, not that the process stopped. Check status afterward.

Native responses exclude raw logs and local diagnostic paths. Poll until
`completed`, `failed`, `cancelled`, or `timed_out`; queued, running, and
`waiting_on_user` jobs are not completed work. `completed` confirms a successful agent turn, not that a
purchase or other requested external effect occurred; verify that from the
actual task result. Codex browser/app permission rejections produce `failed`
with `error_type: "permission_denied"`, a positive `permission_denials` count,
and `needs_user_action: true`, even if the CLI exits zero after explaining the
blocker. Cancellation and timeout retain their own states. Claude requires an
explicit successful result, a nonempty final answer and exit code zero; denied
actions on a successful run are reported, not a failure. Assistant text or tool activity alone never
counts as completion. Error details remain in private local diagnostics.

## Permissions and task lifetime

`workspace_write: false` is only for a person who asked for no changes. It uses
Codex's read-only shell sandbox. Claude uses **read-only tools**, not an OS
sandbox: only its `Read`, `Grep`, and `Glob` built-ins are exposed, with
`dontAsk` mode (shown as "Don't ask" in the Claude app), an empty strict MCP
config, and MCP tools denied. User hooks and other local configuration still
apply. Its receipt says `permission_scope: "read-only-tools"` to distinguish this.
The shapes.inc backend sends `workspace_write: true` for the person's own
computer unless they asked for a look only.

For edits, set `workspace_write: true` and any absolute folder: a primary
checkout, a worktree or a plain directory. The launcher has no worktree rule
(removed 2026-11-23: it made a shape fall back to read-only and box in the
person's Claude Code). Whether to branch, use a worktree or work in a sibling
repository is the agent's call under the person's own settings and instructions,
as when they run it themselves. Granting a chat this computer is the consent: write jobs run with
**full access and no per-command approval prompts**. Headless and interactive
Codex both use `danger-full-access` with approvals set to `never`; the shape is
still asked real questions (`item/tool/requestUserInput`), never for permission.
Codex rules, MCP configuration, and model preferences are retained.

Interactive Codex jobs use a bidirectional
[app-server session](https://learn.chatgpt.com/docs/app-server), keeping the
same thread and task alive during native browser permission requests and user
questions. They require Codex 0.160.0 or later with app-server support;
unsupported clients return an update instruction before creating a job.
The human answers the form in the shapes.inc chat. The backend
checks the actor, room, original computer connection and still-pending request,
then calls `POST /agents/respond` with `{job_id, request_id, response}`. The
response is `{decision: "accept" | "decline" | "cancel", values: {...}}`.
This endpoint is deliberately absent from the model tool's actions. The bridge
revalidates against the original native request and accepts each request ID
once. Cancel stops the job; answering resumes it without starting the task over.
Native asynchronous questions are recognized only from structured
`agentMessage` items with `delivery: "async"` and `questions`. If their turn has
already ended, the job stays waiting. Explicit answers then start one
continuation in the same thread containing only those answers, never a replay
of the original task. Question-like prose alone does not create an approval.

The bridge advertises `features.interactive_codex` on `/capabilities`. Existing
clients and shared computers retain their established headless behavior. The
new personal-job integration monitors completion with deterministic polling and
reports the final result in the original turn. Worker restarts do not replay
tasks; pending jobs remain inspectable through their authenticated room UI.

Supported prompts are MCP primitive forms, native user questions and one-time
command approvals. Unknown schemas, URL authentication, device-verification
proofs and broader filesystem grants stop with `unsupported_approval`;
ordinary chat consent cannot satisfy them. Hard organization/safety denials
remain denials. Neither a textual question nor an exit code proves permission
was granted. Native request IDs, metadata and raw logs are not public receipts.
Native action-level approval details (`tool_title`, `tool_description` and
`tool_params`) are shown intact as bounded plain text; an oversized action is
not approvable through a shortened summary. Other native metadata stays private.
Browser approval uses the native conversation/turn scope, never a fabricated
global grant; only command approval is labeled "Allow once".
The computer owner still controls local code and the token-protected bridge;
this UI is not an isolation boundary against arbitrary same-user code execution.

The bridge saves `thread_id` immediately. If native access remains blocked,
the [desktop task link](https://learn.chatgpt.com/docs/reference/commands)
`codex://threads/THREAD_ID` opens the saved task without granting permission or
retrying it. The bridge never switches browser or agent to bypass a denial.

Claude write jobs ask the person instead of skipping permissions when the CLI
supports host prompts (`--permission-prompt-tool`): they run with
`--input-format stream-json --permission-prompts host --permission-prompt-tool
stdio`, under the person's own settings (allow/ask/deny rules, additional
directories) and their own permission mode: a `permissions.defaultMode` in managed
settings (including `managed-settings.d/` drop-ins), user, project or local
settings is applied by Claude Code itself (no flag); without one, the mode they
chose for that folder (or its nearest parent) in the Claude app's Code tab
(`default`, `acceptEdits`, `auto`, `plan` or `dontAsk`; best effort, read from the
app's preferences); otherwise `--permission-mode auto`, the Claude app's default.
The mode a run actually used comes back as `permission_mode` (from Claude Code's
init event). Each `can_use_tool`
request becomes a `waiting_on_user` job with one pending request ("Allow this
command?" with the folder and exact command or path; Approve once, Deny, Stop
task). Approve answers `allow` and the same session continues; Deny answers
`deny` with a note not to retry; nothing is auto-approved. The receipt says
`permission_scope: "ask-in-chat"`. A run that ends in success is `completed`;
actions denied along the way (by the person, or by Claude Code's own auto-mode
check) are listed in `denied_actions` as `{tool, summary, by}` with the agent's
own description or the program's name, never the raw command; the live
`activity` line names a command's program the same way. `permission_denied` is only for a run
that did not succeed because of a denial. The final assistant message is kept
in the job's result file regardless of the log cap, and status adds
`activity {text, at}` (the current step) and `started_at`. Claude Code can end a turn while a command it started in the background is still running; it stays alive and continues when that command reports. The job stays `running` for that time, and after a few seconds with nothing streamed its `activity` reads "Waiting on a command it left running" until it streams again.

Older Claude Code without host prompts still never skips permissions: it runs
in the person's own mode (the same choice as above) with `--permission-prompts
none`, so what would need asking is denied and listed in `denied_actions`, and
`permission_scope: "own-settings"`. Managed policy, MCP services, hooks, and
model preferences remain in effect; the launcher changes no saved settings.
Read-only jobs keep `--permission-prompts none`, so an action that
would need interactive permission is denied instead of waiting: a run that still
finishes is `completed` with the denial in `denied_actions`, and one that doesn't is
`permission_denied`.

**Images.** `POST /agents/start` and `POST /agents/send` take optional `images`:
up to four `{media_type, data, name?}` (PNG, JPEG, WebP or GIF; base64; each at
most 5 MB, 12 MB in all; the signature must match the type). They are the
person's own chat attachments, read and downsized by the backend; the Bridge
fetches nothing. Each is saved in the job folder (`images/<n>.<ext>`, private
files) and goes with the task: Claude Code gets them as image blocks in the same
stream-json user message (read-only runs switch to `--input-format stream-json`
for this), Codex as `localImage` inputs on the app-server or `--image=<path>` on
`codex exec`. The prompt also names the saved copies so the agent can open or
copy them. The receipt and status say `images: <n>`. Images are not part of the
request fingerprint: they come from the same chat message, so a retry whose
download went differently is still the same request and keeps its first job.
`/capabilities` advertises `features.agent_images` and
`features.agent_any_folder`.

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
supports macOS and Linux; the app-owned Windows distribution adds the native
Job helper needed to enforce the same task cancellation boundary. Foreground
Windows app quit detaches from its durable host and preserves established work.

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
