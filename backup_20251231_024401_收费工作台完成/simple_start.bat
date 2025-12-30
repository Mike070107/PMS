@echo off
echo 正在启动Flask应用...
echo.
echo 使用以下命令启动应用:
echo ssh -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251 "cd /var/www/web_app && pkill -f 'python3 app.py' && source venv/bin/activate && python3 app.py"
echo.
echo 请手动输入密码: abc.123
echo.
pause