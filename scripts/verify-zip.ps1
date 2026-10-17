$zip = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl\release\Kimi C++ IDE-1.0.0-windows.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($zip)
$e = $z.Entries | Where-Object { $_.FullName -like '*main.cjs*' }
Write-Output ('entries: ' + ($e | ForEach-Object { $_.FullName }))
if ($e) {
  $r = New-Object System.IO.StreamReader($e[0].Open())
  $c = $r.ReadToEnd()
  $r.Close()
  Write-Output ('appendSwitch: ' + $c.Contains('appendSwitch'))
  Write-Output ('ide-data: ' + $c.Contains('ide-data'))
  Write-Output ('exe-adjacent default: ' + $c.Contains('process.execPath'))
}
$z.Dispose()
