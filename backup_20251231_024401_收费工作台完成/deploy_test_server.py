#!/usr/bin/env python3
"""
公寓物业收费系统 - 测试服务器部署脚本
目标服务器: 192.168.1.251
"""

import os
import sys
import subprocess
import shutil
from datetime import datetime

def create_deployment_package():
    """创建部署包"""
    print("=== 创建部署包 ===")
    
    # 创建临时部署目录
    deploy_dir = "deploy_package"
    if os.path.exists(deploy_dir):
        shutil.rmtree(deploy_dir)
    os.makedirs(deploy_dir)
    
    # 需要复制的文件列表
    files_to_copy = [
        "app.py",
        "config.py", 
        "utils.py",
        "requirements.txt",
        "deploy_config.py",
        "start_app.sh",
        "restart_app.sh"
    ]
    
    # 复制文件
    for file in files_to_copy:
        if os.path.exists(file):
            shutil.copy2(file, os.path.join(deploy_dir, file))
            print(f"✓ 复制文件: {file}")
    
    # 复制templates目录
    if os.path.exists("templates"):
        shutil.copytree("templates", os.path.join(deploy_dir, "templates"))
        print("✓ 复制目录: templates")
    
    # 创建logs目录
    os.makedirs(os.path.join(deploy_dir, "logs"), exist_ok=True)
    
    print(f"✓ 部署包创建完成: {deploy_dir}")
    return deploy_dir

def test_server_connection():
    """测试服务器连接"""
    print("\n=== 测试服务器连接 ===")
    
    # 测试网络连通性
    result = subprocess.run(["ping", "-n", "3", "192.168.1.251"], 
                          capture_output=True, text=True)
    
    if result.returncode == 0:
        print("✓ 服务器连接正常")
        return True
    else:
        print("✗ 无法连接到服务器")
        return False

def generate_deployment_commands():
    """生成部署命令"""
    commands = """
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
"""
    
    with open("deploy_commands.sh", "w", encoding="utf-8") as f:
        f.write(commands)
    print("✓ 部署命令文件已生成: deploy_commands.sh")

def main():
    """主函数"""
    print("公寓物业收费系统 - 测试服务器部署工具")
    print("=" * 50)
    
    # 1. 测试服务器连接
    if not test_server_connection():
        print("\n❌ 部署失败: 无法连接到测试服务器")
        return
    
    # 2. 创建部署包
    deploy_dir = create_deployment_package()
    
    # 3. 生成部署命令
    generate_deployment_commands()
    
    print("\n" + "=" * 50)
    print("✅ 部署准备完成!")
    print("\n下一步操作:")
    print("1. 将 'deploy_package' 目录上传到服务器 /opt/wjwy_system/")
    print("2. 在服务器上执行 'deploy_commands.sh'")
    print("3. 访问 http://192.168.1.251:5000 测试应用")
    print(f"\n部署包位置: {deploy_dir}")
    print("部署命令文件: deploy_commands.sh")

if __name__ == "__main__":
    main()