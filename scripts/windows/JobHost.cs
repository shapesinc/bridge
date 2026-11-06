// Run one installed child in an owned Windows Job. Legacy launchers join the
// Job before creating a child. Receipt mode uses atomic CreateProcess JOB_LIST
// assignment so its observer can remain outside and prove the Job is empty.
// Job/control/receipt handles are not inherited; breakaway is never enabled.
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
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfoPointers startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; public bool inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateOwnedProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
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

    sealed class Control {
        public readonly ManualResetEvent cancelled = new ManualResetEvent(false);
        int terminal; // 0=running, -1=cancel/EOF, 1=successful release
        public bool CommitRelease() { return Interlocked.CompareExchange(ref terminal, 1, 0) == 0; }
        public void Read(IntPtr input) {
            var reader = new Thread(delegate() {
                // Only the owner can access this single-purpose pipe. Any byte,
                // EOF or read failure cancels; no message can authorize release.
                try {
                    uint read;
                    ReadFile(input, new byte[1], 1, out read, IntPtr.Zero);
                } catch {} finally {
                    if (Interlocked.CompareExchange(ref terminal, -1, 0) == 0) cancelled.Set();
                }
            });
            reader.IsBackground = true; reader.Start();
        }
    }

    static bool CreateInJob(string executable, StringBuilder command, IntPtr job, StartupInfo startup, out ProcessInformation child) {
        child = new ProcessInformation();
        IntPtr list = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero; bool initialized = false;
        try {
            UIntPtr size = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == UIntPtr.Zero || size.ToUInt64() > 65536) return false;
            list = Marshal.AllocHGlobal((int)size.ToUInt64());
            if (!InitializeProcThreadAttributeList(list, 2, 0, ref size)) return false;
            initialized = true;
            jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
            // JOB_LIST (Windows 10+) assigns atomically during CreateProcess.
            // No observer-crash gap with a suspended but unassigned child.
            if (!UpdateProcThreadAttribute(list, 0, new UIntPtr(0x2000d), jobs, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) return false;
            var values = new System.Collections.Generic.List<IntPtr>();
            foreach (IntPtr handle in new[] { startup.stdin, startup.stdout, startup.stderr }) {
                uint flags;
                if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !GetHandleInformation(handle, out flags) || (flags & 1) == 0) return false;
                if (!values.Contains(handle)) values.Add(handle);
            }
            handles = Marshal.AllocHGlobal(IntPtr.Size * values.Count);
            for (int i = 0; i < values.Count; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, values[i]);
            // HANDLE_LIST excludes every private control/receipt/Job handle.
            if (!UpdateProcThreadAttribute(list, 0, new UIntPtr(0x20002), handles, new UIntPtr((uint)(IntPtr.Size * values.Count)), IntPtr.Zero, IntPtr.Zero)) return false;
            var extended = new StartupInfoEx();
            extended.startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
            extended.startup.flags = 0x100; extended.startup.stdin = startup.stdin;
            extended.startup.stdout = startup.stdout; extended.startup.stderr = startup.stderr; extended.attributes = list;
            return CreateOwnedProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x08000000u | 0x00080000u, IntPtr.Zero, Environment.CurrentDirectory, ref extended, out child);
        } finally {
            if (initialized) DeleteProcThreadAttributeList(list);
            if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }

    static bool TerminateAndConfirm(IntPtr job, IntPtr receipt) {
        if (!TerminateJobObject(job, 130)) return false;
        var clock = Stopwatch.StartNew();
        do {
            Accounting state;
            if (!QueryInformationJobObject(job, 1, out state, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return false;
            if (state.ActiveProcesses == 0) {
                var bytes = Encoding.ASCII.GetBytes("job-empty\n"); uint written;
                return WriteFile(receipt, bytes, (uint)bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
            }
            Thread.Sleep(10);
        } while (clock.ElapsedMilliseconds < 750);
        return false; // Caller keeps kill-on-close; no receipt, no cleanup claim.
    }

    static bool WriteReady(IntPtr output) {
        byte[] bytes = Encoding.ASCII.GetBytes("{\"started\":true}\n"); uint written;
        return WriteFile(output, bytes, (uint)bytes.Length, out written, IntPtr.Zero) && written == bytes.Length;
    }

    static bool AwaitRelease(IntPtr parent, Control control = null) {
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
            var handles = control == null ? new[] { parent, received.SafeWaitHandle.DangerousGetHandle() }
                : new[] { parent, control.cancelled.SafeWaitHandle.DangerousGetHandle(), received.SafeWaitHandle.DangerousGetHandle() };
            uint completed = WaitForMultipleObjects((uint)handles.Length, handles, false, 0xffffffff);
            bool accepted = completed == handles.Length - 1 && Interlocked.CompareExchange(ref release, 0, 0) == 1
                && WaitForSingleObject(parent, 0) == 258 && (control == null || control.CommitRelease());
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
        IntPtr parent = IntPtr.Zero, childInput = IntPtr.Zero, ownedJob = IntPtr.Zero, receipt = IntPtr.Zero;
        try {
            int index = 0, outputFd = -1, controlFd = -1, receiptFd = -1; bool console = false, ready = false, commandString = false, releaseOnSuccess = false;
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
            IntPtr captureOutput = IntPtr.Zero;
            if (releaseOnSuccess && !InheritedOutputPipe(outputFd, out captureOutput)) return 64;
            if (index + 3 < args.Length && args[index] == "--control-fd" && args[index + 2] == "--receipt-fd") {
                if (!int.TryParse(args[index + 1], out controlFd) || !int.TryParse(args[index + 3], out receiptFd) || controlFd < 3 || receiptFd < 3 || controlFd == receiptFd) return 64;
                index += 4;
            }
            Control control = null;
            if (controlFd >= 0) {
                IntPtr input;
                if (parent == IntPtr.Zero || console || !InheritedOutputPipe(controlFd, out input) || !InheritedOutputPipe(receiptFd, out receipt)
                    || input == receipt || input == captureOutput || receipt == captureOutput
                    || !SetHandleInformation(input, 1, 0) || !SetHandleInformation(receipt, 1, 0)) return 64;
                control = new Control(); control.Read(input);
            }
            if (index < args.Length && args[index] == "--command-string") { commandString = true; index++; }
            if (releaseOnSuccess && (parent == IntPtr.Zero || console || outputFd < 3)) return 64;
            if (!releaseOnSuccess && outputFd != -1) return 64;
            if (index >= args.Length || args[index++] != "--" || index >= args.Length || !Path.IsPathRooted(args[index])) return 64;
            string executable = Path.GetFullPath(args[index]);
            if (!File.Exists(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return 66;
            if (commandString && (!Path.GetFileName(executable).Equals("cmd.exe", StringComparison.OrdinalIgnoreCase) || args.Length != index + 2 || args[index + 1].IndexOfAny(new[] { '\r', '\n' }) >= 0)) return 64;
            IntPtr job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) return 70;
            var limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
            if (control != null) ownedJob = job;
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))
                || control == null && !AssignProcessToJobObject(job, GetCurrentProcess())) return 70;
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
            if (control != null) {
                if (WaitForSingleObject(parent, 0) != 258 || control.cancelled.WaitOne(0) || !CreateInJob(executable, command, job, startup, out child)) return 71;
            } else if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, console ? 0x10u : 0x08000000u, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) return 71;
            if (childInput != IntPtr.Zero) { CloseHandle(childInput); childInput = IntPtr.Zero; }
            if (ready) {
                if (releaseOnSuccess) { if (!WriteReady(captureOutput)) return 70; }
                else { Console.Out.WriteLine("{\"started\":true}"); Console.Out.Flush(); }
            }
            CloseHandle(child.thread);
            var handles = control != null ? new[] { parent, control.cancelled.SafeWaitHandle.DangerousGetHandle(), child.process }
                : parent == IntPtr.Zero ? new[] { child.process } : new[] { child.process, parent };
            uint completed = WaitForMultipleObjects((uint)handles.Length, handles, false, 0xffffffff);
            bool leaderExited = completed == (control == null ? 0 : 2);
            uint code = 1;
            if (leaderExited) GetExitCodeProcess(child.process, out code);
            Trace("child=" + child.processId + " wait=" + completed + " exit=" + code);
            CloseHandle(child.process);
            if (releaseOnSuccess && leaderExited && code == 0) {
                // A successful shell can leave descendants holding its output
                // pipes. Remain cancellable until the owner observes both EOFs
                // and explicitly commits successful background ownership handoff.
                if (!CloseOutputHandles(captureOutput, startup.stderr)) return 70;
                if (!AwaitRelease(parent, control)) { if (control != null) TerminateAndConfirm(job, receipt); return 70; }
                limits.BasicLimitInformation.LimitFlags = 0;
                if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) return 70;
                Trace("released");
            } else if (control != null) {
                if (!TerminateAndConfirm(job, receipt)) return 70;
                if (!leaderExited) return 130;
            }
            GC.KeepAlive(job);
            return (int)code;
        } catch { return 70; }
        finally { if (ownedJob != IntPtr.Zero) CloseHandle(ownedJob); if (childInput != IntPtr.Zero) CloseHandle(childInput); if (parent != IntPtr.Zero) CloseHandle(parent); }
    }
}
