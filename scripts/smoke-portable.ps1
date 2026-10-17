$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$app = Join-Path $root 'release\Kimi C++ IDE-1.0.0-portable.exe'
$outLog = Join-Path $root '_smoke-portable-stdout.log'
$errLog = Join-Path $root '_smoke-portable-stderr.log'
Remove-Item $outLog,$errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $app -ArgumentList '--no-sandbox' `
  -WorkingDirectory $root -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
# portable 模式：启动器解压后派生子进程运行，最多等 60 秒
$found = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $cands = Get-Process | Where-Object { $_.Name -eq 'Kimi C++ IDE' }
  foreach ($c in $cands) {
    $port = (Get-NetTCPConnection -OwningProcess $c.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
    if ($port) { $found = $c; break }
  }
  if ($found) { break }
}
if (-not $found) { Write-Output 'PORTABLE_NO_LISTENER'; exit }
Start-Sleep -Seconds 3
$p = Get-Process -Id $found.Id
Write-Output ("pid=" + $p.Id + " port=" + $port + " Handle=" + $p.MainWindowHandle + " Title='" + $p.MainWindowTitle + "'")
try {
  $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -TimeoutSec 5 -UseBasicParsing
  Write-Output ("HTTP " + $r.StatusCode + " len=" + $r.Content.Length)
} catch {
  Write-Output ("http failed: " + $_.Exception.Message)
}
