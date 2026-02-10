#!/bin/bash
# 紧急修复脚本 - 快速解决文件描述符耗尽问题

echo "=== 紧急文件描述符修复脚本 ==="

# 1. 立即增加系统限制
echo "1. 增加临时系统限制..."
echo 1000000 > /proc/sys/fs/file-max

# 2. 增加当前会话限制
echo "2. 增加当前会话限制..."
ulimit -n 65536

# 3. 查找并杀死占用大量文件描述符的进程
echo "3. 分析文件描述符使用情况..."
echo "当前文件描述符使用统计:"
lsof | awk '{print $2}' | sort | uniq -c | sort -nr | head -20

echo "按文件类型统计:"
lsof | awk '{print $9}' | grep -o '\.[^./]*$' | sort | uniq -c | sort -nr | head -10

# 4. 清理僵尸进程
echo "4. 清理僵尸进程..."
ZOMBIE_PIDS=$(ps aux | awk '$8 ~ /^Z/ {print $2}')
if [ ! -z "$ZOMBIE_PIDS" ]; then
    echo "发现僵尸进程: $ZOMBIE_PIDS"
    for pid in $ZOMBIE_PIDS; do
        echo "杀死僵尸进程: $pid"
        kill -9 $pid 2>/dev/null
    done
fi

# 5. 重启关键服务
echo "5. 重启Web服务..."
# 根据实际情况调整服务名称
if systemctl is-active --quiet nginx; then
    echo "重启nginx..."
    systemctl restart nginx
fi

if systemctl is-active --quiet httpd; then
    echo "重启apache..."
    systemctl restart httpd
fi

# 重启您的Flask应用服务
if systemctl is-active --quiet wjwy_system; then
    echo "重启wjwy_system服务..."
    systemctl restart wjwy_system
fi

# 6. 清理临时文件
echo "6. 清理临时文件..."
find /tmp -type f -atime +1 -delete 2>/dev/null
find /var/tmp -type f -atime +1 -delete 2>/dev/null

# 7. 显示修复后的状态
echo "7. 修复后状态检查..."
echo "系统文件描述符限制: $(cat /proc/sys/fs/file-max)"
echo "当前会话限制: $(ulimit -n)"
echo "当前文件描述符使用: $(cat /proc/sys/fs/file-nr)"

echo "紧急修复完成！"
echo "建议后续运行完整的server_optimization.sh脚本进行长期优化"