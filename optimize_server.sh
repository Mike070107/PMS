#!/bin/bash
# Rocky Linux 9 服务器优化脚本
# 解决 "Too many open files" 错误

echo "=== 开始优化 Rocky Linux 9 服务器配置 ==="

# 1. 检查当前文件描述符限制
echo "当前系统文件描述符限制:"
ulimit -n
echo "当前系统最大文件描述符:"
cat /proc/sys/fs/file-max

# 2. 临时调整当前会话限制
echo "调整当前会话文件描述符限制..."
ulimit -n 65536
echo "当前会话限制已调整为: $(ulimit -n)"

# 3. 永久修改系统级限制
echo "修改系统级文件描述符限制..."

# 备份原配置文件
cp /etc/security/limits.conf /etc/security/limits.conf.backup.$(date +%Y%m%d_%H%M%S)

# 添加文件描述符限制配置
cat >> /etc/security/limits.conf << EOF

# WJWY系统文件描述符优化
*               soft    nofile          65536
*               hard    nofile          65536
root            soft    nofile          65536
root            hard    nofile          65536

EOF

# 4. 修改系统级限制
echo "修改系统级文件描述符最大值..."
echo "fs.file-max = 100000" >> /etc/sysctl.conf
sysctl -p

# 5. 优化 systemd 服务配置
echo "优化 systemd 服务文件描述符限制..."

# 备份原服务文件
cp /etc/systemd/system/wjwy_system.service /etc/systemd/system/wjwy_system.service.backup.$(date +%Y%m%d_%H%M%S)

# 更新服务配置
cat > /etc/systemd/system/wjwy_system.service << EOF
[Unit]
Description=WJWY Property Management System
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/var/www/web_app
Environment=PATH=/var/www/web_app/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/var/www/web_app/venv/bin/python3 /var/www/web_app/app.py
ExecReload=/bin/kill -HUP \$MAINPID
KillMode=process
Restart=on-failure
RestartSec=5

# 环境变量
Environment=FLASK_APP=app.py
Environment=FLASK_ENV=production

# 资源限制优化
LimitNOFILE=65536
LimitNPROC=32768

# 标准输出和错误输出
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wjwy_system

# 安全设置
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/www/web_app/logs

[Install]
WantedBy=multi-user.target
EOF

# 6. 重新加载 systemd 配置
echo "重新加载 systemd 配置..."
systemctl daemon-reload

# 7. 重启服务
echo "重启 WJWY 服务..."
systemctl restart wjwy_system

# 8. 验证配置
echo "验证配置结果:"
echo "服务状态: $(systemctl is-active wjwy_system)"
echo "文件描述符限制: $(cat /proc/$(systemctl show --property MainPID --value wjwy_system)/limits | grep 'Max open files')"

echo "=== 服务器优化完成 ==="
echo "请重新登录终端以使用户级限制生效"