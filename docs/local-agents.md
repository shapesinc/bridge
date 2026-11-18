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
protection. Granting a chat this computer is the consent: write jobs run with
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

Incremental provider cost, estimated October 4, 2026: approval handling and
deterministic monitoring add no inference calls (**$0/day directly**). For
legacy clients still polling through the model, detection itself adds
**$0/day**, but returning the task ID in earlier status replies adds an estimated
20–40 input tokens per receipt. Fleet traffic and the affected engine mix have
not been measured; the two inspected incident jobs are not a traffic baseline.
With three status reads per job and full reuse of prior receipts in later
context (six total exposures), this is 120–240 input tokens/job. Using current
[OpenRouter catalog](https://openrouter.ai/api/v1/models) Opus 5 rates of $5/M
uncached or $0.50/M cached input tokens gives **$0.006–$0.12/day at 100 jobs/day**
or **$0.06–$1.20/day at 1,000 jobs/day**. These are explicit scenarios, not an
observed bill; more polls, other engines, or cache writes change the estimate.
No classifier, extra report generation, retry, embedding, or retrieval is added
by the monitoring transport; the existing source turn receives the final result.
Avoided retries/final replies are excluded from these gross increases. Local
agent plan usage and user credits are separate; neither rate is changed.
Completing a formerly blocked task uses additional inference on the local
agent account; its engine, token usage, subscription allowance and affected
daily task volume are unknown. As a usage-priced illustration only, an
additional 10,000 input / 2,000 output tokens at Opus 5's $5/M input and $25/M
output would cost $0.10/task ($10/day at 100 such tasks or $100/day at 1,000),
or $0.055/task if all input receives the $0.50/M cache-read price. Actual
continuations can be much shorter or longer; these are not shapes.inc provider
charges or changes to user credit pricing. Automated tests use fake agents
($0 in evaluation inference spend). One bounded, question-only validation
probe used the existing local Codex account and its configured gpt-6-astra
engine; that is one-time local account usage, not recurring shapes.inc spend.

Claude write jobs run with `--dangerously-skip-permissions`: no permission
prompts and no per-command approvals for this task. Managed policy, MCP
services, hooks, and model preferences remain in effect; the launcher changes
no saved settings. The worktree check validates the starting directory only: it
does not make Claude an OS sandbox. Read-only jobs keep `--permission-prompts
none`, so a request that would need interactive permission fails with
`error_type: "permission_denied"` instead of waiting. The write receipt says
`permission_scope: "full-access"`.
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
