@echo off
echo ========================================
echo   公寓物业收费系统 - 启动脚本
echo ========================================
echo.
echo 服务器: 192.168.1.251
echo 应用目录: /var/www/web_app
echo 访问地址: http://192.168.1.251:5000/login
echo.
echo 步骤1: 检查服务器连接
echo.
ping -n 3 192.168.1.251 > nul
if %errorlevel% neq 0 (
    echo 错误: 无法连接到服务器 192.168.1.251
    pause
    exit /b 1
)
echo ✓ 服务器连接正常

echo.
echo 步骤2: 启动Flask应用
echo.
echo 请手动执行以下命令:
echo ssh -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251
echo 密码: abc.123
echo.
echo 进入服务器后执行:
echo cd /var/www/web_app
echo pkill -f "python3 app.py"
echo source venv/bin/activate
echo python3 app.py
echo.
echo 步骤3: 测试网页访问
echo.
echo 请打开浏览器访问: http://192.168.1.251:5000/login
echo.
pause