@echo off
echo 正在启动Flask应用...
echo.
echo 步骤1: 连接到服务器并启动应用
echo.

REM 使用plink工具进行SSH连接（如果可用）
REM 或者使用简单的SSH命令

REM 方法1: 使用SSH密钥连接
ssh -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251 "cd /var/www/web_app && pkill -f 'python3 app.py' && source venv/bin/activate && python3 app.py"

if %errorlevel% neq 0 (
    echo SSH连接失败，请检查网络连接和服务器状态
    pause
    exit /b 1
)

echo.
echo Flask应用已启动！
echo 访问地址: http://192.168.1.251:5000/login
echo.
pause