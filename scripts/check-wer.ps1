Write-Output '=== Application Error / WER (last 30 min) ==='
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-30)} -MaxEvents 60 -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -in 'Application Error','Windows Error Reporting','Application Popup' } |
  Select-Object TimeCreated,ProviderName,Id,@{n='Msg';e={$_.Message.Substring(0,[Math]::Min(600,$_.Message.Length))}} |
  Format-List
Write-Output '=== WER ReportQueue new entries ==='
Get-ChildItem 'C:\ProgramData\Microsoft\Windows\WER\ReportQueue' -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) } |
  Select-Object Name,LastWriteTime | Format-List
