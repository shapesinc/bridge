// CI-only privilege-lowering launcher. Run under the existing owned JobHost so
// interruption closes its job and terminates the test process and descendants.
// This does not ship in the signed computer helper or relax its input checks.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class MediumProcess {
    [StructLayout(LayoutKind.Sequential)] private struct SidAndAttributes { public IntPtr sid; public uint attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2Count; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int size, out int needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr source, uint flags, uint disableCount, IntPtr disableSids, uint deleteCount, IntPtr deletePrivileges, uint restrictCount, IntPtr restrictSids, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);

    private static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    private static int Integrity(IntPtr token) {
        int length; GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
        if (length < IntPtr.Size || length > 65536) throw new InvalidOperationException("invalid token information");
        IntPtr memory = Marshal.AllocHGlobal(length);
        try {
            Check(GetTokenInformation(token, 25, memory, length, out length));
            string sid = new SecurityIdentifier(Marshal.ReadIntPtr(memory)).Value;
            return Int32.Parse(sid.Substring(sid.LastIndexOf('-') + 1));
        } finally { Marshal.FreeHGlobal(memory); }
    }
    private static void SetMedium(IntPtr token) {
        var sid = new SecurityIdentifier("S-1-16-8192");
        var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
        int labelSize = Marshal.SizeOf(typeof(SidAndAttributes));
        IntPtr memory = Marshal.AllocHGlobal(labelSize + bytes.Length);
        try {
            IntPtr sidAddress = IntPtr.Add(memory, labelSize);
            Marshal.Copy(bytes, 0, sidAddress, bytes.Length);
            Marshal.StructureToPtr(new SidAndAttributes { sid = sidAddress, attributes = 0x20 }, memory, false);
            Check(SetTokenInformation(token, 25, memory, labelSize + bytes.Length));
            if (Integrity(token) != 8192) throw new InvalidOperationException("token was not lowered to medium");
        } finally { Marshal.FreeHGlobal(memory); }
    }
    private static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1).Append(ch);
            else result.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static int Main(string[] args) {
        IntPtr own = IntPtr.Zero, medium = IntPtr.Zero, childToken = IntPtr.Zero;
        var child = new ProcessInfo(); bool completed = false;
        string stage = "arguments";
        try {
            if (args.Length < 2 || args[0] != "--" || !Path.IsPathRooted(args[1]) || !File.Exists(args[1]) || !args[1].EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return 64;
            stage = "job ownership";
            bool owned; Check(IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out owned));
            if (!owned) throw new InvalidOperationException("run under the owned JobHost");
            stage = "restricted token";
            Check(OpenProcessToken(GetCurrentProcess(), 0x000F01FF, out own));
            if (Integrity(own) < 8192) throw new InvalidOperationException("cannot raise integrity");
            Check(CreateRestrictedToken(own, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out medium));
            SetMedium(medium);
            var command = new StringBuilder();
            for (int i = 1; i < args.Length; i++) { if (i > 1) command.Append(' '); command.Append(Quote(args[i])); }
            var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), desktop = "winsta0\\default", flags = 0x100,
                stdin = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12) };
            stage = "create suspended test process";
            Check(CreateProcessAsUser(medium, Path.GetFullPath(args[1]), command, IntPtr.Zero, IntPtr.Zero, true, 0x00000004 | 0x08000000,
                IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child));
            stage = "verify child integrity";
            Check(OpenProcessToken(child.process, 8, out childToken));
            if (Integrity(childToken) != 8192) throw new InvalidOperationException("test process is not medium integrity");
            Check(IsProcessInJob(child.process, IntPtr.Zero, out owned));
            if (!owned) throw new InvalidOperationException("test process escaped its owned job");
            Console.WriteLine("Windows computer test process integrity: medium (8192)"); Console.Out.Flush();
            stage = "run test process";
            if (ResumeThread(child.thread) == UInt32.MaxValue) Check(false);
            if (WaitForSingleObject(child.process, 180000) != 0) throw new InvalidOperationException("test process exceeded deadline");
            uint code; Check(GetExitCodeProcess(child.process, out code)); completed = true; return unchecked((int)code);
        } catch (Exception error) {
            var native = error as Win32Exception;
            Console.Error.WriteLine("Medium test launcher failed at " + stage + ": " + error.GetType().Name + (native == null ? "" : " (" + native.NativeErrorCode + ")"));
            return 70;
        } finally {
            if (!completed && child.process != IntPtr.Zero) { TerminateProcess(child.process, 70); WaitForSingleObject(child.process, 3000); }
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (child.process != IntPtr.Zero) CloseHandle(child.process);
            if (childToken != IntPtr.Zero) CloseHandle(childToken);
            if (medium != IntPtr.Zero) CloseHandle(medium);
            if (own != IntPtr.Zero) CloseHandle(own);
        }
    }
}
