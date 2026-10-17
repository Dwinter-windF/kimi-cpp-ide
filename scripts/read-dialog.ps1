param([int]$TargetPid = 0)
if ($TargetPid -eq 0) { exit }
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinTxt {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  public static string Run(uint target) {
    StringBuilder sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h)) {
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        StringBuilder c = new StringBuilder(256);
        GetClassNameW(h, c, 256);
        sb.AppendLine("WINDOW class=" + c.ToString() + " title=" + t.ToString());
        EnumChildWindows(h, (ch, cl) => {
          StringBuilder ct = new StringBuilder(4096);
          GetWindowTextW(ch, ct, 4096);
          if (ct.Length > 0) sb.AppendLine("  CHILD: " + ct.ToString());
          return true;
        }, IntPtr.Zero);
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
Add-Type -TypeDefinition $sig
Write-Output ([WinTxt]::Run([uint32]$TargetPid))
