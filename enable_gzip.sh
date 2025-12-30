#!/bin/bash
# 快速启用 Gzip 压缩 - 在生产服务器上执行
# 使用方法：bash enable_gzip.sh

set -e

echo "========================================="
echo "启用 Gzip 压缩优化"
echo "========================================="
echo ""

# 1. 检查当前目录
echo ">>> 步骤 1/4: 检查环境..."
if [ ! -f "app.py" ]; then
    echo "❌ 错误：请在项目根目录下执行此脚本"
    exit 1
fi
echo "✓ 当前目录正确"

# 2. 安装 flask-compress
echo ""
echo ">>> 步骤 2/4: 安装 flask-compress..."
pip3 install flask-compress==1.15

# 检查安装
if pip3 list | grep -q flask-compress; then
    echo "✓ flask-compress 安装成功"
else
    echo "❌ 安装失败"
    exit 1
fi

# 3. 检查代码配置
echo ""
echo ">>> 步骤 3/4: 检查代码配置..."
if grep -q "from flask_compress import Compress" app.py; then
    echo "✓ 代码已包含 Gzip 配置"
else
    echo "⚠️  警告：app.py 中未找到 Compress 导入"
    echo "   请确保您已更新代码"
fi

# 4. 重启应用
echo ""
echo ">>> 步骤 4/4: 重启应用..."

# 检测启动方式并重启
if systemctl list-units --type=service | grep -q wjwy; then
    echo "   检测到 systemd 服务，使用 systemctl 重启..."
    sudo systemctl restart wjwy
    sleep 2
    sudo systemctl status wjwy --no-pager
elif [ -f "restart_app.sh" ]; then
    echo "   使用 restart_app.sh 重启..."
    ./restart_app.sh
else
    echo "   手动重启进程..."
    pkill -f "python.*app.py" || true
    sleep 1
    nohup python3 app.py > logs/app_output.log 2>&1 &
    echo "   应用已在后台启动"
fi

echo ""
echo "========================================="
echo "✅ Gzip 压缩已启用！"
echo "========================================="
echo ""
echo "验证方法："
echo "  1. 打开浏览器开发者工具 (F12)"
echo "  2. 进入 Network 面板"
echo "  3. 刷新页面，查看任意 JS/CSS 文件"
echo "  4. 响应头应包含: Content-Encoding: gzip"
echo ""
echo "预期效果："
echo "  • 文件传输大小减少 60-80%"
echo "  • 加载时间减少 60-70%"
echo "  • 带宽占用大幅降低"
echo ""
