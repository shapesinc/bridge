// One bounded stdin request from the authenticated Bridge service. No listener,
// elevation, clipboard access, shell command, or remote endpoint lives here.
// Build with the .NET Framework compiler; see build-computer.ps1.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal sealed class ControlFailure : Exception {
    internal readonly string Code;
    internal readonly bool Dispatched, Unknown;
    internal ControlFailure(string code, string message, bool dispatched = false, bool unknown = false) : base(message) {
        Code = code; Dispatched = dispatched; Unknown = unknown;
    }
}

internal static class Computer {
    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOVE = 0x0001, LEFT_DOWN = 0x0002, LEFT_UP = 0x0004, RIGHT_DOWN = 0x0008, RIGHT_UP = 0x0010;
    private const uint WHEEL = 0x0800, HWHEEL = 0x1000, NO_COALESCE = 0x2000, VIRTUAL_DESKTOP = 0x4000, ABSOLUTE = 0x8000;
    private const uint KEY_UP = 0x0002, UNICODE = 0x0004, EXTENDED = 0x0001;
    private static bool attemptedInput;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4100000, RecursionLimit = 16 };

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct CURSORINFO { public int cbSize, flags; public IntPtr cursor; public POINT position; }
    [StructLayout(LayoutKind.Sequential)] private struct ICONINFO { [MarshalAs(UnmanagedType.Bool)] public bool icon; public int xHotspot, yHotspot; public IntPtr mask, color; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MONITORINFO {
        public int size; public RECT monitor, work; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string device;
    }
    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref RECT bounds, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] internal struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct KEYBDINPUT { public ushort key, scan; public uint flags, time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Explicit)] internal struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
    [StructLayout(LayoutKind.Sequential)] internal struct INPUT { public uint type; public INPUTUNION data; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder name, int length, out int needed);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref CURSORINFO info);
    [DllImport("user32.dll")] private static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
    [DllImport("user32.dll")] private static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr value);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);

    private sealed class Foreground {
        internal int Pid;
        internal string Window, Started, Name;
    }
    private sealed class Display {
        internal uint Id;
        internal string Device;
        internal Rectangle Bounds;
        internal bool Primary;
    }

    private static ControlFailure Fail(string code, string message) { return new ControlFailure(code, message); }
    private static Dictionary<string, object> Map(params object[] pairs) {
        var value = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) value[(string)pairs[i]] = pairs[i + 1];
        return value;
    }
    private static object Value(Dictionary<string, object> input, string key) { object value; return input.TryGetValue(key, out value) ? value : null; }
    private static string Text(Dictionary<string, object> input, string key) { return Value(input, key) as string; }
    private static double Number(object value) {
        if (!(value is int || value is uint || value is long || value is decimal || value is double)) throw Fail("invalid_arguments", "Use finite numeric values.");
        double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(number) || Double.IsInfinity(number)) throw Fail("invalid_arguments", "Use finite numeric values.");
        return number;
    }
    private static int Integer(object value, int minimum, int maximum) {
        double number = Number(value);
        if (number != Math.Truncate(number) || number < minimum || number > maximum) throw Fail("invalid_arguments", "Numeric argument is outside its supported range.");
        return (int)number;
    }
    private static uint DisplayId(object value) {
        double number = Number(value);
        if (number != Math.Truncate(number) || number < 1 || number > UInt32.MaxValue) throw Fail("invalid_arguments", "Invalid display identifier.");
        return (uint)number;
    }
    private static object[] ArrayValue(object value) {
        var array = value as object[];
        if (array != null) return array;
        var list = value as ArrayList;
        if (list != null) return list.ToArray();
        throw Fail("invalid_arguments", "Use an array for this argument.");
    }
    private static Dictionary<string, object> Bounds(Rectangle rect) { return Map("x", rect.X, "y", rect.Y, "width", rect.Width, "height", rect.Height); }
    private static bool MatchesBounds(object value, Rectangle rect) {
        var bounds = value as Dictionary<string, object>;
        return bounds != null && Number(Value(bounds, "x")) == rect.X && Number(Value(bounds, "y")) == rect.Y &&
            Number(Value(bounds, "width")) == rect.Width && Number(Value(bounds, "height")) == rect.Height;
    }

    private static void ActiveDesktop() {
        if (!Environment.UserInteractive) throw Fail("session_unavailable", "Sign in and unlock this Windows desktop before computer control.");
        IntPtr buffer; int size;
        int session = Process.GetCurrentProcess().SessionId;
        // OpenInputDesktop alone also succeeds in disconnected sessions. Require
        // WTSActive explicitly; never attach to another session or desktop.
        if (session == 0 || !WTSQuerySessionInformation(IntPtr.Zero, session, 8, out buffer, out size))
            throw Fail("session_unavailable", "Use the active Windows session before computer control.");
        try { if (size < 4 || Marshal.ReadInt32(buffer) != 0) throw Fail("session_unavailable", "Reconnect and unlock this Windows desktop before computer control."); }
        finally { WTSFreeMemory(buffer); }
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS only.
        if (desktop == IntPtr.Zero) throw Fail("secure_input", "Windows is showing a protected desktop. Complete that interaction yourself.");
        try {
            var name = new StringBuilder(256); int needed;
            if (!GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed) || name.ToString() != "Default")
                throw Fail("secure_input", "Windows is showing a protected desktop. Complete that interaction yourself.");
        } finally { CloseDesktop(desktop); }
    }

    private static Foreground ActiveApp() {
        ActiveDesktop();
        IntPtr window = GetForegroundWindow(); uint pid;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out pid) == 0 || pid == 0 || pid > Int32.MaxValue)
            throw Fail("session_unavailable", "Open an app on the active Windows desktop before computer control.");
        try {
            using (Process process = Process.GetProcessById((int)pid)) {
                if (process.SessionId != Process.GetCurrentProcess().SessionId || process.HasExited)
                    throw Fail("session_unavailable", "The active app is unavailable. Observe again.");
                return new Foreground { Pid = (int)pid, Window = window.ToInt64().ToString(CultureInfo.InvariantCulture),
                    Started = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture), Name = process.ProcessName };
            }
        } catch (ControlFailure) { throw; }
        catch { throw Fail("session_unavailable", "The active app could not be inspected. Observe a normal app window again."); }
    }

    private static bool SameApp(Foreground a, Foreground b) { return a.Pid == b.Pid && a.Window == b.Window && a.Started == b.Started; }
    private static List<Display> Displays() {
        var result = new List<Display>();
        bool valid = true;
        MonitorCallback callback = delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data) {
            var info = new MONITORINFO { size = Marshal.SizeOf(typeof(MONITORINFO)) };
            if (!GetMonitorInfo(monitor, ref info)) { valid = false; return false; }
            // A display's device name is stable for this active topology; bounds
            // and the full device name are also bound to the observation.
            uint hash = 2166136261;
            foreach (char c in info.device) hash = unchecked((hash ^ c) * 16777619);
            if (hash == 0) hash = 1;
            if (result.Any(display => display.Id == hash)) { valid = false; return false; }
            Rectangle bounds = Rectangle.FromLTRB(info.monitor.Left, info.monitor.Top, info.monitor.Right, info.monitor.Bottom);
            if (bounds.Width > 0 && bounds.Height > 0) result.Add(new Display { Id = hash, Device = info.device, Bounds = bounds, Primary = (info.flags & 1) != 0 });
            return true;
        };
        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero) || !valid || result.Count == 0)
            throw Fail("display_unavailable", "The current displays could not be inspected. Reconnect the displays and retry.");
        return result;
    }
    private static Display SelectDisplay(List<Display> displays, object id) {
        Display result = id == null ? displays.FirstOrDefault(display => display.Primary) : displays.FirstOrDefault(display => display.Id == DisplayId(id));
        if (result == null) throw Fail("display_unavailable", "That display is unavailable. Observe an available display.");
        return result;
    }
    private static void CursorImage(Graphics graphics, Rectangle bounds) {
        var cursor = new CURSORINFO { cbSize = Marshal.SizeOf(typeof(CURSORINFO)) };
        if (!GetCursorInfo(ref cursor) || cursor.flags != 1) return;
        ICONINFO info;
        if (!GetIconInfo(cursor.cursor, out info)) return;
        try {
            IntPtr dc = graphics.GetHdc();
            try { DrawIconEx(dc, cursor.position.X - bounds.X - info.xHotspot, cursor.position.Y - bounds.Y - info.yHotspot, cursor.cursor, 0, 0, 0, IntPtr.Zero, 3); }
            finally { graphics.ReleaseHdc(dc); }
        } finally { if (info.mask != IntPtr.Zero) DeleteObject(info.mask); if (info.color != IntPtr.Zero) DeleteObject(info.color); }
    }

    private static Dictionary<string, object> Observe(Dictionary<string, object> request) {
        var app = ActiveApp();
        var displays = Displays(); var display = SelectDisplay(displays, Value(request, "display_id"));
        Rectangle bounds = display.Bounds;
        // Bound memory independently of the resized output. A 64MP capture uses
        // at most 256MB before scaling and releases both bitmaps before reply.
        if ((long)bounds.Width * bounds.Height > 64000000) throw Fail("capture_failed", "This display is too large to capture. Reduce its resolution and retry.");
        double scale = Math.Min(1.0, 1600.0 / Math.Max(bounds.Width, bounds.Height));
        int width = Math.Max(1, (int)Math.Round(bounds.Width * scale)), height = Math.Max(1, (int)Math.Round(bounds.Height * scale));
        byte[] image;
        using (var capture = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb))
        using (var graphics = Graphics.FromImage(capture)) {
            graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy | CopyPixelOperation.CaptureBlt);
            CursorImage(graphics, bounds);
            using (var scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (var target = Graphics.FromImage(scaled))
            using (var output = new MemoryStream())
            using (var parameters = new EncoderParameters(1)) {
                target.InterpolationMode = InterpolationMode.HighQualityBicubic;
                target.DrawImage(capture, new Rectangle(0, 0, width, height));
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
                scaled.Save(output, ImageCodecInfo.GetImageEncoders().First(codec => codec.MimeType == "image/jpeg"), parameters);
                if (output.Length > 3000000) throw Fail("capture_failed", "Could not produce a bounded screenshot.");
                image = output.ToArray();
            }
        }
        var after = SelectDisplay(Displays(), display.Id);
        if (!SameApp(app, ActiveApp()) || after.Bounds != bounds || after.Device != display.Device)
            throw Fail("desktop_changed", "The active app or display changed during capture. Observe again.");
        return Map("width", width, "height", height, "display_id", display.Id, "display_device", display.Device,
            "bounds", Bounds(bounds), "displays", displays.Select(item => Map("id", item.Id, "bounds", Bounds(item.Bounds))).ToArray(),
            "frontmost", Map("pid", app.Pid, "window_id", app.Window, "process_started", app.Started, "bundle_id", "", "name", app.Name),
            "scroll_delta_unit", "Windows wheel units (120 per detent)", "image_base64", Convert.ToBase64String(image), "image_content_type", "image/jpeg");
    }

    private static IntPtr Token(int pid) {
        IntPtr process = OpenProcess(0x1000, false, (uint)pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) throw Fail("accessibility_denied", "Windows will not allow input to this app. Use a normal, non-elevated app window.");
        try {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) throw Fail("accessibility_denied", "Windows will not allow input to this app.");
            return token;
        } finally { CloseHandle(process); }
    }
    private static SecurityIdentifier TokenSid(IntPtr token, int infoClass) {
        int size; GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out size);
        if (size < IntPtr.Size || size > 65536) throw Fail("accessibility_denied", "The app's Windows permissions could not be checked.");
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            if (!GetTokenInformation(token, infoClass, buffer, size, out size)) throw Fail("accessibility_denied", "The app's Windows permissions could not be checked.");
            return new SecurityIdentifier(Marshal.ReadIntPtr(buffer));
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    private static int Integrity(IntPtr token) {
        string sid = TokenSid(token, 25).Value; // TokenIntegrityLevel, SID_AND_ATTRIBUTES.
        return Int32.Parse(sid.Substring(sid.LastIndexOf('-') + 1), CultureInfo.InvariantCulture);
    }
    private static void InputAuthority(Foreground app) {
        IntPtr target = Token(app.Pid), own = IntPtr.Zero;
        try {
            own = Token(Process.GetCurrentProcess().Id);
            if (!TokenSid(target, 1).Equals(TokenSid(own, 1)) || Integrity(target) > Integrity(own) || Integrity(own) > 8192)
                throw Fail("accessibility_denied", "Computer input is limited to your normal, non-elevated Windows apps.");
        } finally { CloseHandle(target); if (own != IntPtr.Zero) CloseHandle(own); }
        // Do not alter physical key state or mix a generated chord with a key
        // the person is holding. Wait for another observation instead.
        foreach (int key in new int[] { 1, 2, 4, 5, 6, 16, 17, 18, 91, 92 })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) throw Fail("input_busy", "Release held keys and mouse buttons, then observe again before input.");
        try {
            var focused = AutomationElement.FocusedElement;
            if (focused == null) throw Fail("secure_input", "The focused control could not be inspected. Complete this interaction yourself.");
            if (focused.Current.IsPassword) throw Fail("secure_input", "Protected input is active. Complete this interaction yourself.");
        } catch (ControlFailure) { throw; }
        catch { throw Fail("secure_input", "The focused control could not be inspected. Complete this interaction yourself."); }
    }

    private static Point ImagePoint(Dictionary<string, object> request, string name, Rectangle bounds, int width, int height) {
        object[] point = ArrayValue(Value(request, name));
        if (point.Length != 2) throw Fail("invalid_arguments", "Use coordinates inside the observed image.");
        double x = Number(point[0]), y = Number(point[1]);
        if (x < 0 || y < 0 || x >= width || y >= height) throw Fail("invalid_arguments", "Use coordinates inside the observed image.");
        return new Point(bounds.X + (int)Math.Floor(x * bounds.Width / width), bounds.Y + (int)Math.Floor(y * bounds.Height / height));
    }
    internal static int AbsoluteCoordinate(int value, int origin, int size) {
        if (size < 1 || value < origin || value >= (long)origin + size) throw Fail("invalid_arguments", "Input coordinates are outside the desktop.");
        // Map to the center of the physical pixel, including negative monitor
        // origins. MOUSEEVENTF_VIRTUALDESK supplies the full multi-monitor space.
        return Math.Min(65535, (int)Math.Floor(((double)value - origin + 0.5) * 65536.0 / size));
    }
    private static INPUT Mouse(Point point, Rectangle desktop, uint flags, int delta = 0) {
        return new INPUT { type = INPUT_MOUSE, data = new INPUTUNION { mouse = new MOUSEINPUT {
            dx = AbsoluteCoordinate(point.X, desktop.X, desktop.Width), dy = AbsoluteCoordinate(point.Y, desktop.Y, desktop.Height),
            mouseData = unchecked((uint)delta), flags = flags | ABSOLUTE | VIRTUAL_DESKTOP, extraInfo = UIntPtr.Zero } } };
    }
    private static INPUT Key(ushort key, bool down, bool unicode = false) {
        bool extended = key == 91 || (key >= 33 && key <= 40) || key == 46;
        return new INPUT { type = INPUT_KEYBOARD, data = new INPUTUNION { keyboard = new KEYBDINPUT {
            key = unicode ? (ushort)0 : key, scan = unicode ? key : (ushort)0,
            flags = (down ? 0u : KEY_UP) | (unicode ? UNICODE : extended ? EXTENDED : 0u), extraInfo = UIntPtr.Zero } } };
    }
    private static ushort KeyCode(string name, bool modifier = false) {
        if (modifier) {
            switch (name) { case "CMD": return 91; case "CTRL": return 17; case "ALT": return 18; case "SHIFT": return 16; }
        } else {
            if (name != null && name.Length == 1 && ((name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= '0' && name[0] <= '9'))) return name[0];
            int function;
            if (name != null && name.StartsWith("F") && Int32.TryParse(name.Substring(1), out function) && function >= 1 && function <= 12) return (ushort)(111 + function);
            switch (name) {
                case "RETURN": return 13; case "TAB": return 9; case "SPACE": return 32; case "BACKSPACE": return 8;
                case "ESCAPE": return 27; case "HOME": return 36; case "PAGEUP": return 33; case "DELETE": return 46;
                case "END": return 35; case "PAGEDOWN": return 34; case "LEFT": return 37; case "RIGHT": return 39; case "DOWN": return 40; case "UP": return 38;
            }
        }
        throw Fail("invalid_arguments", "Use modifiers CMD/CTRL/ALT/SHIFT followed by one supported key.");
    }

    internal static List<INPUT> BuildInput(Dictionary<string, object> request, Rectangle bounds, Rectangle desktop, int width, int height) {
        var events = new List<INPUT>(); string operation = Text(request, "operation");
        if (operation == "click" || operation == "move" || operation == "drag" || operation == "scroll") {
            Point point = ImagePoint(request, "point", bounds, width, height);
            events.Add(Mouse(point, desktop, MOVE | NO_COALESCE));
            if (operation == "click") {
                string button = Text(request, "button") ?? "left";
                if (button != "left" && button != "right") throw Fail("invalid_arguments", "Use the left or right mouse button.");
                int count = Value(request, "click_count") == null ? 1 : Integer(Value(request, "click_count"), 1, 2);
                for (int i = 0; i < count; i++) { events.Add(Mouse(point, desktop, button == "right" ? RIGHT_DOWN : LEFT_DOWN)); events.Add(Mouse(point, desktop, button == "right" ? RIGHT_UP : LEFT_UP)); }
            } else if (operation == "drag") {
                Point end = ImagePoint(request, "to", bounds, width, height);
                events.Add(Mouse(point, desktop, LEFT_DOWN));
                for (int i = 1; i <= 20; i++) events.Add(Mouse(new Point(point.X + (end.X - point.X) * i / 20, point.Y + (end.Y - point.Y) * i / 20), desktop, MOVE | NO_COALESCE));
                events.Add(Mouse(end, desktop, LEFT_UP));
            } else if (operation == "scroll") {
                int dx = Integer(Value(request, "dx"), -2000, 2000), dy = Integer(Value(request, "dy"), -2000, 2000);
                if (dy != 0) events.Add(Mouse(point, desktop, WHEEL, dy));
                if (dx != 0) events.Add(Mouse(point, desktop, HWHEEL, dx));
            }
        } else if (operation == "type") {
            string text = Text(request, "text");
            if (String.IsNullOrEmpty(text) || text.Length > 4096) throw Fail("invalid_arguments", "Supply at most 4096 UTF-16 units of text.");
            // Validate all UTF-16 before dispatch. Surrogate pairs remain adjacent
            // within the single SendInput batch; the clipboard is never changed.
            for (int i = 0; i < text.Length; i++) {
                if (Char.IsHighSurrogate(text[i])) { if (++i >= text.Length || !Char.IsLowSurrogate(text[i])) throw Fail("invalid_arguments", "Text must contain valid Unicode."); }
                else if (Char.IsLowSurrogate(text[i])) throw Fail("invalid_arguments", "Text must contain valid Unicode.");
            }
            foreach (char character in text) { events.Add(Key(character, true, true)); events.Add(Key(character, false, true)); }
        } else if (operation == "press_key") {
            object[] values = ArrayValue(Value(request, "keys"));
            if (values.Length < 1 || values.Length > 5 || values.Any(value => !(value is string)) || values.Distinct().Count() != values.Length)
                throw Fail("invalid_arguments", "Use a unique modifier chord followed by one supported key.");
            var keys = values.Cast<string>().ToArray();
            for (int i = 0; i < keys.Length - 1; i++) events.Add(Key(KeyCode(keys[i], true), true));
            ushort final = KeyCode(keys[keys.Length - 1]);
            events.Add(Key(final, true)); events.Add(Key(final, false));
            for (int i = keys.Length - 2; i >= 0; i--) events.Add(Key(KeyCode(keys[i], true), false));
        } else throw Fail("invalid_arguments", "Unsupported computer operation.");
        return events;
    }

    private static Dictionary<string, object> Input(Dictionary<string, object> request) {
        var expected = Value(request, "expected") as Dictionary<string, object>;
        var app = ActiveApp();
        if (expected == null || Number(Value(expected, "pid")) != app.Pid || Text(expected, "window_id") != app.Window || Text(expected, "process_started") != app.Started)
            throw Fail("desktop_changed", "The observed app changed. Observe again before input.");
        var display = SelectDisplay(Displays(), Value(expected, "display_id"));
        if (Text(expected, "display_device") != display.Device || !MatchesBounds(Value(expected, "bounds"), display.Bounds))
            throw Fail("desktop_changed", "The observed display changed. Observe again before input.");
        int width = Integer(Value(expected, "width"), 1, 1600), height = Integer(Value(expected, "height"), 1, 1600);
        Rectangle desktop = SystemInformation.VirtualScreen;
        var events = BuildInput(request, display.Bounds, desktop, width, height);
        InputAuthority(app);
        // UI Automation calls can block while focus/topology changes. Recheck
        // immediately before the one atomic insertion into the input stream.
        var latestDisplay = SelectDisplay(Displays(), display.Id);
        if (!SameApp(app, ActiveApp()) || latestDisplay.Bounds != display.Bounds || latestDisplay.Device != display.Device || SystemInformation.VirtualScreen != desktop)
            throw Fail("desktop_changed", "The observed app or display changed. Observe again before input.");
        attemptedInput = true;
        uint inserted = SendInput((uint)events.Count, events.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        if (inserted != events.Count) throw new ControlFailure("input_blocked", "Windows did not accept all input. Observe its effect before continuing; do not repeat it.", inserted > 0, inserted > 0);
        Thread.Sleep(100);
        var result = Map("dispatched", true, "delivery_verified", false, "source_pid", Process.GetCurrentProcess().Id,
            "message", "Events were posted. Observe again to verify the result; this receipt alone does not prove the intended effect.");
        if (Text(request, "operation") == "scroll") result["scroll_delta_unit"] = "Windows wheel units (120 per detent)";
        return result;
    }

    private static void ValidateFields(Dictionary<string, object> request) {
        string operation = Text(request, "operation");
        string fields;
        switch (operation) {
            case "observe": fields = "operation display_id"; break;
            case "click": fields = "operation expected point button click_count"; break;
            case "move": fields = "operation expected point"; break;
            case "drag": fields = "operation expected point to"; break;
            case "scroll": fields = "operation expected point dx dy"; break;
            case "type": fields = "operation expected text"; break;
            case "press_key": fields = "operation expected keys"; break;
            default: throw Fail("invalid_arguments", "Unsupported computer operation.");
        }
        var allowed = new HashSet<string>(fields.Split(' '));
        if (request.Keys.Any(key => !allowed.Contains(key))) throw Fail("invalid_arguments", "Unsupported computer arguments.");
    }

    [STAThread] public static int Main(string[] args) {
        Dictionary<string, object> reply;
        try {
            if (args.Length != 0) throw Fail("invalid_arguments", "This helper accepts one JSON request on standard input.");
            // PMv2 is available on supported Windows 10/11 builds. Never silently
            // mix logical screenshot coordinates with physical SendInput units.
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) throw Fail("unsupported", "Computer control requires Windows 10 version 1703 or newer.");
            var bytes = new byte[32769]; int count = 0;
            using (Stream input = Console.OpenStandardInput()) {
                while (count < bytes.Length) { int read = input.Read(bytes, count, bytes.Length - count); if (read == 0) break; count += read; }
            }
            if (count == 0 || count > 32768) throw Fail("invalid_arguments", "Invalid computer request.");
            var request = Json.DeserializeObject(new UTF8Encoding(false, true).GetString(bytes, 0, count)) as Dictionary<string, object>;
            if (request == null) throw Fail("invalid_arguments", "Invalid computer request.");
            ValidateFields(request);
            reply = Map("success", true, "result", Text(request, "operation") == "observe" ? Observe(request) : Input(request));
        } catch (ControlFailure error) {
            reply = Map("success", false, "error_type", error.Code, "error", error.Message, "dispatched", error.Dispatched, "outcome_unknown", error.Unknown);
        } catch {
            reply = Map("success", false, "error_type", "native_control_failed", "error", "Computer control failed. Observe again or check the active Windows desktop.", "outcome_unknown", attemptedInput);
            if (!attemptedInput) reply["dispatched"] = false;
        }
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine(Json.Serialize(reply));
        return 0;
    }
}
