$src    = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
$dst    = 'D:\KimiData\kimi\tasks\2026-10-15\14-14-01-13777eb7\cpp-ide-app'
$bak    = 'C:\Users\41855\Desktop\DEEPSEEK workspace\backups\cpp-ide-app-backup-20261017'
$exclDirs = @('node_modules','dist','dist-server','release','workspace','cpp-ide-data','.ide-tmp','.build','.git','_backup-initial','_backup-search','_backup-viz','_tmp-bs-test','NVIDIA Corporation')

Write-Output '=== 1) backup original -> backups\cpp-ide-app-backup-20261017 ==='
$bkArgs = @($dst, $bak, '/E', '/NFL', '/NDL', '/NP', '/XF', '*.log') + (($exclDirs | ForEach-Object { '/XD' }) | ForEach-Object { $_ })
# robocopy 需要成对追加 /XD <dir>：直接构造参数数组
$bkArgs = @($dst, $bak, '/E', '/NFL', '/NDL', '/NP', '/XF', '*.log')
foreach ($d in $exclDirs) { $bkArgs += '/XD'; $bkArgs += (Join-Path $dst $d) }
& robocopy @bkArgs | Select-Object -Last 6
Write-Output ('backup exit=' + $LASTEXITCODE)

Write-Output '=== 2) sync wordhl -> original ==='
$syArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NP', '/XF', '*.log', 'PROGRESS.md') + @()
foreach ($d in $exclDirs) { $syArgs += '/XD'; $syArgs += (Join-Path $src $d) }
& robocopy @syArgs | Select-Object -Last 8
Write-Output ('sync exit=' + $LASTEXITCODE)
