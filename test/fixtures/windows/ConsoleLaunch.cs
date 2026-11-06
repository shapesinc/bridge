// Disposable GUI fixture. Launch with ordinary CreateProcess flags, as an OS
// launcher does, without Node's windowsHide or a console inherited from Node.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

class ConsoleLaunch {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2Count; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1).Append(c); slashes = 0; continue; }
            result.Append('\\', slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void Receipt(string file, string value) {
        string temporary = file + "." + Process.GetCurrentProcess().Id + ".tmp";
        File.WriteAllText(temporary, value); File.Move(temporary, file);
    }
    static int Main(string[] args) {
        if (args.Length == 3 && args[0] == "inspect") {
            FreeConsole();
            bool attached = AttachConsole(uint.Parse(args[1]));
            int error = attached ? 0 : Marshal.GetLastWin32Error();
            uint count = attached ? GetConsoleProcessList(new uint[32], 32) : 0;
            if (attached) FreeConsole();
            Receipt(args[2], "{\"attached\":" + (attached ? "true" : "false") + ",\"error\":" + error + ",\"processCount\":" + count + "}");
            return 0;
        }
        if (args.Length < 4 || args[0] != "launch") return 64;
        var command = new StringBuilder(Quote(args[2]));
        command.Append(" --parent-pid ").Append(Process.GetCurrentProcess().Id);
        for (int i = 3; i < args.Length; i++) command.Append(' ').Append(Quote(args[i]));
        var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInformation child;
        // Zero flags, no inherited handles, no STARTF_USESHOWWINDOW or stdio.
        if (!CreateProcess(args[2], command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) return 70;
        CloseHandle(child.thread);
        try {
            Receipt(args[1], "{\"pid\":" + child.processId + "}");
            if (WaitForSingleObject(child.process, 20000) != 0) {
                TerminateProcess(child.process, 70); WaitForSingleObject(child.process, 3000); return 70;
            }
            uint code; return GetExitCodeProcess(child.process, out code) ? (int)code : 70;
        } finally { CloseHandle(child.process); }
    }
}
