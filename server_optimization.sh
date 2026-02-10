#!/bin/bash
# Rocky Linux 9 服务器优化脚本
# 解决 "Too many open files" 错误

echo "=== Rocky Linux 9 服务器优化脚本 ==="
echo "目标：解决文件描述符耗尽问题"

# 检查当前系统限制
echo "1. 检查当前系统文件描述符限制："
echo "当前shell限制："
ulimit -Sn  # 软限制
ulimit -Hn  # 硬限制

echo "系统级限制："
cat /proc/sys/fs/file-max

echo "当前已使用文件描述符："
cat /proc/sys/fs/file-nr

# 备份原始配置文件
echo "2. 备份原始配置文件..."
sudo cp /etc/security/limits.conf /etc/security/limits.conf.backup.$(date +%Y%m%d_%H%M%S)
sudo cp /etc/systemd/system.conf /etc/systemd/system.conf.backup.$(date +%Y%m%d_%H%M%S)
sudo cp /etc/systemd/user.conf /etc/systemd/user.conf.backup.$(date +%Y%m%d_%H%M%S)

# 增加系统级文件描述符限制
echo "3. 增加系统级文件描述符限制..."
echo "fs.file-max = 1000000" | sudo tee -a /etc/sysctl.conf

# 配置用户级限制
echo "4. 配置用户级文件描述符限制..."
cat >> /etc/security/limits.conf << EOF
# WJWY系统文件描述符优化
*               soft    nofile          65536
*               hard    nofile          100000
root            soft    nofile          65536
root            hard    nofile          100000
nginx           soft    nofile          65536
nginx           hard    nofile          100000
www-data        soft    nofile          65536
www-data        hard    nofile          100000
EOF

# 配置systemd服务限制
echo "5. 配置systemd服务文件描述符限制..."
sudo mkdir -p /etc/systemd/system.conf.d/
sudo mkdir -p /etc/systemd/user.conf.d/

cat > /etc/systemd/system.conf.d/limits.conf << EOF
[Manager]
DefaultLimitNOFILE=65536
DefaultLimitNOFILESoft=65536
EOF

cat > /etc/systemd/user.conf.d/limits.conf << EOF
[Manager]
DefaultLimitNOFILE=65536
DefaultLimitNOFILESoft=65536
EOF

# 应用系统配置
echo "6. 应用系统配置..."
sudo sysctl -p

# 重启systemd以应用新限制
echo "7. 重启systemd管理器..."
sudo systemctl daemon-reload

# 检查nginx配置（如果存在）
if command -v nginx &> /dev/null; then
    echo "8. 检查并优化nginx配置..."
    if [ -f /etc/nginx/nginx.conf ]; then
        sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup.$(date +%Y%m%d_%H%M%S)
        # 在nginx配置中添加worker_rlimit_nofile
        if ! grep -q "worker_rlimit_nofile" /etc/nginx/nginx.conf; then
            sudo sed -i '/events {/i worker_rlimit_nofile 65536;' /etc/nginx/nginx.conf
        fi
        # 增加worker_connections
        sudo sed -i 's/worker_connections.*/worker_connections 4096;/' /etc/nginx/nginx.conf
    fi
fi

# 创建监控脚本
echo "9. 创建文件描述符监控脚本..."
cat > /usr/local/bin/monitor_fd.sh << 'EOF'
#!/bin/bash
# 文件描述符监控脚本

LOG_FILE="/var/log/fd_monitor.log"
THRESHOLD=80  # 80%使用率告警

while true; do
    # 获取系统信息
    TOTAL_FD=$(cat /proc/sys/fs/file-max)
    USED_FD=$(cat /proc/sys/fs/file-nr | awk '{print $1}')
    PERCENTAGE=$((USED_FD * 100 / TOTAL_FD))
    
    # 记录当前使用情况
    echo "$(date): Used: $USED_FD / $TOTAL_FD ($PERCENTAGE%)" >> $LOG_FILE
    
    # 检查是否超过阈值
    if [ $PERCENTAGE -gt $THRESHOLD ]; then
        echo "$(date): WARNING - File descriptor usage is ${PERCENTAGE}%!" >> $LOG_FILE
        # 可以在这里添加告警通知逻辑
        # 例如：发送邮件、微信告警等
    fi
    
    # 检查特定进程的文件描述符使用情况
    if command -v lsof &> /dev/null; then
        echo "$(date): Top 10 processes by FD usage:" >> $LOG_FILE
        lsof | awk '{print $2}' | sort | uniq -c | sort -nr | head -10 >> $LOG_FILE
    fi
    
    sleep 300  # 每5分钟检查一次
done
EOF

chmod +x /usr/local/bin/monitor_fd.sh

# 创建清理脚本
echo "10. 创建文件描述符清理脚本..."
cat > /usr/local/bin/cleanup_fd.sh << 'EOF'
#!/bin/bash
# 文件描述符清理脚本

# 清理僵尸进程
pkill -9 -f "defunct"

# 清理长时间未活动的连接
if command -v ss &> /dev/null; then
    # 显示连接状态统计
    echo "Connection statistics:"
    ss -s
    
    # 可以添加连接清理逻辑
    # 例如：清理TIME_WAIT状态过多的连接
fi

# 重启服务（谨慎使用）
# systemctl restart your_service_name
EOF

chmod +x /usr/local/bin/cleanup_fd.sh

echo "11. 优化完成！"
echo ""
echo "请执行以下操作："
echo "1. 重新登录系统使用户限制生效"
echo "2. 重启相关服务："
echo "   sudo systemctl restart your_web_service"
echo "   sudo systemctl restart nginx  # 如果使用nginx"
echo "3. 启动监控脚本："
echo "   nohup /usr/local/bin/monitor_fd.sh > /dev/null 2>&1 &"
echo ""
echo "验证新限制："
echo "ulimit -n  # 应该显示65536"
echo "cat /proc/sys/fs/file-max  # 应该显示1000000"