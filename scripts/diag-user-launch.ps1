$exe = 'C:\Users\41855\Desktop\DEEPSEEK workspace\Kimi C++ IDE\Kimi C++ IDE.exe'
Write-Output '=== MOTW streams ==='
Get-Content -Path $exe -Stream Zone.Identifier -ErrorAction SilentlyContinue
$zip = 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl\release\Kimi C++ IDE-1.0.0-windows.zip'
Get-Content -Path $zip -Stream Zone.Identifier -ErrorAction SilentlyContinue
Write-Output '=== AppLocker EXE log ==='
try {
  Get-WinEvent -LogName 'Microsoft-Windows-AppLocker/EXE and DLL' -MaxEvents 20 -ErrorAction Stop |
    Where-Object { $_.TimeCreated -gt (Get-Date).AddHours(-2) } |
    Select-Object TimeCreated,Id,LevelDisplayName,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(250,$_.Message.Length))}} |
    Format-List
} catch { Write-Output ('applocker log: ' + $_.Exception.Message) }
Write-Output '=== Defender operational (recent detections) ==='
try {
  Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=(Get-Date).AddHours(-2)} -MaxEvents 20 -ErrorAction Stop |
    Select-Object TimeCreated,Id,LevelDisplayName,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(250,$_.Message.Length))}} |
    Format-List
} catch { Write-Output ('defender log: ' + $_.Exception.Message) }
Write-Output '=== Application Error events (last 2h) ==='
Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='Application Error'; StartTime=(Get-Date).AddHours(-2)} -MaxEvents 10 -ErrorAction SilentlyContinue |
  Select-Object TimeCreated,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(250,$_.Message.Length))}} | Format-List
