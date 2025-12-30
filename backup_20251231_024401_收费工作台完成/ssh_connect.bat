@echo off
set SERVER=192.168.1.251
set USER=root
set PASSWORD=abc.123

if "%~1"=="" (
    echo 用法: ssh_connect.bat "command"
    echo 示例: ssh_connect.bat "cd /var/www/web_app && ls -la"
    goto :eof
)

set COMMAND=%~1
echo %PASSWORD% | plink -ssh -pw %PASSWORD% %USER%@%SERVER% "%COMMAND%"