#!/usr/bin/env python3
"""
公寓物业收费系统 - 本地开发启动脚本
"""

import os
import sys

# 添加当前目录到Python路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 设置环境变量
os.environ['FLASK_APP'] = 'app.py'
os.environ['FLASK_ENV'] = 'development'

# 导入应用
from app import app, db

def init_database():
    """初始化数据库"""
    try:
        # 创建所有表
        with app.app_context():
            db.create_all()
            print("✓ 数据库表创建成功")
            
            # 检查是否有默认数据需要创建
            from app import User
            
            # 创建默认管理员用户（如果不存在）
            admin_user = User.query.filter_by(USERNAME='admin').first()
            if not admin_user:
                admin_user = User(
                    USERNAME='admin',
                    PWD='admin123',  # 注意：实际应用中应该加密
                    用户姓名='系统管理员',
                    COMMUNITY='默认小区',
                    小区编号=1,
                    Role='admin',
                    Edit=True,
                    Read=True,
                    Report=True
                )
                db.session.add(admin_user)
                db.session.commit()
                print("✓ 默认管理员用户创建成功 (用户名: admin, 密码: admin123)")
                
    except Exception as e:
        print(f"✗ 数据库初始化失败: {e}")
        return False
    
    return True

if __name__ == '__main__':
    print("=== 公寓物业收费系统 - 本地开发环境 ===")
    print("正在启动本地开发服务器...")
    
    # 初始化数据库
    if init_database():
        print("✓ 系统初始化完成")
        print("✓ 服务器将在 http://localhost:5000 启动")
        print("✓ 按 Ctrl+C 停止服务器")
        print("=" * 50)
        
        # 启动Flask开发服务器
        app.run(host='0.0.0.0', port=5000, debug=True)
    else:
        print("✗ 系统启动失败，请检查错误信息")
        sys.exit(1)