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
    static readonly string diagnosticPath = Environment.GetEnvironmentVariable("SHAPES_TEST_JOB_HOST_TRACE");
    static readonly object diagnosticLock = new object();
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
    // GetStartupInfo returns borrowed Windows pointers. Keep them as IntPtr;
    // an output struct containing strings would ask the marshaller to free them.
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoPointers {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reserved2Count; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public bool inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", EntryPoint = "GetStartupInfoW", ExactSpelling = true)] static extern void GetStartupInfoPointers(out StartupInfoPointers info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetStdHandle(int handle, IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr handle, [Out] byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll")] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    static void Trace(string message) {
        if (String.IsNullOrEmpty(diagnosticPath)) return;
        // Opt-in native-test evidence only: no command, environment or output.
        try { lock (diagnosticLock) File.AppendAllText(diagnosticPath, DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine); } catch {}
    }

    static bool InheritedOutputPipe(int fd, out IntPtr handle) {
        handle = IntPtr.Zero;
        StartupInfoPointers info; GetStartupInfoPointers(out info);
        // libuv's inherited CRT layout is uint count, count byte flags, then
        // count pointer-sized handles (deps/uv/src/win/process-stdio.c). This
        // reads only the explicitly requested extra descriptor, within bounds.
        if (fd < 3 || fd > 255 || info.reserved2 == IntPtr.Zero || info.reserved2Count < 4) return false;
        int count = Marshal.ReadInt32(info.reserved2);
        if (count <= fd || count > 256 || 4 + count * (1 + IntPtr.Size) > info.reserved2Count) return false;
        if ((Marshal.ReadByte(info.reserved2, 4 + fd) & 9) != 9) return false; // FOPEN | FPIPE
        IntPtr candidate = Marshal.ReadIntPtr(info.reserved2, 4 + count + IntPtr.Size * fd);
        uint flags;
        if (candidate == IntPtr.Zero || candidate == new IntPtr(-1) || candidate == GetStdHandle(-10) || candidate == GetStdHandle(-11) || candidate == GetStdHandle(-12)
            || !GetHandleInformation(candidate, out flags) || (flags & 1) == 0 || GetFileType(candidate) != 3) return false;
        handle = candidate; return true;
    }

    static bool WriteReady(IntPtr output) {
        byte[] bytes = Encoding.ASCII.GetBytes("{\"started\":true}\n"); uint written;
        return WriteFile(output, bytes, (uint)bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
    }

    static bool AwaitRelease(IntPtr parent) {
        // The command cannot read this pipe: its stdin is NUL and the control
        // handle is non-inheritable. EOF, malformed input and owner death keep
        // the kill-on-close Job intact. Bound the only accepted message.
        Trace("await-release");
        IntPtr input = GetStdHandle(-10);
        using (var received = new ManualResetEvent(false)) {
            int release = 0;
            var reader = new Thread(delegate() {
                try {
                    var bytes = new byte[8]; int count = 0;
                    var part = new byte[8];
                    while (count < bytes.Length) {
                        uint read;
                        if (!ReadFile(input, part, (uint)(bytes.Length - count), out read, IntPtr.Zero) || read == 0) break;
                        Buffer.BlockCopy(part, 0, bytes, count, (int)read);
                        count += (int)read;
                    }
                    Trace("control-bytes=" + count);
                    if (count == bytes.Length && Encoding.ASCII.GetString(bytes) == "release\n") Interlocked.Exchange(ref release, 1);
                } catch { /* A closed control pipe never authorizes release. */ }
                finally { try { received.Set(); } catch (ObjectDisposedException) {} }
            });
            reader.IsBackground = true; reader.Start();
            // Put the parent first: if both become signaled, owner death wins.
            var handles = new[] { parent, received.SafeWaitHandle.DangerousGetHandle() };
            uint completed = WaitForMultipleObjects(2, handles, false, 0xffffffff);
            bool accepted = completed == 1 && Interlocked.CompareExchange(ref release, 0, 0) == 1;
            Trace("release-wait=" + completed + " accepted=" + accepted);
            return accepted;
        }
    }

    static bool CloseOutputHandles(IntPtr output, IntPtr error) {
        // output is the explicit extra pipe, never the managed runtime's startup
        // stdout slot. Only these owned handles are closed; no runtime aliases
        // are enumerated. The helper's standard stdout stays on NUL until exit.
        bool errorReset = SetStdHandle(-12, IntPtr.Zero);
        bool outputClosed = CloseHandle(output); int outputError = outputClosed ? 0 : Marshal.GetLastWin32Error();
        bool errorClosed = error == output || error == IntPtr.Zero || error == new IntPtr(-1) || CloseHandle(error);
        int errorError = errorClosed ? 0 : Marshal.GetLastWin32Error();
        Trace("close-output reset=" + errorReset + " closed=" + outputClosed + "," + errorClosed + " error=" + outputError + "," + errorError);
        return errorReset && outputClosed && errorClosed;
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
            int index = 0, outputFd = -1; bool console = false, ready = false, commandString = false, releaseOnSuccess = false;
            if (args.Length > 1 && args[0] == "--parent-pid") {
                uint parentId; if (!uint.TryParse(args[1], out parentId) || parentId == 0) return 64;
                parent = OpenProcess(0x00100000, false, parentId); if (parent == IntPtr.Zero) return 70;
                index += 2;
            }
            if (index < args.Length && args[index] == "--ready") { ready = true; index++; }
            if (index < args.Length && args[index] == "--console") { console = true; index++; }
            if (index < args.Length && args[index] == "--release-on-success") { releaseOnSuccess = true; index++; }
            if (index < args.Length && args[index] == "--stdout-fd") {
                if (index + 1 >= args.Length || !int.TryParse(args[index + 1], out outputFd) || outputFd < 3 || outputFd > 255) return 64;
                index += 2;
            }
            if (index < args.Length && args[index] == "--command-string") { commandString = true; index++; }
            if (releaseOnSuccess && (parent == IntPtr.Zero || console || outputFd < 3)) return 64;
            if (!releaseOnSuccess && outputFd != -1) return 64;
            IntPtr captureOutput = IntPtr.Zero;
            if (releaseOnSuccess && !InheritedOutputPipe(outputFd, out captureOutput)) return 64;
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
                startup.stdout = captureOutput;
                if (!SetHandleInformation(startup.stdin, 1, 0)) return 70; // HANDLE_FLAG_INHERIT
                var attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), inherit = true };
                childInput = CreateFile("NUL", 0x80000000, 3, ref attributes, 3, 0, IntPtr.Zero);
                if (childInput == new IntPtr(-1)) { childInput = IntPtr.Zero; return 70; }
                startup.stdin = childInput;
            }
            ProcessInformation child;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, console ? 0x10u : 0x08000000u, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) return 71;
            if (childInput != IntPtr.Zero) { CloseHandle(childInput); childInput = IntPtr.Zero; }
            if (ready) {
                if (releaseOnSuccess) { if (!WriteReady(captureOutput)) return 70; }
                else { Console.Out.WriteLine("{\"started\":true}"); Console.Out.Flush(); }
            }
            CloseHandle(child.thread);
            var handles = parent == IntPtr.Zero ? new[] { child.process } : new[] { child.process, parent };
            uint completed = WaitForMultipleObjects((uint)handles.Length, handles, false, 0xffffffff);
            uint code = 1;
            if (completed == 0) GetExitCodeProcess(child.process, out code);
            Trace("child=" + child.processId + " wait=" + completed + " exit=" + code);
            CloseHandle(child.process);
            if (releaseOnSuccess && completed == 0 && code == 0) {
                // A successful shell can leave descendants holding its output
                // pipes. Remain cancellable until the owner observes both EOFs
                // and explicitly commits successful background ownership handoff.
                if (!CloseOutputHandles(captureOutput, startup.stderr)) return 70;
                if (!AwaitRelease(parent)) return 70;
                limits.BasicLimitInformation.LimitFlags = 0;
                if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return 70;
                Trace("released");
            }
            GC.KeepAlive(job);
            return (int)code;
        } catch { return 70; }
        finally { if (childInput != IntPtr.Zero) CloseHandle(childInput); if (parent != IntPtr.Zero) CloseHandle(parent); }
    }
}
