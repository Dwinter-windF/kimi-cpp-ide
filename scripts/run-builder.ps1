$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:DEBUG = 'electron-builder'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
Set-Location 'C:\Users\41855\Desktop\DEEPSEEK workspace\cpp-ide-app-wordhl'
& 'C:\Program Files\nodejs\node.exe' node_modules\electron-builder\out\cli\cli.js --win 2>&1 | Out-String | Out-File -Encoding utf8 _electron-builder.log
Write-Output BUILDER_EXITED
