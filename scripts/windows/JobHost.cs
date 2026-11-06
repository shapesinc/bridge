// Run a single installed child in an owned Windows Job. The process joins its
// job before CreateProcess, so there is no suspended/unowned-child race. Job
// handles are not inherited and breakaway is never enabled.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class JobHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IOCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IOCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public short showWindow, reserved2Count; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public bool inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static bool AwaitRelease(IntPtr parent) {
        // The command cannot read this pipe: its stdin is NUL and the control
        // handle is non-inheritable. EOF, malformed input and owner death keep
        // the kill-on-close Job intact. Bound the only accepted message.
        using (var received = new ManualResetEvent(false)) {
            int release = 0;
            var reader = new Thread(delegate() {
                try {
                    var input = Console.OpenStandardInput();
                    var bytes = new byte[8]; int count = 0;
                    while (count < bytes.Length) {
                        int read = input.Read(bytes, count, bytes.Length - count);
                        if (read == 0) break;
                        count += read;
                    }
                    if (count == bytes.Length && Encoding.ASCII.GetString(bytes) == "release\n") Interlocked.Exchange(ref release, 1);
                } catch { /* A closed control pipe never authorizes release. */ }
                finally { try { received.Set(); } catch (ObjectDisposedException) {} }
            });
            reader.IsBackground = true; reader.Start();
            // Put the parent first: if both become signaled, owner death wins.
            var handles = new[] { parent, received.SafeWaitHandle.DangerousGetHandle() };
            return WaitForMultipleObjects(2, handles, false, 0xffffffff) == 1 && Interlocked.CompareExchange(ref release, 0, 0) == 1;
        }
    }

    static void CloseOutputHandles() {
        Console.Out.Flush(); Console.Error.Flush();
        IntPtr output = GetStdHandle(-11), error = GetStdHandle(-12);
        if (output != IntPtr.Zero && output != new IntPtr(-1)) CloseHandle(output);
        if (error != output && error != IntPtr.Zero && error != new IntPtr(-1)) CloseHandle(error);
    }

    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"') result.Append('\\', slashes * 2 + 1).Append(ch);
            else result.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    static int Main(string[] args) {
        IntPtr parent = IntPtr.Zero, childInput = IntPtr.Zero;
        try {
            int index = 0; bool console = false, ready = false, commandString = false, releaseOnSuccess = false;
            if (args.Length > 1 && args[0] == "--parent-pid") {
                uint parentId; if (!uint.TryParse(args[1], out parentId) || parentId == 0) return 64;
                parent = OpenProcess(0x00100000, false, parentId); if (parent == IntPtr.Zero) return 70;
                index += 2;
            }
            if (index < args.Length && args[index] == "--ready") { ready = true; index++; }
            if (index < args.Length && args[index] == "--console") { console = true; index++; }
            if (index < args.Length && args[index] == "--release-on-success") { releaseOnSuccess = true; index++; }
            if (index < args.Length && args[index] == "--command-string") { commandString = true; index++; }
            if (releaseOnSuccess && (parent == IntPtr.Zero || console)) return 64;
            if (index >= args.Length || args[index++] != "--" || index >= args.Length || !Path.IsPathRooted(args[index])) return 64;
            string executable = Path.GetFullPath(args[index]);
            if (!File.Exists(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return 66;
            if (commandString && (!Path.GetFileName(executable).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase) || args.Length != index + 2 || args[index + 1].IndexOfAny(new[] { '\r', '\n' }) >= 0)) return 64;
            IntPtr job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) return 70;
            var limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))) || !AssignProcessToJobObject(job, GetCurrentProcess())) return 70;
            // Deliberately retain this sole non-inherited handle until process
            // exit: terminating the wrapper then terminates every descendant.
            var command = new StringBuilder();
            if (commandString) command.Append(Quote(executable)).Append(" /d /s /c \"").Append(args[index + 1]).Append('"');
            else for (int i = index; i < args.Length; i++) { if (i != index) command.Append(' '); command.Append(Quote(args[i])); }
            var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            if (!console) { startup.flags = 0x100; startup.stdin = GetStdHandle(-10); startup.stdout = GetStdHandle(-11); startup.stderr = GetStdHandle(-12); }
            if (releaseOnSuccess) {
                if (!SetHandleInformation(startup.stdin, 1, 0)) return 70; // HANDLE_FLAG_INHERIT
                var attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), inherit = true };
                childInput = CreateFile("NUL", 0x80000000, 3, ref attributes, 3, 0, IntPtr.Zero);
                if (childInput == new IntPtr(-1)) { childInput = IntPtr.Zero; return 70; }
                startup.stdin = childInput;
            }
            ProcessInformation child;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, console ? 0x10u : 0x08000000u, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) return 71;
            if (childInput != IntPtr.Zero) { CloseHandle(childInput); childInput = IntPtr.Zero; }
            if (ready) { Console.Out.WriteLine("{\"started\":true}"); Console.Out.Flush(); }
            CloseHandle(child.thread);
            var handles = parent == IntPtr.Zero ? new[] { child.process } : new[] { child.process, parent };
            uint completed = WaitForMultipleObjects((uint)handles.Length, handles, false, 0xffffffff);
            uint code = 1;
            if (completed == 0) GetExitCodeProcess(child.process, out code);
            CloseHandle(child.process);
            if (releaseOnSuccess && completed == 0 && code == 0) {
                // A successful shell can leave descendants holding its output
                // pipes. Remain cancellable until the owner observes both EOFs
                // and explicitly commits successful background ownership handoff.
                CloseOutputHandles();
                if (!AwaitRelease(parent)) return 70;
                limits.BasicLimitInformation.LimitFlags = 0;
                if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return 70;
            }
            GC.KeepAlive(job);
            return (int)code;
        } catch { return 70; }
        finally { if (childInput != IntPtr.Zero) CloseHandle(childInput); if (parent != IntPtr.Zero) CloseHandle(parent); }
    }
}
