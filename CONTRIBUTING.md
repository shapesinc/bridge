# Contributing to shapes.inc Bridge

Thanks for helping. Bridge is open source, and shapes.inc also ships it inside
its Mac and Windows apps, so every fix here reaches people using the apps too.

## What we'd love help with

- **Linux.** Screen, keyboard and mouse control currently exists only on macOS
  and Windows (`src/computer.js`). X11 and Wayland support, plus testing on
  different distros and desktops, is the biggest open area.
- **Bug reports from real machines.** Unusual shells, corporate proxies,
  non-English Windows, older macOS versions. A report with the full output
  is often enough for us to fix it.
- **Security review.** Token handling, the tunnel, the permission flows, and
  anything that could let a chat do more than its owner allowed. Please report
  vulnerabilities privately (see [SECURITY.md](SECURITY.md)).
- **Docs and install fixes** for edge cases you hit.

The shapes.inc account and pairing protocol, credits and funding, and backend
behavior are maintained by the shapes.inc team. Open an issue before working on
changes in those areas so we can agree on the approach first.

## Getting started

You need Node.js 18 or newer. There are no dependencies to install.

```bash
git clone https://github.com/shapesinc/bridge
cd bridge
node bin/cli.js --help
npm test
```

To try a change against a local pairing service without touching a real
install, use an isolated state directory:

```bash
node bin/cli.js install --api-url http://127.0.0.1:8098 --state-dir /absolute/private/test-directory --no-open
```

Only one background Bridge service can be installed per OS user, so stop any
existing test install first.

## Pull requests

- Keep each PR to one change and explain what it fixes and how you checked it.
- Add or update tests in `test/`. CI runs `npm test` and `npm pack --dry-run`
  on Node 18 and 22, plus Windows runtime tests.
- Don't weaken a safety check: chat permissions, the token, single-use
  observations, cancellation and the "never replay a command" rules exist to
  protect the person whose computer this is.
- Use synthetic data in tests and docs. Never include real tokens, account
  details or anything copied from someone's machine.
- By contributing you agree that your contribution is licensed under the
  [MIT license](LICENSE).

AI coding agents should also follow [AGENTS.md](AGENTS.md).
