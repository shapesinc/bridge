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
