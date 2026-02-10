#!/bin/bash
# MySQL Rocky Linux 9 服务器优化脚本
# 目标服务器: 192.168.110.248

echo "=== MySQL服务器优化脚本 ==="
echo "目标服务器: 192.168.110.248"
echo "操作系统: Rocky Linux 9"
echo "服务类型: MySQL数据库服务器"

# 检查当前系统状态
echo "1. 检查系统基本信息..."
hostnamectl
echo "当前用户: $(whoami)"
echo "系统时间: $(date)"

# 检查MySQL是否已安装
echo "2. 检查MySQL安装状态..."
if command -v mysql &> /dev/null; then
    echo "✓ MySQL客户端已安装"
    mysql --version
else
    echo "⚠ MySQL客户端未安装"
fi

if systemctl is-active --quiet mysqld 2>/dev/null; then
    echo "✓ MySQL服务正在运行"
    systemctl status mysqld --no-pager | head -5
else
    echo "⚠ MySQL服务未运行或未安装"
fi

# 检查当前系统限制
echo "3. 检查当前系统资源限制..."
echo "文件描述符限制:"
ulimit -Sn  # 软限制
ulimit -Hn  # 硬限制
echo "系统最大文件描述符: $(cat /proc/sys/fs/file-max)"

echo "内存信息:"
free -h

echo "CPU信息:"
nproc
lscpu | grep "Model name" | head -1

# 备份原始配置
echo "4. 备份原始配置文件..."
sudo cp /etc/security/limits.conf /etc/security/limits.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || echo "limits.conf 备份完成"

# 优化系统级配置
echo "5. 优化系统资源配置..."

# 增加文件描述符限制
echo "fs.file-max = 1000000" | sudo tee -a /etc/sysctl.conf
echo "fs.nr_open = 1048576" | sudo tee -a /etc/sysctl.conf

# 内存相关优化
cat >> /etc/sysctl.conf << EOF
# MySQL优化配置
vm.swappiness = 1
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.overcommit_memory = 1
EOF

# 应用系统配置
sudo sysctl -p

# 配置用户级限制
echo "6. 配置用户级资源限制..."
cat >> /etc/security/limits.conf << EOF
# MySQL服务器优化配置
mysql           soft    nofile          65536
mysql           hard    nofile          100000
mysql           soft    nproc           4096
mysql           hard    nproc           4096
root            soft    nofile          65536
root            hard    nofile          100000
EOF

# 配置systemd服务限制
echo "7. 配置systemd服务限制..."
sudo mkdir -p /etc/systemd/system.conf.d/
sudo mkdir -p /etc/systemd/user.conf.d/

cat > /etc/systemd/system.conf.d/mysql_limits.conf << EOF
[Manager]
DefaultLimitNOFILE=65536
DefaultLimitNOFILESoft=65536
DefaultLimitNPROC=4096
EOF

# 重启systemd
sudo systemctl daemon-reload

# MySQL配置优化（如果MySQL已安装）
if command -v mysql &> /dev/null; then
    echo "8. 优化MySQL配置..."
    
    # 备份MySQL配置文件
    if [ -f /etc/my.cnf ]; then
        sudo cp /etc/my.cnf /etc/my.cnf.backup.$(date +%Y%m%d_%H%M%S)
    fi
    
    if [ -f /etc/mysql/my.cnf ]; then
        sudo cp /etc/mysql/my.cnf /etc/mysql/my.cnf.backup.$(date +%Y%m%d_%H%M%S)
    fi
    
    # 创建优化的MySQL配置
    sudo mkdir -p /etc/mysql/conf.d/
    cat > /etc/mysql/conf.d/wjwy_optimization.cnf << EOF
# WJWY系统MySQL优化配置
[mysqld]
# 连接相关优化
max_connections = 500
max_connect_errors = 100000
back_log = 500

# 文件描述符和线程优化
open_files_limit = 65536
table_open_cache = 2000
thread_cache_size = 100
thread_stack = 512K

# 内存和缓存优化
key_buffer_size = 256M
max_heap_table_size = 64M
tmp_table_size = 64M
query_cache_type = 0
query_cache_size = 0

# InnoDB优化
innodb_buffer_pool_size = 1G
innodb_log_file_size = 256M
innodb_log_buffer_size = 16M
innodb_flush_log_at_trx_commit = 2
innodb_file_per_table = 1
innodb_flush_method = O_DIRECT

# 日志和性能优化
slow_query_log = 1
long_query_time = 2
log_error = /var/log/mysql/error.log
log_warnings = 2

# 字符集设置
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci

[mysql]
default-character-set = utf8mb4

[client]
default-character-set = utf8mb4
EOF
    
    echo "MySQL配置文件已创建: /etc/mysql/conf.d/wjwy_optimization.cnf"
    
    # 创建MySQL日志目录
    sudo mkdir -p /var/log/mysql
    sudo chown mysql:mysql /var/log/mysql
    
else
    echo "8. MySQL未安装，跳过MySQL配置优化"
    echo "请先安装MySQL后再运行优化配置"
fi

# 创建监控脚本
echo "9. 创建系统监控脚本..."
cat > /usr/local/bin/mysql_monitor.sh << 'EOF'
#!/bin/bash
# MySQL服务器监控脚本

LOG_FILE="/var/log/mysql_monitor.log"
THRESHOLD=80

while true; do
    # 系统资源监控
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo "=== $TIMESTAMP ===" >> $LOG_FILE
    
    # 文件描述符使用情况
    TOTAL_FD=$(cat /proc/sys/fs/file-max)
    USED_FD=$(cat /proc/sys/fs/file-nr | awk '{print $1}')
    FD_PERCENTAGE=$((USED_FD * 100 / TOTAL_FD))
    echo "文件描述符使用: $USED_FD/$TOTAL_FD ($FD_PERCENTAGE%)" >> $LOG_FILE
    
    # 内存使用情况
    MEMORY_INFO=$(free -h | grep Mem)
    echo "内存使用: $MEMORY_INFO" >> $LOG_FILE
    
    # MySQL进程监控（如果运行中）
    if systemctl is-active --quiet mysqld; then
        MYSQL_PID=$(pgrep mysqld | head -1)
        if [ ! -z "$MYSQL_PID" ]; then
            MYSQL_FD=$(lsof -p $MYSQL_PID | wc -l)
            echo "MySQL进程文件描述符: $MYSQL_FD" >> $LOG_FILE
            
            # MySQL状态检查
            mysql -e "SHOW STATUS LIKE 'Threads_connected';" 2>/dev/null >> $LOG_FILE
            mysql -e "SHOW STATUS LIKE 'Max_used_connections';" 2>/dev/null >> $LOG_FILE
        fi
    fi
    
    # 告警检查
    if [ $FD_PERCENTAGE -gt $THRESHOLD ]; then
        echo "⚠ WARNING: 文件描述符使用率过高: $FD_PERCENTAGE%" >> $LOG_FILE
    fi
    
    sleep 300  # 每5分钟检查一次
done
EOF

chmod +x /usr/local/bin/mysql_monitor.sh

# 创建清理脚本
echo "10. 创建资源清理脚本..."
cat > /usr/local/bin/mysql_cleanup.sh << 'EOF'
#!/bin/bash
# MySQL服务器清理脚本

# 清理慢查询日志（保留7天）
find /var/log/mysql/ -name "slow.log*" -mtime +7 -delete 2>/dev/null

# 清理错误日志（保留30天）
find /var/log/mysql/ -name "error.log*" -mtime +30 -delete 2>/dev/null

# 清理临时文件
find /tmp -name "*.sql" -mtime +1 -delete 2>/dev/null

# 优化MySQL表
mysql -e "SELECT CONCAT('OPTIMIZE TABLE ', table_schema, '.', table_name, ';') 
          FROM information_schema.tables 
          WHERE table_schema = 'wjwy' 
          AND data_free > 0;" 2>/dev/null | mysql

echo "清理完成: $(date)" >> /var/log/mysql_cleanup.log
EOF

chmod +x /usr/local/bin/mysql_cleanup.sh

# 设置定时任务
echo "11. 配置定时任务..."
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/mysql_cleanup.sh") | crontab -
(crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/mysql_monitor.sh") | crontab -

echo "12. 优化完成！"
echo ""
echo "请执行以下操作："
echo "1. 如果MySQL已安装，重启MySQL服务："
echo "   sudo systemctl restart mysqld"
echo "2. 验证配置："
echo "   ulimit -n"
echo "   cat /proc/sys/fs/file-max"
echo "3. 检查MySQL状态："
echo "   systemctl status mysqld"
echo "   mysql -e \"SHOW VARIABLES LIKE 'max_connections';\""
echo ""
echo "监控日志位置："
echo "- 系统监控: /var/log/mysql_monitor.log"
echo "- 清理日志: /var/log/mysql_cleanup.log"
echo "- MySQL错误日志: /var/log/mysql/error.log"