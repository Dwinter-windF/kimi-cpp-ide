$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$c = Get-NetTCPConnection -LocalPort 3213 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c[0].OwningProcess -Force }
Start-Sleep -Seconds 1
$out = Join-Path $root '_preview-3213.log'
$err = Join-Path $root '_preview-3213.err.log'
$p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'standalone.ts','--port','3213','--root','.' -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds 6
$port = (Get-NetTCPConnection -OwningProcess $p.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
Write-Output ('pid=' + $p.Id + ' port=' + $port + ' alive=' + (-not $p.HasExited))
