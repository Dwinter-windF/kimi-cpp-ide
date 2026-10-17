$ws = New-Object -ComObject WScript.Shell
$appDir = 'C:\Users\41855\Desktop\DEEPSEEK workspace\Kimi C++ IDE'
$exe = Join-Path $appDir 'Kimi C++ IDE.exe'
foreach ($lnkPath in @(
  (Join-Path $appDir 'Kimi C++ IDE.lnk'),
  'C:\Users\41855\Desktop\Kimi C++ IDE.lnk'
)) {
  $s = $ws.CreateShortcut($lnkPath)
  $s.TargetPath = $exe
  $s.Arguments = '--no-sandbox'
  $s.WorkingDirectory = $appDir
  $s.IconLocation = "$exe,0"
  $s.Description = 'Kimi C++ IDE'
  $s.Save()
  Write-Output ("created: " + $lnkPath)
}
