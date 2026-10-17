$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$app = Join-Path $root 'Kimi C++ IDE\Kimi C++ IDE.exe'
$out = Join-Path $root '_e3-out.log'
$err = Join-Path $root '_e3-err.log'
Remove-Item $out,$err -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $app -ArgumentList '--no-sandbox' `
  -WorkingDirectory (Split-Path $app) -PassThru `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden
Start-Sleep 12
Write-Output ('alive=' + (-not $p.HasExited))
