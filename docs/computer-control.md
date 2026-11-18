# Screen, keyboard and mouse control

The `POST /computer` contract used by the signed desktop bundles. Moved from the README.

The signed desktop bundle exposes authenticated `POST /computer` when
`GET /capabilities` reports `features.computer_control`. The server accepts
`{scope, control, delivery?, cursor?}`. `scope` is a server-derived
actor/chat/connection digest, never a model-provided identity. `control.operation`
is `windows`, `observe`, `click`, `move`, `drag`, `scroll`, `type` or `press_key`
(see `src/computer.js`). `delivery: "background"` is the server's requirement
that input never uses the person's own pointer or keyboard; `cursor.label` (up to
40 characters) names the agent on its on-screen pointer. Neither grants access.
Older Bridges reject these fields, so a server that sends them fails closed.

## macOS: background control

On macOS every input is delivered in the background, and `features.computer_background_input`
is true. The person's pointer, keyboard focus and front app stay theirs while an
agent works, and every reply carries `delivery: "background"`.

The primitives compose:

- **`windows`** lists apps with on-screen windows: `name`, `bundle_id`, `pid`,
  `frontmost` and up to 8 windows (`window_id`, `title`, global `bounds`). No pixels
  and no observation.
- **`observe`** with `app` (a bundle id or app name) captures only that app's
  on-screen windows, including its own menus, sheets and popovers, cropped to
  their bounds. Other apps never cover it in the image. With `window_id` it
  captures that one window, even when it is covered. The receipt adds `target`
  (`kind`, `pid`, `bundle_id`, `name`, and `window_id`/`title` for a window),
  `windows` and `input: "background"`. Coordinates are target-image pixels.
- **`observe`** with no target (or `display_id`) captures a whole display and is
  **look-only** (`input: "look_only"`). Input from it returns
  `background_target_required` before anything is sent.
- **Input** (`click`, `move`, `drag`, `scroll`, `type`, `press_key`) uses a
  target observation's id once. It goes only to that app's process.

How each input is delivered:

| Operation | Delivery | Notes |
|---|---|---|
| `click` (left) on a text field or text view | Accessibility: focus the element inside the app and place the caret (`click_count: 2` selects the word) | Text views ignore mouse clicks into an inactive app. |
| `click` (left) on a button, link, checkbox or similar | Accessibility `AXPress` on the control, or on the button around a hit label or icon | A sent press is never repeated as mouse events, even if the app reports a timeout. |
| other clicks, right click, `move` | Mouse events posted to the app's process, routed to its window | Apps that read the hardware pointer (some games, Tk, Java, GL/Metal canvases) may ignore them. |
| `drag` within one text element | Accessibility text selection | |
| other `drag` | Mouse events posted to the app | Stays inside the app. Moving windows and dropping onto another app need the real pointer, so they aren't attempted. |
| `scroll` | Scroll-wheel event posted to the app's window | Chromium/Electron content may drop background wheel events. |
| `type`, `press_key` | Keyboard events posted to the app's process | They reach the app's focused element (click the field first). Text never touches the clipboard. |

Mouse events posted to a process carry its pid and window number. From macOS 27
they also carry a window-local point, because WindowServer no longer derives it.
The receipt's `via` is `accessibility` or `events`; `pointer` is the global point
used. If the app brought itself forward anyway, the receipt has
`frontmost_changed`. The helper never activates, unhides or raises an app, and
never opens one.

Before posting, the helper rechecks the target:

- The app is still running with the same bundle id.
- For a window target, the window is still open at the same size. It may have
  moved; points follow it.
- For an app target, the app has the same set of windows at the same frames.
- The point lands on that app's window.

Otherwise it returns `target_changed` or `outside_target`. Other typed blockers:

- `target_not_found`: the app isn't open.
- `target_not_focused`: keys for a window target would reach another window of the app; click a field in it first.
- `target_ambiguous`: more than one app matches.
- `target_not_visible`: hidden, minimized or on another Space.
- `secure_input`, `accessibility_denied`, `screen_recording_denied`,
  `session_unavailable`.

None of them falls back to global input.

**The agent's pointer.** The same signed executable started with `--cursor`
draws the agent's own pointer, with its name, in a click-through, non-activating
panel at the assistive-technology window level. The runtime starts it on demand
and feeds it one JSON line per action. Before a mouse action it glides to the
target point; it pulses on a click and on key input. It hides after 20 seconds
and exits after a minute idle or when the runtime exits. It is excluded from the
agent's own whole-display screenshots and is never a target.

## Shared rules

An observation returns a JPEG, image dimensions, available displays, the
foreground app and a single-use `observation_id`, valid for 30 seconds. Each
input consumes that observation before dispatch, and a newer capture for the same
scope replaces older ones. Missing consent, an expired image or a concurrent
operation fails closed. A lost response must be recovered by observing, never by
replaying input. The receipt says `dispatched`, not that the task worked.

The bundled `shapes.inc Bridge Computer` executable captures with ScreenCaptureKit
and acts with Accessibility and CoreGraphics events. It checks consent in that
process and never changes the clipboard or prompts for permission from a remote
action. Installation without that signed native executable advertises the
capability as unavailable.

## Windows

The Windows bundle uses `shapes.inc Bridge Computer.exe` with desktop capture
and Windows input APIs. It keeps its foreground-window contract: it validates the
foreground window, display geometry, interactive desktop and protected-input
state before dispatch. It refuses `windows`, app or window targets and
`delivery: "background"` with `background_unsupported`. See
[Windows computer control](../scripts/windows/COMPUTER_CONTROL.md) for platform
semantics and required signed-candidate acceptance.

Existing shell/file actions retain their contracts. Screenshots and typed text are not logged.
