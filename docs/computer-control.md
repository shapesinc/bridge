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
another chat's observation. App-scoped operations run in parallel. Password
fields are never filled. Windows reports `computer_app_control` false for now
and rejects app-scoped operations without dispatching.

## The person's pointer and keyboard stay theirs (macOS)

On macOS, nothing moves the person's pointer or types into whatever they have
in front:

- A whole-screen `observe` is **look-only**: its reply has `input: "look_only"`,
  and any input that uses it returns `background_target_required` without
  reaching the helper. To act, observe the app. Every macOS reply carries
  `delivery: "background"`, so a server can tell this contract from an older
  Bridge that still posts whole-screen input. (`move` and `drag` therefore have
  no macOS path.)
- **Keys** go to the window the app has focused. Before `type` or `press_key`,
  the observed window is made the app's main window through Accessibility, as a
  real click would; the app stays inactive. If that does not take,
  `target_not_focused` is returned instead of typing into another window. A
  `click` makes its window main the same way.
- A `click` at a `point` in a text field or view also **places the caret
  there**. Inactive apps ignore the mouse events that would otherwise do it.
- **Mouse events** posted to the app's process carry its pid and window. From
  macOS 27 they also carry the window-local point, because WindowServer no
  longer derives it and drops the click otherwise.
- **Typing** that falls back to key events sends line breaks and tabs as real
  Return/Tab presses: an app drops a whole Unicode event that contains one.
- **Menu shortcuts.** An app in the background turns off its menu commands for
  the document and selection (Save, Select All, Copy, Paste, Undo...) and keeps
  app commands on (New, Hide). A shortcut for a turned-off command does nothing,
  so before posting a chord with modifiers the helper looks it up in the app's
  menus (within 0.5 s):
  - If its item is turned off (and brief activation, below, doesn't apply),
    nothing is sent: `shortcut_unavailable`, naming
    the item, e.g. "CMD+S is TextEdit's File › Save, which is turned off while
    TextEdit is in the background".
  - If it's an Apple menu command (log out, lock, force quit), `system_command`.
  - Otherwise it's sent, and the receipt's `shortcut` names the menu item.

  `menu` refuses a turned-off item (`menu_unavailable`) and the Apple menu
  (`system_command`) the same way, instead of reporting a press that did
  nothing. Apps that keep their items on in the background (Electron apps do)
  are unaffected.
- **Brief activation.** No Accessibility press or posted key runs a turned-off
  command: the app has no key or main window while it is inactive. When the
  server sends the header `x-shapes-computer-activation: brief` (older Bridges
  ignore it; leaving it out is the kill switch), a `press_key` chord or `menu`
  item that is turned off only because the app is in the background is run
  instead:
  - only if the person hasn't pressed a key for 1 s, holds no modifier or mouse
    button and isn't entering a password; otherwise `person_active`, nothing sent;
  - only if the observed window is on the person's current desktop (activating
    an app on another Space can switch to it); otherwise `activation_failed`;
  - the observed window is made the app's main window, the app is made active
    without raising any window (SkyLight's private
    `_SLPSSetFrontProcessWithOptions`, no-windows mode), the menu item is
    pressed, and the person's front app is put straight back;
  - the reply has `delivery: "brief_activation"` and
    `activation: {ms, restored}`: how long the app was active, until the
    person's app was confirmed in front again, and whether it was;
  - for Save (CMD+S), `document_saved` says whether the document's file was
    written within 1.5 s.

  Typing, clicks and anything that already works in the background never use it,
  and the pointer is never moved. If the private calls are missing (a future
  macOS), the command is refused as before.
- **Moving in text.** For an arrow, HOME, END, PAGEUP or PAGEDOWN chord that no
  menu owns, sent while a text field or view has focus, the `press_key` receipt
  has `focused_text`: `changed` if its caret, selection or length changed within
  0.3 s, else `unchanged`. A chord a Mac text view has no
  binding for arrives and does nothing: on a Mac, CMD+UP/CMD+DOWN go to the
  start/end of a document and CMD+LEFT/CMD+RIGHT to the start/end of a line;
  HOME, END, PAGEUP and PAGEDOWN only scroll. `unchanged` is not proof that a
  key was dropped: observe before repeating it.

**The shape's pointer.** A server may send `cursor: {label}` with an app
`observe`: up to 40 characters, display-only, and it grants nothing. Inputs
from that observation are then shown by the agent's own pointer, labelled with
that name:

- It glides to the element or point before the input and pulses when the input
  lands (keys, text and menus pulse in place).
- The same signed executable draws it when started with `--cursor`. It is a
  separate accessory process with a click-through, non-activating panel at the
  assistive-technology window level, and it creates no app object in the
  short-lived helper.
- The runtime starts it on demand and feeds it one JSON line per input. It
  hides after 20 seconds and exits after a minute idle or when the runtime exits.
- It is kept out of whole-screen captures.

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
