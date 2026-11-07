# Personal ChatGPT and Claude accounts

Personal funding stays separate from shapes.inc credits. Compatible installed
Codex/Claude CLIs retain their existing discovery, official sign-in and execution
paths. When no compatible external Codex CLI is present, the packaged official
Codex 0.166.0 app-server supplies the personal ChatGPT path. It asks the vendor to
read the standard personal Codex profile; Bridge never reads or copies provider
credentials. The credits runtime continues using its separate runtime-home and
bound gateway grant.

The private signed-native account surface composes these operations:

- `listPersonalAgents({expectedUserId})` reads bounded vendor account status and
  returns only readiness. It sends no prompt and creates no task.
- `openAgentLogin({expectedUserId,agent})` requires the existing native human
  confirmation. Bundled ChatGPT starts the vendor's browser login and returns
  `{opened:true,cancellable:true}`. Installed CLI handoff returns
  `cancellable:false`; launching Terminal is not completed authentication.
- `cancelAgentLogin({expectedUserId,agent})` cancels only the helper-owned pending
  ChatGPT login ID and its auth process. No owned login returns `cancelled:false`.
  It never logs out an account, terminates an external Terminal session, or
  cancels an unrelated task.

These are private host operations, not HTTP/model tools. Expected account and
controller generation are checked across asynchronous discovery and browser
opening. Detach, account change, disposal and the bounded login deadline close
only the owned pending login. Browser URLs must come from the official runtime
and use an allowlisted HTTPS vendor host; URLs and tokens are not returned to the
page or persisted in Bridge receipts.

Task creation pins the discovered bundled executable and personal profile in
its private request. The existing app-server supervisor preserves read-only or
write scope, task cancellation and terminal receipts. It rechecks ChatGPT auth
before thread/turn creation; a signed-out or changed API-key profile fails before
inference. There is no automatic switch to shapes.inc credits, another provider,
or another personal profile after dispatch.

Tests compose discovery then read-only task execution with absent external CLI;
browser start then cancellation; and signed-out/account-change/timeout recovery.
They include actual child RPC and process-exit checks, with a simulated vendor
transport. An actual pinned-runtime account/read recognized the authorized
existing ChatGPT login without inference. Final packaged personal execution and
browser login/cancel remain separate live acceptance gates; OAuth completion is
user-operated and is not inferred from an opened browser. Windows account RPC
uses the same owned Job/cleanup receipt primitive as commands and agent tasks.
Its browser handoff passes the allowlisted URL as one literal PowerShell value;
macOS uses LaunchServices and Linux uses its standard URL opener. Browser
handoff never grants command/provider native authority.

This adds **$0/day mandatory AI-provider spend**: no classifier, prompt-context
or inference call is added by account discovery or login. At100/1,000/10,000
account checks per day the added inference cost remains$0. Personal tasks use
the explicitly selected provider account/plan; this does not make their usage
free or measure vendor subscription limits. Auth HTTP/CPU activity is not an AI
charge. The one-time authorized personal QA reserve is separate from recurring
company spend.

Official protocol reference: [pinned0.166 account schema](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server-protocol/src/protocol/v2/account.rs)
and [app-server account API](https://learn.chatgpt.com/docs/app-server).
