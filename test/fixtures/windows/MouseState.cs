// TEMPORARY diagnostic for the repeat job (remove before merge): prints whether
// Windows reports the left mouse button as held, and with "release" sends one
// left-button-up when it is, then prints the state again.
using System;
using System.Runtime.InteropServices;

internal static class MouseState {
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] input, int size);
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTUNION data; }
    private static bool Down() { return (GetAsyncKeyState(1) & 0x8000) != 0; }
    public static int Main(string[] args) {
        bool down = Down();
        Console.WriteLine("left_down=" + (down ? 1 : 0));
        if (down && args.Length == 1 && args[0] == "release") {
            var up = new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { flags = 0x0004 } } };
            Console.WriteLine("sent=" + SendInput(1, new[] { up }, Marshal.SizeOf(typeof(INPUT))));
            System.Threading.Thread.Sleep(100);
            Console.WriteLine("left_down_after=" + (Down() ? 1 : 0));
        }
        return 0;
    }
}
