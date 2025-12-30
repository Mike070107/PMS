@echo off
echo 正在连接到服务器并启动Flask应用...
echo.

REM 使用SSH密钥连接服务器并执行启动命令
ssh -o StrictHostKeyChecking=no -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251

if %errorlevel% neq 0 (
    echo SSH连接失败
    pause
    exit /b 1
)

echo 连接成功！
pause