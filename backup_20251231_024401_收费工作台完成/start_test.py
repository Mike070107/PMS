#!/usr/bin/env python3
"""
公寓物业收费系统 - 测试环境启动脚本
使用测试环境数据库IP: 192.168.1.250
"""

import os
import sys

# 添加当前目录到Python路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 设置环境变量
os.environ['FLASK_APP'] = 'app.py'
os.environ['FLASK_ENV'] = 'production'

# 导入应用
from app import app

def check_database_connection():
    """检查数据库连接"""
    try:
        with app.app_context():
            # 尝试执行简单的数据库查询来验证连接
            from app import db
            from sqlalchemy import text
            db.session.execute(text('SELECT 1'))
            print("✓ 数据库连接成功")
            return True
    except Exception as e:
        print(f"✗ 数据库连接失败: {e}")
        return False

if __name__ == '__main__':
    print("=== 公寓物业收费系统 - 测试环境 ===")
    print("数据库服务器: 192.168.1.250")
    print("数据库名称: wjwy")
    print("正在启动测试环境服务器...")
    
    # 检查数据库连接
    if check_database_connection():
        print("✓ 系统初始化完成")
        print("✓ 服务器将在 http://localhost:5000 启动")
        print("✓ 按 Ctrl+C 停止服务器")
        print("=" * 50)
        
        # 启动Flask服务器
        app.run(host='0.0.0.0', port=5000, debug=False)
    else:
        print("✗ 系统启动失败，请检查数据库连接")
        sys.exit(1)