#!/usr/bin/env python3
"""
公寓物业收费系统 - SSH自动部署脚本
目标服务器: 192.168.1.251
"""

import os
import paramiko
import time
from scp import SCPClient

def create_ssh_client(server, port, username, password):
    """创建SSH客户端"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(server, port, username, password)
        print(f"✓ SSH连接成功: {username}@{server}:{port}")
        return client
    except Exception as e:
        print(f"✗ SSH连接失败: {str(e)}")
        return None

def deploy_to_server():
    """部署到测试服务器"""
    print("=== 公寓物业收费系统 - SSH自动部署 ===")
    print("目标服务器: 192.168.1.251")
    print("=" * 50)
    
    # SSH连接信息 (需要您提供)
    server = "192.168.1.251"
    port = 22
    username = input("请输入服务器用户名: ").strip()
    password = input("请输入服务器密码: ").strip()
    
    # 创建SSH连接
    ssh = create_ssh_client(server, port, username, password)
    if not ssh:
        print("❌ 部署失败: 无法连接到服务器")
        return
    
    try:
        # 1. 检查部署目录
        print("\n1. 检查部署目录...")
        deploy_dir = "/opt/wjwy_system"
        
        stdin, stdout, stderr = ssh.exec_command(f"sudo mkdir -p {deploy_dir}")
        stdin.write(password + '\n')
        stdin.flush()
        time.sleep(1)
        
        # 2. 上传部署包
        print("2. 上传部署包...")
        
        # 使用SCP传输文件
        with SCPClient(ssh.get_transport()) as scp:
            # 上传所有文件
            local_dir = "deploy_package"
            for root, dirs, files in os.walk(local_dir):
                for file in files:
                    local_path = os.path.join(root, file)
                    # 计算远程路径
                    relative_path = os.path.relpath(local_path, local_dir)
                    remote_path = os.path.join(deploy_dir, relative_path)
                    
                    # 确保远程目录存在
                    remote_dir = os.path.dirname(remote_path)
                    ssh.exec_command(f"sudo mkdir -p {remote_dir}")
                    
                    # 上传文件
                    scp.put(local_path, remote_path)
                    print(f"   ✓ 上传: {file}")
        
        # 3. 设置文件权限
        print("3. 设置文件权限...")
        ssh.exec_command(f"sudo chown -R {username}:{username} {deploy_dir}")
        ssh.exec_command(f"sudo chmod +x {deploy_dir}/start_app.sh {deploy_dir}/restart_app.sh")
        
        # 4. 检查Python环境
        print("4. 检查Python环境...")
        stdin, stdout, stderr = ssh.exec_command("python3 --version")
        python_version = stdout.read().decode().strip()
        print(f"   {python_version}")
        
        # 5. 创建虚拟环境
        print("5. 创建虚拟环境...")
        commands = [
            f"cd {deploy_dir}",
            "python3 -m venv venv",
            "source venv/bin/activate",
            "pip install -r requirements.txt"
        ]
        
        for cmd in commands:
            stdin, stdout, stderr = ssh.exec_command(cmd)
            output = stdout.read().decode()
            error = stderr.read().decode()
            
            if "venv" in cmd:
                print("   ✓ 虚拟环境创建完成")
            elif "pip install" in cmd:
                print("   ✓ 依赖安装完成")
        
        # 6. 启动应用
        print("6. 启动应用...")
        stdin, stdout, stderr = ssh.exec_command(f"cd {deploy_dir} && ./start_app.sh")
        output = stdout.read().decode()
        error = stderr.read().decode()
        
        if "应用已启动" in output:
            print("   ✓ 应用启动成功")
        else:
            print(f"   ⚠ 启动输出: {output}")
        
        # 7. 检查应用状态
        print("7. 检查应用状态...")
        time.sleep(3)  # 等待应用启动
        stdin, stdout, stderr = ssh.exec_command("ps aux | grep python3 | grep app.py")
        processes = stdout.read().decode()
        
        if "app.py" in processes:
            print("   ✓ 应用进程运行正常")
        else:
            print("   ⚠ 未找到应用进程")
        
        print("\n" + "=" * 50)
        print("✅ 部署完成!")
        print(f"应用地址: http://{server}:5000")
        print(f"测试页面: http://{server}:5000/test")
        print("\n部署目录: /opt/wjwy_system")
        print("日志文件: /opt/wjwy_system/logs/startup.log")
        
    except Exception as e:
        print(f"❌ 部署过程中发生错误: {str(e)}")
    finally:
        ssh.close()

def main():
    """主函数"""
    try:
        deploy_to_server()
    except KeyboardInterrupt:
        print("\n\n部署已取消")
    except Exception as e:
        print(f"\n❌ 部署失败: {str(e)}")

if __name__ == "__main__":
    main()