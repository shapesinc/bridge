# Screen, keyboard and mouse control

The `POST /computer` contract used by the signed desktop bundles. Moved from the README.

The signed desktop bundle exposes authenticated `POST /computer` when
`GET /capabilities` reports `features.computer_control`. The server accepts
`{scope, control}`; `scope` is a server-derived actor/chat/connection digest,
never a model-provided identity. `control.operation` is `observe`, `click`,
`move`, `drag`, `scroll`, `type` or `press_key` (see `src/computer.js`).
An observation returns a JPEG, image dimensions, available displays, foreground
app and a single-use `observation_id`, valid for 30 seconds. Each input consumes
that observation before dispatch. Input uses image-pixel coordinates translated
to the captured display's global bounds. A changed foreground app or display,
secure input, missing Accessibility/Screen Recording consent, expired image or
concurrent operation fails closed. A lost response must be recovered by observing,
never by replaying input. The receipt says `dispatched`, not that the task worked.

## App-scoped background control (macOS)

When `GET /capabilities` reports `features.computer_app_control`, the same
endpoint also works on one app's window without bringing it forward, so the
person can keep using the Mac:

- `apps` lists running apps (name, bundle id, frontmost, hidden) and their
  windows (`window_id`, title, on-screen). No observation is needed.
- `observe` with `app` (name or bundle id) and optional `window_id` captures
  that window alone with ScreenCaptureKit, even when other windows cover it.
  An app that is not running is launched without activation. The reply adds
  the window's `elements`: actionable accessibility elements, each with an
  `index`, role, label/value and `frame` in window-image pixels. Electron apps
  are asked to expose their accessibility tree first. Chromium and Electron
  apps stop drawing a window that is completely covered; such a window is
  raised with the accessibility raise action before capture (`raised: true`).
  That places it just below the active app's front window without activating
  its app, so the person keeps keyboard focus.
- Inputs that use an app observation go to that app only: `click` with
  `element` (preferred) or `point` (accessibility press, focus or select
  first; otherwise events posted to that process), `set_text` (replace an
  element's text), `type`, `press_key`, `scroll` and `menu` (`path` of menu
  titles). Each input re-checks the window's identity and geometry, and an
  element's role and position, before acting; a change fails closed with
  `desktop_changed` or `stale_observation`. `move` and `drag` need the whole
  screen.

Observations stay single-use and scoped to the chat. Using one never voids
another chat's observation. Whole-screen operations still run one at a time
because they move the real pointer; app-scoped operations run in parallel.
Password fields are never filled. Windows reports `computer_app_control`
false for now and rejects app-scoped operations without dispatching.

The bundled `shapes.inc Bridge Computer` executable captures with ScreenCaptureKit
and posts CoreGraphics events; it checks consent in that process and never changes
the clipboard or prompts for permission from a remote action. Installation without
that signed native executable advertises the capability as unavailable. The
Windows bundle uses `shapes.inc Bridge Computer.exe` with desktop capture and
Windows input APIs. It validates the foreground window, display geometry,
interactive desktop and protected-input state before dispatch. See
[Windows computer control](../scripts/windows/COMPUTER_CONTROL.md) for platform
semantics and required signed-candidate acceptance. Existing
shell/file actions retain their contracts. Screenshots and typed text are not logged.
