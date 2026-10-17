$ErrorActionPreference = 'Stop'
$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
$dest = 'C:\Users\41855\Desktop\DEEPSEEK workspace\_zip-test'
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path (Join-Path $root 'release\Kimi C++ IDE-1.0.0-windows.zip') -DestinationPath $dest
Write-Output ('extracted files: ' + (Get-ChildItem $dest -Recurse -File).Count)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:KIMI_IDE_USERDATA = Join-Path $root '_electron-userdata-ziptest'
Remove-Item $env:KIMI_IDE_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
$app = Join-Path $dest 'Kimi C++ IDE.exe'
$outLog = Join-Path $root '_smoke-zip-stdout.log'
$errLog = Join-Path $root '_smoke-zip-stderr.log'
$proc = Start-Process -FilePath $app -ArgumentList '--no-sandbox' `
  -WorkingDirectory $dest -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Start-Sleep -Seconds 15
Write-Output ('pid=' + $proc.Id + ' alive=' + (-not $proc.HasExited))
$port = (Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort
Write-Output ('port=' + $port)
$p = Get-Process -Id $proc.Id
Write-Output ('Handle=' + $p.MainWindowHandle + " Title='" + $p.MainWindowTitle + "'")
try {
  $r = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $port + '/') -TimeoutSec 5 -UseBasicParsing
  Write-Output ('HTTP ' + $r.StatusCode + ' len=' + $r.Content.Length)
} catch {
  Write-Output ('http failed: ' + $_.Exception.Message)
}
