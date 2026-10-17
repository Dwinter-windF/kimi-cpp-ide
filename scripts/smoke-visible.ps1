$root = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:KIMI_IDE_USERDATA = Join-Path $root '_electron-userdata-visible'
Remove-Item $env:KIMI_IDE_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
$app = Join-Path $root 'release\win-unpacked\Kimi C++ IDE.exe'
# 不隐藏启动：复现用户双击场景
# 重定向子进程 stdout/stderr 到文件，避免 GUI 子进程继承 Git Bash 的管道句柄导致 shell 挂起
$outLog = Join-Path $root '_smoke-app-stdout.log'
$errLog = Join-Path $root '_smoke-app-stderr.log'
$proc = Start-Process -FilePath $app -ArgumentList '--no-sandbox' `
  -WorkingDirectory (Split-Path $app) -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Start-Sleep -Seconds 15
Write-Output ("pid=" + $proc.Id + " alive=" + (-not $proc.HasExited))
$conns = Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue
$ports = @()
if ($conns) { $ports = $conns | ForEach-Object { $_.LocalPort } | Sort-Object -Unique }
Write-Output ("ports=" + ($ports -join ','))
if ($proc.HasExited) { exit }
$p = Get-Process -Id $proc.Id
Write-Output ("Handle=" + $p.MainWindowHandle + " Title='" + $p.MainWindowTitle + "'")
