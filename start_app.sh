#!/bin/bash

# 进入应用目录
cd /var/www/web_app

# 激活虚拟环境
source venv/bin/activate

# 停止已存在的进程
pkill -f "python3 app.py"

# 等待1秒
sleep 1

# 启动Flask应用
echo "正在启动物业收费系统..."
nohup python3 app.py > app.log 2>&1 &

# 检查是否启动成功
sleep 2
if ps aux | grep -q "python3 app.py" | grep -v grep; then
    echo "✓ 系统启动成功！"
    echo "日志文件: /var/www/web_app/app.log"
    echo "访问地址: http://$(hostname -I | awk '{print $1}'):5001"
else
    echo "✗ 系统启动失败，请检查日志"
    echo "查看日志: tail -50 /var/www/web_app/app.log"
fi
