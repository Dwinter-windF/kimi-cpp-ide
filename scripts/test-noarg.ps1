$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$app = Join-Path $root 'Kimi C++ IDE\Kimi C++ IDE.exe'
$wd = Split-Path $app
$env:KIMI_IDE_USERDATA = Join-Path $root 'cpp-ide-app-wordhl\_ud-nosw'
Remove-Item $env:KIMI_IDE_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
$out = Join-Path $root '_nosw-out.log'; $err = Join-Path $root '_nosw-err.log'
Remove-Item $out,$err -ErrorAction SilentlyContinue
# 不传任何参数，检验内置 appendSwitch 是否足够
$p = Start-Process -FilePath $app -WorkingDirectory $wd -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden
Start-Sleep 15
if ($p.HasExited) {
  Write-Output ('NOARG exited, code=' + $p.ExitCode)
} else {
  $port = (Get-NetTCPConnection -OwningProcess $p.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
  Write-Output ('NOARG alive pid=' + $p.Id + ' port=' + $port + ' cpu=' + (Get-Process -Id $p.Id).CPU)
}
Write-Output '--- stdout ---'
Get-Content $out -ErrorAction SilentlyContinue
Write-Output '--- stderr ---'
Get-Content $err -ErrorAction SilentlyContinue
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
