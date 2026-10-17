param([int]$TargetPid = 0)
if ($TargetPid -eq 0) { $TargetPid = 187004 }
$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'gone'; exit }
$osThreads = Get-CimInstance Win32_Thread -Filter ("ProcessHandle=" + $TargetPid)
Write-Output ("threads=" + $osThreads.Count + " cpu=" + $p.CPU)
$osThreads | Group-Object ThreadWaitReason | ForEach-Object {
  Write-Output ($_.Name + " x" + $_.Count)
}
Write-Output '--- sample threads ---'
$osThreads | Select-Object -First 12 | ForEach-Object {
  Write-Output ("tid=" + $_.Handle + " state=" + $_.ThreadState + " wait=" + $_.ThreadWaitReason + " wc=" + $_.ContextSwitches)
}
