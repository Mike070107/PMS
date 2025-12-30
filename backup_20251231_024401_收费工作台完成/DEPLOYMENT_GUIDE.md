
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
