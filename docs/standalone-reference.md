# Standalone install reference

Details for the terminal install. Moved from the README.

The installer reports **Connected** only after the background process has
contacted shapes.inc. You can close the terminal. Changing networks or restarting
the tunnel automatically updates the endpoint without changing your account
pairing or existing chat grants.

Install options: `--name <name>` names this computer, `--no-open` does not open
the browser for the approval link, `--no-awake` turns keep-awake off, and
`--no-permissions` skips the guided permission pass.

The installed code and a private Node runtime live inside the app bundle on
macOS (`~/Applications/shapes.inc Bridge.app`) and in `~/.shapes-bridge/runtime`
on Linux and Windows; the service never depends on an `npx` cache or an open
terminal. Run `update` (or `install` again) to update it without pairing again. Bare `npx --yes --package=https://github.com/shapesinc/bridge/archive/refs/heads/main.tar.gz shapes-bridge`
starts setup on a new computer and shows status on an existing installation.

Older instructions using `npx github:shapesinc/bridge` are also supported. The
package includes a `bridge` command alias so npm can choose the setup command
even though this package also contains the separate `shapes-codex` command.

## Security notes

There are no new inference calls for pairing, heartbeats, native permission
checks, or keep-awake: **$0/day added provider inference spend**. Existing task
and local-agent execution charges still depend on the work you request.

For temporary legacy URL/token connections, run `foreground`. This mode ends
when its terminal closes. Enter its secret only in the private connection
dialog, never a chat message.

## Development notes

For isolated development, `install --api-url http://127.0.0.1:8098 --state-dir
/absolute/private/test-directory --no-open` uses a local pairing service.
Remote API origins require HTTPS and redirects are rejected. Only one
background shapes.inc Bridge service may be installed per OS user; stop the
previous test installation before choosing a different state directory.

`npm test` runs Node's built-in test runner (`node --test`) over `test/`; there
are no dependencies to install. CI (`.github/workflows/ci.yml`) runs `npm test`
and `npm pack --dry-run` on Node 18 and 22 for every push to `main` and every
pull request. Design notes for the connection runtime and the app-owned
contract live in `docs/`. The tests cover the local CLI fixtures and
authenticated HTTP tests; they make no inference calls. A 2026-10-02 smoke test
also exercised a real temporary tunnel, the shapes.inc connection service (with
isolated test membership and storage), and the installed CLI: token checks and
cross-member rejection passed, discovery identified signed-in Codex and
signed-out Claude Code,
Claude was rejected before creating a job, and `auto` completed a Codex
read-only file task with the expected answer. Claude execution is covered by
structured fixtures; live Claude inference remains unverified while it is
signed out.
