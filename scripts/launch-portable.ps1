$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$app = Join-Path $root 'release\Kimi C++ IDE-1.0.0-portable.exe'
$outLog = Join-Path $root '_smoke-portable-stdout.log'
$errLog = Join-Path $root '_smoke-portable-stderr.log'
Remove-Item $outLog,$errLog -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $app -ArgumentList '--no-sandbox' `
  -WorkingDirectory $root -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Output ("launcher pid=" + $proc.Id)
