param([int]$PidToCheck = 0)
if ($PidToCheck -eq 0) { $PidToCheck = 186092 }
$p = Get-Process -Id $PidToCheck -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "proc gone"; exit }
Write-Output ("Handle=" + $p.MainWindowHandle + " Title='" + $p.MainWindowTitle + "' CPU=" + $p.CPU)
Write-Output "--- children ---"
Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $PidToCheck) | ForEach-Object {
  Write-Output ($_.ProcessId.ToString() + " " + $_.Name)
}
Write-Output "--- all top-level windows of this pid ---"
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string Run(uint target) {
    StringBuilder sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        StringBuilder t = new StringBuilder(256);
        GetWindowTextW(h, t, 256);
        sb.AppendLine(h.ToString() + " visible=" + IsWindowVisible(h) + " title='" + t.ToString() + "'");
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
}
"@
Add-Type -TypeDefinition $sig
Write-Output ([WinEnum]::Run([uint32]$PidToCheck))
Write-Output "--- windows of children ---"
Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $PidToCheck) | ForEach-Object {
  $out = [WinEnum]::Run([uint32]$_.ProcessId)
  if ($out) { Write-Output ("pid " + $_.ProcessId + ":"); Write-Output $out }
}
