# Windows observed computer input

`Computer.cs` implements the same bounded `observe`, `click`, `move`, `drag`,
`scroll`, `type` and `press_key` request primitives as the macOS helper.
`src/computer.js` remains the common authority for actor/chat-scoped observation
IDs, 30-second expiry, one-use input, concurrency and ambiguous-outcome handling.
Windows requires its packaged executable before advertising computer control.

The original composition is observe → click → observe. The same primitives also
support observe → Unicode text → observe and observe → keyboard chord → observe;
no workflow-specific command or new model call is introduced. Incremental
recurring AI spend is **$0/day**; screenshots remain the existing observation
context, with the same 1600-pixel longest edge and 3MB JPEG bounds. No new
classifier, retries or automatic observation loop is added.

## Native boundary

The helper reads one UTF-8 JSON object from stdin (at most 32KiB), emits one JSON
receipt, and exits. It never opens a network listener, launches a shell, reads or
changes the clipboard, requests elevation, switches desktops or attaches to
another Windows session. It is invoked only behind the existing authenticated
Bridge HTTP and computer-grant boundaries.

The active session must be interactive and `WTSActive`; the input desktop must
be the user's ordinary `Default` desktop. This matters because
[OpenInputDesktop can succeed for a disconnected session](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop).
Secure desktop/UAC/lock-screen interactions fail closed. A screenshot is tied to
the foreground PID, window handle, process start time, display device and bounds.
The native helper checks these before returning pixels and again before input;
the common controller persists the bindings privately with the observation ID.
The caller cannot supply or replace them through the public control request.

Input additionally checks the foreground process's user and integrity level,
refuses an elevated helper or elevated target, refuses held keys/buttons, and
checks the focused UI Automation element's
[IsPassword property](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.automationelementinformation.ispassword).
Unsupported or inaccessible protected-input inspection is a refusal, not an
assumed grant. This is a check of the application's UI Automation declaration;
it is not a claim that arbitrary custom controls always describe themselves
accurately. macOS TCC-specific permissions remain `unsupported` on Windows.

The process is DPI-aware and enumerates physical monitor geometry afresh.
Screenshots include cursor position and are resized to the shared image bounds.
Input maps image points back into the full physical virtual desktop, including
monitors with negative origins. Capture allocations are separately bounded at
64 million source pixels. A display or foreground change requires observation.

`SendInput` receives one prepared array so user input cannot interleave its
individual chord/drag events. Windows imposes
[UIPI integrity restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput);
the helper does not bypass them. Unicode is sent as adjacent UTF-16 packets,
and modifiers are released in the same array. A full insertion returns
`dispatched: true, delivery_verified: false`. A partial insertion is a failure
with `outcome_unknown: true`; the consumed observation cannot replay it.
Observe again to determine the actual effect.

Windows wheel input has native delta units, with 120 per detent, rather than
macOS pixel scroll units. Observations and scroll receipts state this through
`scroll_delta_unit`; exact pixel-distance scrolling is not claimed. `CMD` maps
to the Windows key, while `CTRL`, `ALT` and `SHIFT` retain their native meanings.

## Build and verification

Run `build-computer.ps1 -OutputPath <new-absolute-exe-path>` on Windows with the
.NET Framework 4.x x64 compiler. The source is C#5 compatible and references only
installed framework assemblies. Install `shapes.inc Bridge Computer.exe` beside
the bundled Node executable. The native-app release must sign this helper along
with the rest of the package; the build script does not sign or publish it.

Compile `ComputerFixture.cs` separately as an x64 executable with
`System.Drawing.dll`, `System.Windows.Forms.dll` and `System.Web.Extensions.dll`.
Set `SHAPES_TEST_COMPUTER_HELPER` and `SHAPES_TEST_COMPUTER_FIXTURE`, then run
`node --test test/windows-computer-native.test.js` in an active Windows desktop.
The test creates one owned WinForms window and temporary state directory, checks
actual JPEG pixels, typing/chords, mouse actions, wheel input, stale native
identities, one-use observations and password-field refusal, and terminates the
fixture before removing its temporary files. It does not interact with a real
user's windows intentionally and aborts if its fixture is not foreground.

At source base `460c7bd` plus this patch, the 10 portable controller/HTTP tests
pass on macOS. They verify shared actor scope, expiry, consumed receipts,
platform executable discovery and Windows identity binding with simulated
native replies. Both Windows-native tests skip explicitly on macOS.

**NO-GO until native compile and Windows runtime acceptance pass.** Additional
required acceptance includes multiple monitors and mixed DPI, actual locked and
disconnected desktops, protected/UAC/elevated targets, normal browser/native app
editing, background connection and packaged update behavior. A skipped Windows
test or successful portable test is not Windows acceptance evidence.
