# SSH连接脚本 - 自动处理密码
param(
    [string]$Command = ""
)

$Server = "192.168.1.251"
$User = "root"
$Password = "abc.123"

# 创建临时脚本来处理SSH连接
$tempScript = @"
@echo off
echo $Password | ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=yes $User@$Server "$Command"
"@

$tempFile = [System.IO.Path]::GetTempFileName()
$tempBatFile = $tempFile -replace '\.tmp$', '.bat'
$tempScript | Out-File -FilePath $tempBatFile -Encoding ASCII

try {
    & cmd /c $tempBatFile
} finally {
    if (Test-Path $tempBatFile) {
        Remove-Item $tempBatFile -Force
    }
    if (Test-Path $tempFile) {
        Remove-Item $tempFile -Force
    }
}