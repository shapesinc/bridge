# Native capability transport

This is a default-off transport for the embedded runtime to discover and use capabilities authorized by shapes.inc. It does not import the person's Codex credentials or enable every Codex desktop capability. The backend must explicitly enable its feature flag and issue a separate, current tool-audience grant. Bridge advertises support only on macOS/Linux with an available bundled executable; Windows remains unsupported and receives no extra runtime configuration.

The release candidate is Bridge **0.2.10**, carrying the reviewed `4bb147fd658541761a10577134b7a491fd267348` runtime with a version-only package update. The separate 0.2.9 Windows parity candidate is not included. Release metadata preparation adds **$0/day**; the runtime costs and acceptance limitations below still apply. Candidate source, native publication, standalone publication and feature activation are separate steps under the [release sequence](../README.md#releasing-the-macos-app).

## Composable contracts

- `shapes_discover({query?, cursor?, limit?})` finds currently authorized capabilities. Discovery does not grant permission to act.
- `shapes_describe({capability_id})` returns the current exact schema and its revision.
- `shapes_call({capability_id, schema_revision, arguments})` requests one operation. Bridge injects a deterministic UUIDv5 operation ID derived from the granted run and actual native thread, turn and call IDs. Transport never retries a mutation automatically.
- `shapes_read_operation({operation_id})` reads an operation's durable outcome. Omitting the ID lists recent receipts in the current authorized session, with optional cursor and limit, so a lost process does not require repeating an action. A final page can have `next_cursor: null`.
- `shapes_cancel_operation({operation_id})` requests cancellation. It does not imply that an already delivered action was undone.

Each request uses `POST /bridge/native-tools/{discover,describe,call,read,cancel}` at the inference gateway's origin. Its common envelope carries session, scope, request and run IDs from the trusted grant, actual native thread/turn/call IDs, and action arguments. The separate bearer token is retained only in the supervisor environment. It is excluded from the runtime/MCP environment, persisted job request, model responses and ordinary logs. The backend owns fresh actor, room, source, device, connection, capability, consent and funding checks; a caller cannot select those authorities in model arguments.

Results are bounded JSON receipts with `success`, `result`, or an error. Call/read/cancel receipts identify the operation and one of `running`, `completed`, `failed`, `cancelled` or `outcome_unknown`. A timeout, malformed response or oversized response preserves an unknown receipt, never a success claim. Read/list can recover earlier runs in the same backend-authorized session. Backend turn closure must fence outstanding operations, including when Bridge cannot send cleanup because its process or grant has expired.

## Runtime boundary

Pinned Codex 0.166 restores dynamic app-server tools from the original thread and ignores attempted replacement at resume. Therefore this adapter uses stdio MCP instead. Actual runtime replay verifies that an existing native thread acquires tools when enabled and loses them when disabled, without forking its conversation.

The MCP subprocess receives only a private Unix socket path and non-secret run ID. A supervisor broker validates the native metadata and proxies requests. Its directory/socket permissions are 0700/0600. The frontend computes the same operation ID before dispatch and can return it when the broker disconnects. Recent-receipt listing handles complete supervisor/runtime loss before any receipt reaches native history. A supervisor-only SIGKILL replay verified that the app-server and its two descendants exit within two seconds. SIGKILL leaves an inert private broker directory; the fixture removes this owned directory explicitly. Normal shutdown removes it automatically.

Only the five named tools have explicit `approval_mode="approve"` overrides, with the same five-name `enabled_tools` allowlist on this isolated MCP server. Backend action-specific authorization remains required. Existing native approval/question handling, other MCP servers, global approval policy and sandbox are unchanged. Mutation tools are not falsely marked read-only. This MCP server is required to connect before a granted task starts.

Limits: 256-character discovery queries, 160-character capability IDs, 500-character cursors, 16 KiB JSON arguments, 32 KiB backend response, eight pending requests, 64 outstanding operations, four broker connections, 15-second HTTP deadline, and a two-second total best-effort cleanup deadline with at most four concurrent cancellations. The existing 256 KiB inference gateway envelope and funding controls remain unchanged. Only text receipts are supported in this slice; media and paid nested capability services need their own reviewed admission.

## Verification and cost

Actual Bridge HTTP, supervisor and pinned-runtime replay on macOS uses only loopback fake inference/capability services. It exercises browser and document compositions, receipt recovery, disabled/enabled resume, Stop, and SIGKILL after admission followed by same-thread receipt listing/read without mutation redispatch. Linux is allowed by the Unix transport gate; an actual pinned-runtime replay on Linux is not included in this evidence. Separate focused tests cover metadata forgery, extra tools, credential handling, result limits, cancellation, socket loss and unsupported-platform advertising. The captured provider packets are replayed through the real ASGI inference route and Redis reservation/settlement ledger with a fake provider and synthetic wallet.

These are simulations of provider and connected-service effects. They do not establish live browser/app permissions, provider payment, or complete product readiness. Integration with original-input/image changes and the affected UI still requires verification before rollout.

The actual deferred five-tool metadata is 2,869 UTF-8 bytes, approximately 604 tokens using the locally available `cl100k_base` estimator, not the billed Astra tokenizer. No new schemas or server instructions appeared directly in the initial provider prompt; metadata enters when the model discovers it and is then retained in later history. Conservatively retaining those 604 tokens for ten requests per task at 100 tasks/day, 20% retries, no caching and $10/M input tokens costs about $7.25/day. It is included in the broader illustrative 2,000-added-token scenario, not additional to it.

Traffic is unknown. At 100 tasks/day, 2,000 added tokens retained over ten requests plus two additional continuations of 20,000 input/500 output tokens, with 20% retries, no caching, $10/M input and $50/M output, the total illustrative increase is $78/day. Half/double that workload is $39–156/day; retaining 16,000 added context tokens makes the same 100-task scenario $246/day. No classifiers or embeddings are added here. Tool-provider fees and images are excluded because this slice does not admit them. Default-off production activation adds $0/day; local fake-provider evaluations incur no provider charges.

Run the focused Node tests and `scripts/replay-native-tools.js` with `SHAPES_BUNDLED_CODEX_BINARY`. Optional `SHAPES_NATIVE_TOOLS_REPORT` and `SHAPES_NATIVE_TOOLS_CAPTURE` write new private files with mode0600; captures contain runtime context and must never be committed. Backend packet replay uses `BRIDGE_CODEX_CAPTURE` and `tests/test_bridge_harness.py::test_opt_in_pinned_codex_capture_through_native_gateway`.
