$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$app = Join-Path $root 'Kimi C++ IDE\Kimi C++ IDE.exe'
$wd = Split-Path $app

Write-Output '--- A: with KIMI_IDE_USERDATA ---'
$env:KIMI_IDE_USERDATA = Join-Path $root 'cpp-ide-app-wordhl\_ud-A'
Remove-Item $env:KIMI_IDE_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
$outA = Join-Path $root '_A-out.log'; $errA = Join-Path $root '_A-err.log'
Remove-Item $outA,$errA -ErrorAction SilentlyContinue
$pA = Start-Process -FilePath $app -ArgumentList '--no-sandbox' -WorkingDirectory $wd -PassThru -RedirectStandardOutput $outA -RedirectStandardError $errA -WindowStyle Hidden
Start-Sleep 12
if ($pA.HasExited) { Write-Output 'A exited' } else {
  $port = (Get-NetTCPConnection -OwningProcess $pA.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
  Write-Output ('A alive pid=' + $pA.Id + ' port=' + $port + ' cpu=' + (Get-Process -Id $pA.Id).CPU)
}
Stop-Process -Id $pA.Id -Force -ErrorAction SilentlyContinue
Remove-Item Env:KIMI_IDE_USERDATA

Start-Sleep 2
Write-Output '--- B: default env ---'
$outB = Join-Path $root '_B-out.log'; $errB = Join-Path $root '_B-err.log'
Remove-Item $outB,$errB -ErrorAction SilentlyContinue
$pB = Start-Process -FilePath $app -ArgumentList '--no-sandbox' -WorkingDirectory $wd -PassThru -RedirectStandardOutput $outB -RedirectStandardError $errB -WindowStyle Hidden
Start-Sleep 12
if ($pB.HasExited) { Write-Output 'B exited' } else {
  $port = (Get-NetTCPConnection -OwningProcess $pB.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
  Write-Output ('B alive pid=' + $pB.Id + ' port=' + $port + ' cpu=' + (Get-Process -Id $pB.Id).CPU)
}
Write-Output '--- B stdout ---'
Get-Content $outB -ErrorAction SilentlyContinue
Write-Output '--- B stderr ---'
Get-Content $errB -ErrorAction SilentlyContinue
Stop-Process -Id $pB.Id -Force -ErrorAction SilentlyContinue
