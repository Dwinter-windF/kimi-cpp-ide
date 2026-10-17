$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
Set-Location $root
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:KIMI_IDE_USERDATA = Join-Path $root '_electron-userdata'
Remove-Item $env:KIMI_IDE_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
$log = Join-Path $root '_electron-smoke.log'
Remove-Item $log -ErrorAction SilentlyContinue
Remove-Item ($log + '.err') -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath (Join-Path $root 'node_modules\electron\dist\electron.exe') `
  -ArgumentList '.', '--no-sandbox' `
  -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError ($log + '.err') `
  -PassThru
Start-Sleep -Seconds 12
$alive = -not $proc.HasExited
$port = $null
if (Test-Path $log) {
  $m = Select-String -Path $log -Pattern 'localhost:(\d+)' | Select-Object -First 1
  if ($m) { $port = $m.Matches[0].Groups[1].Value }
}
$http = $false
if ($port) {
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
    $http = ($resp.StatusCode -eq 200) -and ($resp.Content -like '*Kimi*')
  } catch { $http = $false }
}
if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
$still = Get-Process -Name electron -ErrorAction SilentlyContinue
if ($still) { $still | Stop-Process -Force -ErrorAction SilentlyContinue }
Write-Output ("SMOKE_RESULT alive=" + $alive + " port=" + $port + " http=" + $http)
