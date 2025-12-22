
#!/bin/bash
# 公寓物业收费系统 - 部署命令
# 目标服务器: 192.168.1.251

# 1. 创建部署目录
mkdir -p /opt/wjwy_system
cd /opt/wjwy_system

# 2. 上传文件 (手动执行)
echo "请将deploy_package目录下的所有文件上传到/opt/wjwy_system/"

# 3. 创建Python虚拟环境
python3 -m venv venv
source venv/bin/activate

# 4. 安装依赖
pip install -r requirements.txt

# 5. 设置权限
chmod +x start_app.sh restart_app.sh

# 6. 启动应用
./start_app.sh

echo "部署完成! 应用运行在: http://192.168.1.251:5000"
