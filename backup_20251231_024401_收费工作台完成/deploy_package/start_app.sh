#!/bin/bash
# 公寓物业收费系统 - 启动脚本 (测试服务器)

# 设置环境变量
export FLASK_APP=app.py
export FLASK_ENV=production

# 激活虚拟环境
source /opt/wjwy_system/venv/bin/activate

# 创建日志目录
mkdir -p /opt/wjwy_system/logs

# 启动应用
echo "=== 公寓物业收费系统启动 ==="
echo "时间: $(date)"
echo "服务器: 192.168.1.251"
echo "端口: 5000"
echo "数据库: 192.168.1.250:3306"
echo "=============================="

# 使用nohup后台运行
nohup python3 app.py > /opt/wjwy_system/logs/startup.log 2>&1 &

# 记录进程ID
echo $! > /opt/wjwy_system/app.pid

echo "应用已启动，进程ID: $!"
echo "日志文件: /opt/wjwy_system/logs/startup.log"
echo "访问地址: http://192.168.1.251:5000"
echo "测试页面: http://192.168.1.251:5000/test"