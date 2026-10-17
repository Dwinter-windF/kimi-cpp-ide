$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$app = Join-Path $root 'Kimi C++ IDE\Kimi C++ IDE.exe'
$wd = Split-Path $app
$env:KIMI_IDE_USERDATA = Join-Path $env:LOCALAPPDATA 'kimi-test-B'
Remove-Item $env:KIMI_IDE_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
$outB = Join-Path $root '_B2-out.log'; $errB = Join-Path $root '_B2-err.log'
Remove-Item $outB,$errB -ErrorAction SilentlyContinue
$pB = Start-Process -FilePath $app -ArgumentList '--no-sandbox' -WorkingDirectory $wd -PassThru -RedirectStandardOutput $outB -RedirectStandardError $errB -WindowStyle Hidden
Start-Sleep 12
if ($pB.HasExited) { Write-Output 'B2 exited' } else {
  $port = (Get-NetTCPConnection -OwningProcess $pB.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
  Write-Output ('B2 alive pid=' + $pB.Id + ' port=' + $port + ' cpu=' + (Get-Process -Id $pB.Id).CPU)
}
Stop-Process -Id $pB.Id -Force -ErrorAction SilentlyContinue
