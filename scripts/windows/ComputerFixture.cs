// Throwaway native UI for Windows computer-control acceptance. It reads/writes
// only the explicit temporary status path supplied by the owning test process.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class ComputerFixture : Form {
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    // One rename that replaces the destination: the name never goes missing.
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool MoveFileEx(string existing, string replacement, int flags);
    private const int MOVEFILE_REPLACE_EXISTING = 0x1;
    private readonly string statusPath;
    private readonly TextBox text = new TextBox { Multiline = true, Location = new Point(20, 20), Size = new Size(500, 100), Name = "Test input" };
    private readonly TextBox password = new TextBox { UseSystemPasswordChar = true, Location = new Point(20, 140), Size = new Size(200, 32), Name = "Protected test input" };
    private readonly Button button = new Button { Text = "Count", Location = new Point(20, 190), Size = new Size(130, 50) };
    private readonly InputArea area = new InputArea { Location = new Point(180, 190), Size = new Size(340, 180), BackColor = Color.LightBlue, TabStop = true };
    private int clicks, moves, wheels, drags, downs, ups, captureLost, saves, saveFailures, movesAtDown;
    private string lastSaveError = "";
    private bool dragging;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly Timer timer = new Timer { Interval = 80 };

    private sealed class InputArea : Control {
        internal InputArea() { SetStyle(ControlStyles.Selectable, true); }
        protected override void OnMouseDown(MouseEventArgs value) { Focus(); base.OnMouseDown(value); }
    }
    private ComputerFixture(string path) {
        statusPath = path;
        Text = "shapes.inc owned Windows acceptance fixture";
        Size = new Size(580, 440); StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.None;
        Controls.AddRange(new Control[] { text, password, button, area });
        button.Click += delegate { clicks++; };
        area.MouseDown += delegate { downs++; movesAtDown = moves; dragging = true; };
        area.MouseCaptureChanged += delegate { if (dragging) captureLost++; };
        area.MouseMove += delegate { moves++; };
        area.MouseUp += delegate { ups++; if (dragging) drags++; dragging = false; };
        area.MouseWheel += delegate(object sender, MouseEventArgs value) { wheels += value.Delta; };
        Shown += delegate { Activate(); SetForegroundWindow(Handle); text.Focus(); Save(); timer.Start(); };
        timer.Tick += delegate { Save(); };
        FormClosed += delegate { timer.Stop(); timer.Dispose(); };
    }
    private object Target(Control control) {
        Point point = control.PointToScreen(new Point(control.Width / 2, control.Height / 2));
        return new int[] { point.X, point.Y };
    }
    private void Save() {
        var state = new Dictionary<string, object> {
            { "pid", Process.GetCurrentProcess().Id }, { "text", text.Text }, { "passwordLength", password.Text.Length },
            { "clicks", clicks }, { "moves", moves }, { "wheels", wheels }, { "drags", drags },
            // Diagnostics for a failed wait: which input arrived and whether snapshots are publishing.
            { "downs", downs }, { "ups", ups }, { "movesSinceDown", moves - movesAtDown }, { "captureLost", captureLost }, { "saves", saves }, { "saveFailures", saveFailures }, { "lastSaveError", lastSaveError },
            { "targets", new Dictionary<string, object> { { "text", Target(text) }, { "password", Target(password) }, { "button", Target(button) }, { "area", Target(area) } } }
        };
        // Publish whole snapshots only, with one atomic rename. Rewriting the
        // file in place let a reader catch it truncated, and File.Replace
        // (ReplaceFile) moves the old file aside first, so a reader could find
        // no file at all. If a reader holds the old snapshot the rename fails
        // and the next tick publishes again; the old one stays complete.
        string temporary = statusPath + ".tmp";
        try {
            File.WriteAllText(temporary, json.Serialize(state));
            if (MoveFileEx(temporary, statusPath, MOVEFILE_REPLACE_EXISTING)) saves++;
            else { saveFailures++; lastSaveError = "MoveFileEx " + Marshal.GetLastWin32Error(); }
        }
        catch (IOException error) { saveFailures++; lastSaveError = error.GetType().Name + " " + error.HResult; /* The next tick writes it again. */ }
        catch (UnauthorizedAccessException) { saveFailures++; lastSaveError = "UnauthorizedAccess"; }
    }
    [STAThread] public static int Main(string[] args) {
        if (args.Length != 1 || !Path.IsPathRooted(args[0])) return 2;
        SetThreadDpiAwarenessContext(new IntPtr(-4));
        Application.EnableVisualStyles();
        Application.Run(new ComputerFixture(args[0]));
        return 0;
    }
}
