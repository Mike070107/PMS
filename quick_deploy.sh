#!/bin/bash
# 快速部署脚本 - 适用于 Rocky Linux 9

echo "公寓物业收费系统 - 快速部署脚本"
echo "=================================="

# 检查是否在虚拟环境中
if [[ "$VIRTUAL_ENV" == "" ]]; then
    echo "⚠️  警告: 未检测到虚拟环境，建议先激活虚拟环境"
    read -p "是否继续? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo "📦 正在安装项目依赖..."
pip install -r requirements.txt

if [ $? -eq 0 ]; then
    echo "✅ 依赖安装成功"
else
    echo "❌ 依赖安装失败"
    exit 1
fi

echo "🔧 检查配置文件..."
if [ ! -f "config.py" ]; then
    echo "❌ config.py 不存在，正在从 deploy_package 复制"
    if [ -f "deploy_package/config.py" ]; then
        cp deploy_package/config.py .
        echo "✅ config.py 已复制"
    else
        echo "❌ deploy_package/config.py 也不存在"
        exit 1
    fi
fi

echo "📋 检查应用文件..."
if [ ! -f "app.py" ]; then
    echo "❌ app.py 不存在，正在从 deploy_package 复制"
    if [ -f "deploy_package/app.py" ]; then
        cp deploy_package/app.py .
        echo "✅ app.py 已复制"
    else
        echo "❌ deploy_package/app.py 也不存在"
        exit 1
    fi
fi

echo "📁 检查必要目录..."
DIRECTORIES=("templates" "static")
for dir in "${DIRECTORIES[@]}"; do
    if [ ! -d "$dir" ]; then
        echo "❌ $dir 目录不存在，正在从 deploy_package 复制"
        if [ -d "deploy_package/$dir" ]; then
            cp -r deploy_package/$dir .
            echo "✅ $dir 目录已复制"
        else
            echo "❌ deploy_package/$dir 也不存在"
        fi
    fi
done

echo ""
echo "🎉 部署准备完成!"
echo "💡 下一步操作:"
echo "   1. 检查并修改 config.py 中的数据库配置 (DB_HOST, DB_USER, DB_PASSWORD)"
echo "   2. 启动应用: python app.py"
echo "   3. 或后台运行: nohup python app.py > app.log 2>&1 &"