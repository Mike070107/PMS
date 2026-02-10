#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
登录问题诊断脚本
用于排查生产环境登录失败的问题
"""

import sys
import os
from datetime import datetime

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("=" * 60)
print("登录问题诊断工具")
print("=" * 60)
print()

# 1. 检查配置文件
print("【1. 检查配置文件】")
try:
    from config import Config
    print(f"✓ 配置文件加载成功")
    print(f"  - DB_HOST: {Config.DB_HOST}")
    print(f"  - DB_PORT: {Config.DB_PORT}")
    print(f"  - DB_NAME: {Config.DB_NAME}")
    print(f"  - DB_USER: {Config.DB_USER}")
    print(f"  - SECRET_KEY前缀: {Config.SECRET_KEY[:20]}...")
except Exception as e:
    print(f"✗ 配置文件加载失败: {e}")
    sys.exit(1)

print()

# 2. 测试数据库连接
print("【2. 测试数据库连接】")
try:
    import pymysql
    
    conn = pymysql.connect(
        host=Config.DB_HOST,
        port=int(Config.DB_PORT),
        user=Config.DB_USER,
        password=Config.DB_PASSWORD,
        database=Config.DB_NAME,
        charset='utf8mb4'
    )
    print(f"✓ 数据库连接成功")
    
    # 测试查询
    cursor = conn.cursor()
    cursor.execute("SELECT VERSION()")
    version = cursor.fetchone()
    print(f"  - MySQL版本: {version[0]}")
    
    # 检查用户表
    cursor.execute("SELECT COUNT(*) FROM users")
    user_count = cursor.fetchone()[0]
    print(f"  - 用户表记录数: {user_count}")
    
    cursor.close()
    conn.close()
    
except Exception as e:
    print(f"✗ 数据库连接失败: {e}")
    print(f"  请检查:")
    print(f"  1. 数据库服务器是否启动")
    print(f"  2. IP地址 {Config.DB_HOST} 是否正确")
    print(f"  3. 防火墙是否开放 {Config.DB_PORT} 端口")
    print(f"  4. 数据库用户密码是否正确")
    sys.exit(1)

print()

# 3. 初始化Flask应用
print("【3. 初始化Flask应用】")
try:
    from app import app, db
    
    with app.app_context():
        # 测试数据库连接
        db.engine.connect()
        print(f"✓ Flask应用初始化成功")
        print(f"  - 数据库URI: {app.config['SQLALCHEMY_DATABASE_URI'][:50]}...")
        
except Exception as e:
    print(f"✗ Flask应用初始化失败: {e}")
    sys.exit(1)

print()

# 4. 检查用户数据
print("【4. 检查用户表数据】")
try:
    from app import User
    
    with app.app_context():
        users = User.query.all()
        print(f"✓ 查询到 {len(users)} 个用户")
        print()
        print("用户列表:")
        print("-" * 80)
        print(f"{'ID':<5} {'用户名':<15} {'小区':<20} {'角色':<15} {'密码类型':<15}")
        print("-" * 80)
        
        for user in users:
            # 判断密码类型
            if user.PWD.startswith(('pbkdf2:', 'scrypt:', 'bcrypt:')):
                pwd_type = "加密密码"
            else:
                pwd_type = f"明文({len(user.PWD)}字符)"
            
            print(f"{user.ID:<5} {user.USERNAME:<15} {user.COMMUNITY:<20} {user.Role:<15} {pwd_type:<15}")
        
        print("-" * 80)
        
except Exception as e:
    print(f"✗ 查询用户失败: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print()

# 5. 测试密码验证
print("【5. 测试密码验证】")
print("请输入要测试的用户名和密码")
print()

username = input("用户名: ").strip()
password = input("密码: ").strip()

if not username or not password:
    print("用户名和密码不能为空")
    sys.exit(1)

print()
print(f"测试用户: {username}")

try:
    from app import User
    from utils import verify_password
    
    with app.app_context():
        user = User.query.filter_by(USERNAME=username).first()
        
        if not user:
            print(f"✗ 用户 '{username}' 不存在")
            print()
            print("可用的用户名:")
            all_users = User.query.all()
            for u in all_users:
                print(f"  - {u.USERNAME}")
            sys.exit(1)
        
        print(f"✓ 找到用户: {user.USERNAME}")
        print(f"  - ID: {user.ID}")
        print(f"  - 小区: {user.COMMUNITY}")
        print(f"  - 角色: {user.Role}")
        print(f"  - 密码长度: {len(user.PWD)} 字符")
        print()
        
        # 判断密码类型
        stored_password = user.PWD
        
        if stored_password.startswith(('pbkdf2:', 'scrypt:', 'bcrypt:')):
            print("密码类型: 加密密码")
            print(f"加密方法: {stored_password.split(':')[0]}")
            print()
            
            # 使用加密验证
            password_valid = verify_password(stored_password, password)
            
            if password_valid:
                print("✓ 密码验证通过（加密验证）")
            else:
                print("✗ 密码验证失败（加密验证）")
                print()
                print("可能的原因:")
                print("1. 输入的密码不正确")
                print("2. 数据库中的加密密码损坏")
                print("3. 加密算法不匹配")
        else:
            print("密码类型: 明文密码")
            print()
            
            # 使用明文比对
            password_valid = (stored_password == password)
            
            if password_valid:
                print("✓ 密码验证通过（明文比对）")
            else:
                print("✗ 密码验证失败（明文比对）")
                print()
                print(f"数据库中的密码: {stored_password}")
                print(f"您输入的密码: {password}")
                print()
                print("密码不匹配，请检查:")
                print("1. 数据库中的密码是否正确")
                print("2. 输入的密码是否有多余的空格")
                print("3. 是否区分大小写")
        
        print()
        
        if password_valid:
            print("=" * 60)
            print("诊断结果: 登录功能正常")
            print("=" * 60)
            print()
            print("如果Web界面仍然提示密码错误，请检查:")
            print("1. 浏览器缓存（清除缓存后重试）")
            print("2. 网络连接（是否能访问服务器）")
            print("3. 应用日志（查看详细错误信息）")
            print()
            print("查看应用日志:")
            print("  tail -f logs/app.log.$(date +%Y-%m-%d)")
        else:
            print("=" * 60)
            print("诊断结果: 密码验证失败")
            print("=" * 60)
            print()
            print("解决方法:")
            print("1. 如果是明文密码，请在数据库中修改为正确的密码")
            print("2. 如果是加密密码，建议重置为明文密码进行测试")
            print()
            print("重置密码SQL:")
            print(f"  UPDATE users SET PWD='{password}' WHERE USERNAME='{username}';")
            
except Exception as e:
    print(f"✗ 测试失败: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print()
print("=" * 60)
print("诊断完成")
print("=" * 60)
