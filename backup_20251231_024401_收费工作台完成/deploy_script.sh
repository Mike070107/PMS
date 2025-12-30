#!/bin/bash
# 公寓物业收费系统 - 部署脚本
# 目标服务器: 192.168.1.251
# 部署目录: /var/www/web_app

echo "=== 公寓物业收费系统 - 部署到服务器 ==="
echo "目标服务器: 192.168.1.251"
echo "部署目录: /var/www/web_app"
echo "="==========================================

# 1. 检查服务器连接
echo "1. 检查服务器连接..."
ping -c 3 192.168.1.251 > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "   ✓ 服务器连接正常"
else
    echo "   ✗ 无法连接到服务器"
    exit 1
fi

# 2. 上传部署文件到服务器
echo "2. 上传部署文件到服务器..."

# 创建部署目录
sshpass -p "abc.123" ssh -o StrictHostKeyChecking=no root@192.168.1.251 "mkdir -p /var/www/web_app"

# 上传所有部署文件
for file in deploy_package/*; do
    if [ -f "$file" ]; then
        echo "   上传: $(basename $file)"
        sshpass -p "abc.123" scp -o StrictHostKeyChecking=no "$file" root@192.168.1.251:/var/www/web_app/
    fi
done

# 上传templates目录
if [ -d "deploy_package/templates" ]; then
    echo "   上传: templates目录"
    sshpass -p "abc.123" scp -o StrictHostKeyChecking=no -r deploy_package/templates root@192.168.1.251:/var/www/web_app/
fi

echo "   ✓ 文件上传完成"

# 3. 在服务器上执行部署命令
echo "3. 在服务器上执行部署..."

# 部署命令
sshpass -p "abc.123" ssh -o StrictHostKeyChecking=no root@192.168.1.251 << 'EOF'
cd /var/www/web_app

# 检查Python环境
echo "   检查Python环境..."
python3 --version

# 创建虚拟环境
echo "   创建虚拟环境..."
python3 -m venv venv

# 安装依赖
echo "   安装依赖..."
source venv/bin/activate
pip install -r requirements.txt

# 设置权限
echo "   设置权限..."
chmod +x start_app.sh restart_app.sh

# 创建日志目录
mkdir -p logs

echo "   ✓ 环境配置完成"
EOF

# 4. 启动应用
echo "4. 启动应用..."
sshpass -p "abc.123" ssh -o StrictHostKeyChecking=no root@192.168.1.251 "cd /var/www/web_app && ./start_app.sh"

# 5. 检查应用状态
echo "5. 检查应用状态..."
sleep 3

# 检查进程
sshpass -p "abc.123" ssh -o StrictHostKeyChecking=no root@192.168.1.251 "ps aux | grep app.py | grep -v grep"

# 检查端口
sshpass -p "abc.123" ssh -o StrictHostKeyChecking=no root@192.168.1.251 "netstat -tlnp | grep :5000 || echo '端口5000未监听'"

echo ""
echo "="==========================================
echo "✅ 部署完成!"
echo ""
echo "应用信息:"
echo "   访问地址: http://192.168.1.251:5000"
echo "   测试页面: http://192.168.1.251:5000/test"
echo "   部署目录: /var/www/web_app"
echo "   日志文件: /var/www/web_app/logs/startup.log"
echo ""
echo "管理命令:"
echo "   重启应用: cd /var/www/web_app && ./restart_app.sh"
echo "   停止应用: kill \$(cat /var/www/web_app/app.pid)"
echo "   查看日志: tail -f /var/www/web_app/logs/startup.log"