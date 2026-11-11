# Built-in local sessions

The macOS distribution includes the official Codex OSS app-server **0.166.0**. It can run a local task without a separately installed coding app or personal provider account. The connected shapes.inc backend supplies a short-lived, credit-funded gateway grant for each turn. Explicit personal Codex/Claude Code selection continues using the existing local CLI account. No provider request occurs during discovery or session creation.

## Composable contracts

Every endpoint below requires the existing Bridge token except public capability discovery. The backend remains responsible for checking the acting person, chat membership, device grant, wallet and budget; a working directory does not grant access.

- `GET /capabilities`: `features.bundled_sessions` indicates a bundled executable is present. `features.session_input` additionally advertises original text/image turn inputs. The backend must check this before sending attachments; older helpers cannot preserve them and must not receive a silently reduced text-only task. Older helpers remain compatible with installed-agent discovery.
- `POST /sessions/create`: `{session_id, scope_id, cwd, workspace_write, funding:"shapes_credits"}`. The backend supplies a UUID and an opaque actor/chat/device binding. Canonical cwd, write mode and funding are immutable; an identical retry returns the original receipt, a different scope returns 403, and different settings return 409. Creating a session does not start inference.
- `GET /sessions/read?session_id=…&scope_id=…`: durable session metadata and latest ordinary job status.
- `GET /sessions/events?session_id=…&scope_id=…&cursor=…`: up to 100 persisted native events and an opaque continuation cursor. Each job retains at most about 8 MiB of events, with large events summarized. Terminal receipts remain available when event history is truncated.
- `POST /agents/start`: `{session_id, scope_id, prompt, request_key, gateway}` sends one turn using the existing durable job primitive. `gateway` contains `{base_url, token, model, expires_at, run_id, session_id, scope_id, request_key}`. Expiry is Unix seconds (ISO timestamps are also accepted); bindings must match, and HTTPS is required except loopback HTTP for development. The request key remains unchanged for `GET /agents/jobs?request_key=…` recovery after a lost response. Reusing a key with a different task or session returns 409. Only one turn per session runs at a time.
- Instead of `prompt`, a session turn may supply `input: [{type:"text", text}, {type:"image", url}, …]`. Exactly one of `prompt` and `input` is required. The ordered input is the source of truth passed to Codex without rewriting the human's text or substituting image descriptions. Task guidance can be a separate text item. Inputs have 1–64 items, at most four images, a combined serialized UTF-8 limit of 128 KiB, at most 64 KiB of text, and at most 64 KiB of decoded image data. Images use canonical `data:image/png;base64,…`, JPEG or WebP data URLs with matching file signatures. Remote URLs, `localImage`, extra fields and arbitrary tool/role inputs are rejected before dispatch. The authenticated backend resolves only attachments authorized for the acting person and original chat message, validates/decodes and bounds them, and retains source provenance separately. Bridge does not fetch URLs or derive provenance from model text. Gateway modality, retained-history image counts, token, byte and spending limits still apply independently.
- Existing `/agents/status`, `/agents/respond` and `/agents/cancel` remain the status/input/cancellation boundaries. A new turn after completion or cancellation resumes the most recent native thread. It starts a new supervised process; the conversation itself persists in the private runtime home.

Receipts identify `agent:"codex"`, `funding:"shapes_credits"`, `session_id` and `runtime_version`. Receipt usage is this job's increment, not cumulative previous-turn usage; the gateway independently meters actual provider calls. Prompts are limited to 64 KiB, jobs retain existing deadlines, and sessions cap at 5,000 turns. A reused request key that never launched can follow the existing job retry contract.

The typed input participates in the complete job fingerprint, including item order and exact inline image bytes. Changing an attachment while reusing the same request key is a conflict, not a second execution. Private job storage retains the input with mode 0600; public task previews contain text only. Start retries, cancellation and later same-thread turns keep their existing behavior. Legacy text-only fingerprints remain unchanged. This change does not enable computer input tools, personal-provider typed input, or access to another app's profile.

Text/image items may additionally carry a server-owned `context_key` (1–160 ASCII letters, digits, `_`, `:`, or `-`, unique per packet). This identifies one immutable source item; it grants no authority. Keys should bind the persisted source content and item index. On a new turn, the session omits only keys already acknowledged on the exact native thread it is resuming. The complete original packet remains the idempotency fingerprint and private record; a separate execution packet omits delivered context and strips all keys before `turn/start`. Reusing a delivered key with different content is a conflict. Unkeyed instructions always reach the new turn. A packet containing only already-delivered items requires a new instruction rather than silently starting an empty turn.

Delivery is recorded only after the runtime acknowledges the initial `turn/start` or emits `turn/started`, never merely when a job is queued or a thread is created. Private per-job records reconstruct the delivered key/content-hash ledger after a Bridge restart, scoped to this session and native thread. A rejected pre-turn input remains eligible for delivery, and another session starts with no delivered context. Authenticated `GET /sessions/read` additionally returns `context_thread_id` and at most 128 recent `delivered_context_keys`, letting the backend avoid downloading known attachments before dispatch. This discovery is bounded and advisory; dispatch still applies the complete local ledger under the session lock. Lost-start recovery must precede source pruning/materialization, so retries do not depend on later attachment availability or alter the original fingerprint.

The actual pinned 0.166.0 runtime rejects remote HTTPS image URLs at `turn/start`; inline images are required despite newer app-server documentation showing remote URL input. Its Responses request emits `{type:"input_image", image_url:"data:…"}` without `detail`, and resumed threads retain earlier image items. The gateway must account for that default detail and retained image history. A successful turn transport check does not prove that the model understood the image.

The funded runtime also enables the existing local `view_image` tool so it can inspect screenshots and other image files covered by its existing filesystem access. This does not capture screens or control the computer. Its image output enters the same funded Responses gateway and must pass the image/model token accounting, current grant, budget, image-count and unchanged 256 KiB request envelope checks; oversized local images can still fail explicitly. It requires deployment of the corresponding gateway image contract first. Other disabled runtime features remain disabled.

HTTP tests cover typed-input rejection before a job exists, authentication, canonical encoding/MIME and aggregate size limits, four-image input, complete-input idempotency, changed-attachment conflict, private persistence, same-thread restart/follow-up and cancellation. Context regressions cover five follow-ups without repeated source delivery, unchanged retries after delivery, changed-key conflicts, new-session isolation and a failed turn before acknowledgement. The actual pinned runtime with a loopback simulated provider receives the original text and inline image, writes a real local fixture file, resumes with both original and follow-up images, continues five more times without duplicating either image, and views a separate local PNG via `view_image`. Existing JavaScript, HTML, CSV, read-only, overflow and cancellation replays remain included. This is actual local execution with simulated model responses, not live vision-quality, billing or macOS UI acceptance.

Failure receipts preserve the sanitized provider status and reason. Recovery advice uses the job's immutable funding: a funded 401 points to retry/support in shapes.inc, and a funded 429 points to shapes.inc credits or retry. Neither asks for personal Codex sign-in or plan changes. Explicit personal jobs keep their existing vendor-account guidance. Error presentation does not change dispatch, grants, retries, billing or terminal state.

Funding tokens are supplied through the supervisor environment and never written in request metadata. The runtime uses an isolated private `CODEX_HOME`; personal Codex/OpenAI/Anthropic profile environment is removed. Shell tools exclude the gateway token, and Bridge redacts it from event, result and diagnostic persistence. A fresh grant is required for a later turn. Server-side revocation, reservation settlement and billable usage journaling remain backend responsibilities.

Existing execution semantics are preserved: read-only uses the native read-only sandbox; authorized write mode uses the existing full-access execution setting, with primary Git checkouts rejected in favor of dedicated worktrees. Plain folders do not require Git or macOS Command Line Tools. A cwd is not a filesystem isolation boundary. Cancellation owns the app-server process group; intentionally escaped detached daemons are not guaranteed to terminate.

`/agents/cancel` acknowledges the cancellation request; callers must read status for the terminal result. Once the runner observes cancellation, it gives its process group 1.5 seconds to exit after SIGTERM, escalates to SIGKILL, and waits at most another 1.5 seconds for the owned parent to exit. It then closes its own pipes, so an escaped descendant holding stdout cannot keep the receipt pending. If parent exit cannot be confirmed, the job fails with `process_exit_unconfirmed` instead of claiming cancellation completed. This same bounded shutdown contract applies to bundled sessions and personal CLI jobs. Windows uses the private owned-Job receipt described in [commands](commands.md); a wrapper exit without native proof does not confirm cleanup. It does not guarantee termination of escaped daemons or undo earlier file changes.

The signed native host also has `listPersonalAgents({expectedUserId})` and `openAgentLogin({expectedUserId,agent})`. These private operations require the currently verified shapes.inc account; native UI confirms opening sign-in. Discovery returns existing sanitized agent readiness, without executable paths, identities or credentials. Login opens the installed vendor CLI's `codex login` or `claude auth login` through a private, self-deleting Terminal command file. LaunchServices avoids requiring AppleEvents automation permission. `{opened:true}` means handoff only; a fresh readiness check establishes authentication. These are not remote HTTP/model capabilities. Personal accounts require a compatible installed vendor CLI and keep their existing billing/profile; they do not use the isolated funded runtime profile. Vendor OAuth completion remains user-operated.

## Reproducible distribution

`assets/codex/runtime.json` pins official arm64/x64 release assets and SHA-256 checksums. `node scripts/prepare-codex.js --out <cache>/codex-packages` downloads only at build time, verifies each archive, and preserves its complete app-server/code-mode/exec-server/ripgrep layout. No binary is copied from another installed application and startup never downloads executable code. The release signs all eight architecture-specific binaries and validates their architectures. Both packages retain upstream Apache-2.0 LICENSE/NOTICE plus Ratatui and ripgrep MIT notices.

JavaScript or harness packaging changes do not require a full Swift/Xcode build. Reuse the previously compiled launcher, controls, universal Node and cloudflared binaries with `scripts/assemble-mac-app.js --codex-packages <cache>/codex-packages`, sign the nested runtime binaries and helper, then embed and re-sign the native app. Native source changes still require the normal coordinated build. Bundling the harness does not install arbitrary language toolchains used by a project.

Sources: [official pinned release](https://github.com/openai/codex/releases/tag/rust-v0.166.0), [app-server protocol](https://learn.chatgpt.com/docs/app-server), [gateway configuration](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway), [Ratatui license](https://github.com/ratatui/ratatui/blob/ratatui-v0.30.2/LICENSE), [ripgrep license](https://github.com/BurntSushi/ripgrep/blob/15.2.0/LICENSE-MIT).

## Verification and limits

Focused real HTTP/child-process regressions cover immutable creation without inference; missing Bridge authorization; mismatched/expired grants; idempotent start and lost-receipt lookup; progress pagination; restart and same-thread follow-up; per-job token usage; pending-input cancellation and process cleanup; provider/runtime failure; and absent credentials in persisted receipts/logs. Existing interactive personal-agent and packaging tests also pass.

Funding-aware failure regressions send simulated 401/429 failures through actual HTTP jobs, verify durable failure receipts and identical retry recovery, and preserve personal-agent sign-in/plan advice. These simulated failures incur no provider charge and do not claim live payment verification.

The November 5 integration includes main's pre-task initialization recovery: at most one retry, only before a thread or turn is dispatched. The replacement starts only after the first parent process has a confirmed exit. A real-child signal-failure regression preserves the unconfirmed receipt and prevents overlap; cancellation still prevents retry. The integrated startup, RPC, session, failure and process-boundary checks passed 43/43 with simulated providers and zero inference spend.

Cancellation regressions also run real child processes that detach while retaining the parent's stdout. Bundled HTTP jobs and personal CLI jobs settle after the owned parent exits, terminal state survives reopening the HTTP server, unrelated processes stay alive, and each fixture explicitly cleans up its escaped child. A separate signal-failure fixture verifies the unconfirmed-exit result. Helper assembly checks that the shared shutdown module and both callers are included. These checks use no provider; complete connected UI replay on the changed signed candidate remains a separate acceptance gate.

An actual pinned 0.166.0 binary replay through the Bridge HTTP API and a simulated Responses provider executes three compositions: JavaScript writes/runs and persists `40`; HTML creation persists a checklist, then a resumed follow-up after Bridge HTTP restart appends another item in the same native thread; CSV analysis persists a total of `20`. It also verifies read-only patch refusal, duplicate start, wrong scope, missing authentication and cancellation while a provider request is pending. Model responses are scripted: this proves protocol, actual local tool execution and files, not model quality or live billing.

The authorized November 5 live acceptance subsequently verified a funded checklist follow-up through native build 104 (`fa43d64`), Bridge `52cab024`, frontend `b2282a189` and backend `dc9c67af2`. The official bundled runtime resumed the earlier writer's same native thread and completed at 09:14:20 UTC, with exit 0, three actual Astra gateway HTTP 200 responses, a closed lease with no pending usage, and both worker processes exited. The native UI and persisted assistant result confirmed completion. The 5,120-byte HTML artifact remained unchanged during that verification. The earlier writer had persisted the artifact before a backend membership-read outage incorrectly revoked its lease; that backend failure is distinct from the successful follow-up. The local receipt is `first-completed-funded-checklist-receipt.json`; screenshots and cross-repository evidence are tracked in [native PR #126](https://github.com/shapesinc/shapes-inc-native-apps/pull/126).

The later fresh CSV composition passed through native build 106 (`2b56f4c`), Bridge `292fc764`, frontend `9337127e6` and backend `8d8dcd37f`. The official bundled runtime completed with shapes.inc credits and exit 0 at 22:06:00 UTC. Actual View Reload followed by app Quit/reopen while the task was running retained the same job, session, native thread and worker processes; fresh account verification succeeded after reopen. All five input rows remained unchanged, and independent recomputation verified Food 19.75, Games 10.00, Travel 4.00 and a 33.75 grand total in the generated outputs. The final UI reply persisted, worker processes exited, and the lease closed without pending usage. Local receipts are `native106-csv-completed-verification.json`, `native106-csv-after-active-reload.json`, `native106-csv-after-active-reopen.json` and `qa-generic-csv-funded-costs-20261105.json`; [native PR #126](https://github.com/shapesinc/shapes-inc-native-apps/pull/126) links the actual screenshots. Earlier CSV attempts selected cloud tools or refused built-in execution before backend discovery/routing corrections; those failed attempts are not counted as native success.

The following plain cart-fix request on frontend `d22377b43` / backend `f441721fa` completed through the bundled runtime at 22:43:17 UTC. Actual View Reload retained the same active job/thread, the implementation was corrected, all four unchanged tests passed independently, and the workers exited. The earlier human-Stop run fenced inference before native cancel arrived: native recorded the real gateway403 failure, UI persisted Stopped, and the later cancel did not rewrite that terminal history. A new HTTP regression covers this late-cancel ordering and a completed-run control, including continued use of the same thread.

The later signed native108 Home task verified new-private-chat defaults and the [command primitives](commands.md): a plain request inherited the selected folder and credits, wrote its relative script there, and ran it in the foreground. Actual UI Stop cancelled the command, its process group exited, the delayed marker remained absent beyond its original deadline, and Stopped persisted after Reload. This closes the earlier direct-shell Stop failure; the failed original marker is retained as evidence.

**Remaining NO-GO scope:** a completed real repository replay on the final candidate and actual native109 transient-verification outage/recovery remain required. The successful earlier CSV/cart and lifecycle checks are not substitutes for that replay. Intel execution, personal CLI execution and user-operated Claude OAuth completion, direct `file://` opening/storage, and remaining permission/funding failure paths are unverified. No production rollout is claimed.

Replay with `SHAPES_BUNDLED_CODEX_BINARY=<pinned-app-server> node scripts/replay-bundled-sessions.js`. To exercise a signed helper's exact JavaScript and default runtime discovery, set `SHAPES_BRIDGE_SOURCE=<helper>/Contents/Resources/runtime` instead. `SHAPES_CANARY_REPORT=<file>` optionally writes fixture receipts; it never invokes a real provider. Cleanup waits for owned jobs before removing the fixture workspace.

## Incremental operating cost

Discovery, session creation/read/events and the Node regression/replay fixtures add **$0/day provider cost**. The original implementation evaluation used only simulated providers and cost **$0**. Later authorized live acceptance incurred real inference spend: the completed checklist follow-up used **$0.3353295 provider spend / 0.670659 credits charged**, and the completed CSV turn used **$0.370749 provider spend / 0.741498 credits charged**; both settled with no pending usage. These are individual task-turn receipts, not total evaluation spend; outer orchestration and earlier partial/failed attempts are separate. They are also not recurring daily projections. Adoption and token distributions remain unknown, so the pre-implementation operating-cost projection below uses explicit scenarios, not historical all-product traffic.

The cancellation settlement fix adds no AI, classifier or tool calls and has **$0/day normal-path cost delta**. The exceptional `process_exit_unconfirmed` receipt may enter existing model continuations. With unknown failure frequency, a conservative scenario of up to 100 additional input tokens per later call, read five times at $10/million input tokens, costs **$0.005 per affected failure**, or **$0.005–$0.50/day at 1–100 failures/day**, assuming no caching. A half/double price or history allowance gives $0.0025–$1/day across that scenario range. This is incremental provider spend, separate from user credits and the overall task-cost projection below.

The funding-aware recovery advice replaces existing text with shorter guidance; it adds no calls or context fields. Its incremental operating-cost increase is **$0/day**, including later receipt history. Its HTTP regression fixtures and simulated-provider replay also cost $0.

At the backend's current configured GPT-6 Astra policy, use $10/$50 per million input/output tokens (prices checked November 2, 2026), **200,000 input + 20,000 output tokens across all task calls**, then 20% retry overhead. The allowance includes orchestration, repeated history, tool continuations, compaction and any auxiliary calls; this implementation adds no classifier or summarizer. With no cache discount, the projection is **$3.60/task: $360/day at 100 tasks, $3,600/day at 1,000, $36,000/day at 10,000**. Half/double workload gives **$1,800–$7,200/day at 1,000 tasks**. No paid hosted tools, embeddings or infrastructure fees are included; enabling those needs a separate measured addition. Provider spend is distinct from user credits/revenue. [Pricing source](https://developers.openai.com/api/docs/pricing).

### Early compaction and request envelopes, November 6

The runtime compacts early at 32,000 tokens. This is calibrated to the billed
gateway's **262,144-byte serialized request limit**, not Astra's advertised
1,050,000-token context. The gateway retains its 16,384-output-token and $8
per-request policy limits. A request over the byte limit still receives the
Responses SSE `context_length_exceeded` error before any provider reservation.
The pinned runtime reports that error as terminal; it does not automatically
compact or replay the failed turn. Token-to-byte ratios vary,
so the early token threshold never overrides that authoritative byte check.

The prior 24,000-token threshold left only 4,568 tokens above a measured
19,432-token repository/runtime baseline. Five ordinary inspections triggered
three approximately 39-second compactions, consuming 79,150 input tokens
(65,903 cached) and 5,853 output tokens. The task was later cancelled by a local
verification outage and did not complete; this is diagnosis, not a successful
coding replay or a savings claim.

Before committing the change, the gross incremental retained-history cost was
projected with explicit scenarios: up to 8,000 extra input tokens on 5–20
continuations, 20% retry overhead, $10/million fresh input and $1/million cached
input, with 0–75% cache coverage. That is **$0.156–1.92/task**, or
**+$15.60–192/day at 100 tasks, +$156–1,920/day at 1,000 tasks, and
+$1,560–19,200/day at 10,000 tasks**. Adoption is unknown. These are gross input
increases; fewer compactions may offset them, but no net savings are assumed.
There is no new classifier or mandatory inference call, and task history remains
inside the existing session. Actual output, orchestration, compaction and retry
changes still require measured end-to-end comparison. Personal-provider usage
and user credits are separate from these provider-spend scenarios.

No-inference gateway fixtures with 32k tokens plus a 26,000-character tool result
serialize to 198,240 bytes (repository ASCII), 227,468 bytes (UTF-8 CSV), and
196,833 bytes (HTML), all below the unchanged byte/reservation limits. A larger
low-token-density output is rejected. The pinned-runtime replay injects that
exact SSE rejection and verifies one terminal failure without a hidden provider
retry or new job. Ordinary proactive compaction remains supported. The gateway's
separate ASGI tests verify that a smaller follow-up can use the same lease; that
does not establish automatic native recovery. This is simulated transport, not live
provider/payment verification. Actual coding acceptance on the new package
remains required.


## Integrated Windows input cost and acceptance

The 0.2.11 integration preserves original input, exact-image idempotency and the
per-thread acknowledged context ledger on both desktop hosts. It retains Windows
Job ownership, cancellation receipts, finite revocation writer and default-off
connected-tool admission. Same-SHA packaging and capability equality are separate
checks; both actual runtime and installed/backend acceptance remain necessary.

The Windows transport adds no model calls or context at unchanged task packets:
**+$0/day platform-specific overhead**. The inherited original-input behavior is
not free. Before implementation, the integration disclosed upstream backend
`76678ee29f4376a1a503bc8a811855637dac83c6`'s [COMPUTER_BRIDGE cost scenarios](https://github.com/shapesinc/app/blob/76678ee29f4376a1a503bc8a811855637dac83c6/architecture/COMPUTER_BRIDGE.md).
Traffic, adoption and actual cache mix are unknown; these are scenarios, not
measured daily spend or ceilings. Assumed November 6 Astra prices are $10/M fresh
input, $1/M cache reads, $12.50/M cache writes, $50/M output; above 272k context,
base input/output is $20/$75.

Original screenshot example: 200 header+2,000 original text+900 image+151 local
view_image description tokens = 3,251 additional input tokens, retained across 10
requests and 20% retries. At 0–75% cached reads, increase is **$12.68–39.01/day
per 100 affected existing tasks**, or **$126.79–390.12/day per 1,000**. Five–20
history reads expands to $6.34–78.02/day per 100. Context-key dedup avoids adding
duplicate source; later history still consumes input. The 151-token description
is an estimator proxy; using its 655-byte conservative token bound gives $45.06/day
per 100 uncached tasks. All fresh cache writes raise the base to $48.77/day per 100;
long-context rates may double input spend. Another 900-token image retained for
five requests adds $5.40/day per 100, including retries. The description also
applies to image-free funded generations and is already counted above.

Actual gateway image reservation uses reviewed 309/3,001/36,001-token bounds for
low/high/absent-auto detail. These are admission bounds, not actual small-image
cost. Four images over retained history, 256KiB request envelope, model/image
policy, current grants and spending ceilings remain authoritative. No saving
from fewer failures or compactions is assumed.

Upstream backend schema exposure separately adds approximately 13 outer tokens:
100k daily generations plus 20% retries/no cache adds $3.12/day on Sonnet 5 ($2/$10)
or $6.24/day on Opus 5.5 ($4/$20); at 1 million, $31.20/$62.40. This is an inherited
backend change, not another Windows-adapter delta. Conditional workspace-mode
repair at 20k input/150 output on Opus 5.5 plus 20% retries is $0.0996 each, or
$1.00/$9.96/$99.60 per day for 10/100/1,000 repairs. Count only work not already
inside a full-task allowance. No classifier, summarizer, embedding or polling
generation is added.

Optional tool use remains **$0/day while its flag is off**. If independently
enabled, the documented 2,000 retained tokens × 10 reads plus two 20k-input/500-output
continuations with 20% retries/no cache adds $78/day per 100 tool tasks; 16k retained
tokens makes it $246/day. Original context plus enabled tools for the same 100
tasks is $90.68–117.01/day under those assumptions. Newly successful Windows
workloads require the complete ordinary task allowance: 200k input/20k output
across orchestration/history/continuations plus 20% retries gives $3.60/task,
$360/$3,600/$36,000 per day at 100/1,000/10,000. Half/double workload gives
$1,800–7,200/day at 1,000. Do not add included context costs twice; add only
uncovered global exposures/repair work. Existing 32k compaction is already in
the Windows baseline, not another integration delta. Provider spend is separate
from credits/revenue. No new paid nested service or live paid evaluation is
proposed; runtime replay uses simulated providers.
