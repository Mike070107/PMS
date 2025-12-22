#!/usr/bin/env python3
"""
公寓物业收费系统 - 简化部署脚本
目标服务器: 192.168.1.251
"""

import os
import subprocess
import sys

def create_deployment_archive():
    """创建部署压缩包"""
    print("=== 创建部署压缩包 ===")
    
    # 检查是否安装了7zip
    try:
        subprocess.run(["7z"], capture_output=True)
        zip_tool = "7z"
    except:
        try:
            subprocess.run(["tar", "--version"], capture_output=True)
            zip_tool = "tar"
        except:
            print("✗ 未找到压缩工具 (7zip或tar)")
            return None
    
    # 创建压缩包
    archive_name = "wjwy_system_deploy.tar.gz"
    
    if zip_tool == "7z":
        cmd = f"7z a -ttar {archive_name} deploy_package/*"
    else:
        cmd = f"tar -czf {archive_name} -C deploy_package ."
    
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    
    if result.returncode == 0:
        print(f"✓ 部署压缩包创建完成: {archive_name}")
        return archive_name
    else:
        print(f"✗ 压缩包创建失败: {result.stderr}")
        return None

def generate_deployment_guide():
    """生成部署指南"""
    guide = """
=== 公寓物业收费系统 - 测试服务器部署指南 ===
目标服务器: 192.168.1.251

1. 准备工作
   - 确保测试服务器可以访问数据库服务器 192.168.1.250:3306
   - 确保测试服务器已安装 Python3 和 pip

2. 文件传输
   将以下文件上传到测试服务器的 /opt/wjwy_system/ 目录：
   - wjwy_system_deploy.tar.gz (部署压缩包)
   - deploy_commands.sh (部署脚本)

3. 服务器端部署命令
   # 解压部署包
   tar -xzf wjwy_system_deploy.tar.gz -C /opt/wjwy_system/
   
   # 设置权限
   chmod +x /opt/wjwy_system/start_app.sh /opt/wjwy_system/restart_app.sh
   
   # 创建虚拟环境并安装依赖
   cd /opt/wjwy_system
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   
   # 启动应用
   ./start_app.sh

4. 验证部署
   - 访问 http://192.168.1.251:5000/test 查看测试页面
   - 检查日志: tail -f /opt/wjwy_system/logs/startup.log

5. 管理命令
   - 重启应用: ./restart_app.sh
   - 停止应用: kill $(cat /opt/wjwy_system/app.pid)
   - 查看状态: ps aux | grep app.py

=== 部署完成 ===
"""
    
    with open("DEPLOYMENT_GUIDE.md", "w", encoding="utf-8") as f:
        f.write(guide)
    print("✓ 部署指南已生成: DEPLOYMENT_GUIDE.md")

def main():
    """主函数"""
    print("公寓物业收费系统 - 测试服务器部署工具")
    print("=" * 50)
    
    # 1. 创建部署压缩包
    archive = create_deployment_archive()
    if not archive:
        print("❌ 部署准备失败")
        return
    
    # 2. 生成部署指南
    generate_deployment_guide()
    
    print("\n" + "=" * 50)
    print("✅ 部署准备完成!")
    print("\n下一步操作:")
    print("1. 将 'wjwy_system_deploy.tar.gz' 上传到服务器 /opt/wjwy_system/")
    print("2. 按照 'DEPLOYMENT_GUIDE.md' 中的说明进行部署")
    print("3. 访问 http://192.168.1.251:5000 测试应用")
    print(f"\n部署包: {archive}")
    print("部署指南: DEPLOYMENT_GUIDE.md")

if __name__ == "__main__":
    main()