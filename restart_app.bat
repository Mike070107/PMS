@echo off
echo ========================================
echo   重启Flask应用 - 排序BUG修复
echo ========================================
echo.
echo 步骤1: 停止当前运行的Flask应用
echo.
ssh -o StrictHostKeyChecking=no -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251 "cd /var/www/web_app && pkill -f 'python3 app.py'"
if %errorlevel% neq 0 (
    echo 警告: 停止应用失败（可能应用未运行）
)

echo.
echo 步骤2: 启动Flask应用
echo.
echo 请手动执行以下命令:
echo ssh -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251
echo 密码: abc.123
echo.
echo 进入服务器后执行:
echo cd /var/www/web_app
echo source venv/bin/activate
echo python3 app.py
echo.
echo 步骤3: 测试排序修复
echo.
echo 请打开浏览器访问: http://192.168.1.251:5000/login
echo 检查楼栋下拉选框的排序是否正确（1,2,3...10,11...）
echo.
pause