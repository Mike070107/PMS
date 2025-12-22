#!/bin/bash
# 公寓物业收费系统 - 重启脚本 (测试服务器)

# 检查应用是否在运行
if [ -f /opt/wjwy_system/app.pid ]; then
    PID=$(cat /opt/wjwy_system/app.pid)
    if kill -0 $PID 2>/dev/null; then
        echo "正在停止应用 (PID: $PID)..."
        kill $PID
        sleep 3
        
        # 确保进程已停止
        if kill -0 $PID 2>/dev/null; then
            echo "强制停止应用..."
            kill -9 $PID
        fi
        
        # 清理PID文件
        rm -f /opt/wjwy_system/app.pid
        echo "应用已停止"
    else
        echo "应用未运行，清理PID文件..."
        rm -f /opt/wjwy_system/app.pid
    fi
else
    echo "应用未运行"
fi

# 等待进程完全停止
sleep 2

# 重新启动应用
echo "正在启动应用..."
/opt/wjwy_system/start_app.sh

echo "应用重启完成"