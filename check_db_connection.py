#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
检查数据库连接配置
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("=" * 60)
print("数据库连接检查")
print("=" * 60)
print()

# 1. 检查配置文件
print("【1. 当前配置文件】")
from config import Config

print(f"DB_HOST: {Config.DB_HOST}")
print(f"DB_PORT: {Config.DB_PORT}")
print(f"DB_USER: {Config.DB_USER}")
print(f"DB_PASSWORD: {Config.DB_PASSWORD}")
print(f"DB_NAME: {Config.DB_NAME}")
print()
print(f"完整连接串: {Config.SQLALCHEMY_DATABASE_URI}")
print()

# 2. 测试直接连接
print("【2. 测试直接数据库连接】")
import pymysql

try:
    conn = pymysql.connect(
        host=Config.DB_HOST,
        port=int(Config.DB_PORT),
        user=Config.DB_USER,
        password=Config.DB_PASSWORD,
        database=Config.DB_NAME,
        charset='utf8mb4'
    )
    
    print("✓ 数据库连接成功")
    
    cursor = conn.cursor()
    
    # 显示当前数据库
    cursor.execute("SELECT DATABASE()")
    current_db = cursor.fetchone()[0]
    print(f"  当前数据库: {current_db}")
    
    # 查询users表
    cursor.execute("SELECT COUNT(*) FROM users")
    user_count = cursor.fetchone()[0]
    print(f"  users表记录数: {user_count}")
    
    # 列出所有用户
    cursor.execute("SELECT ID, USERNAME, COMMUNITY, Role FROM users ORDER BY ID")
    users = cursor.fetchall()
    
    print()
    print("  所有用户列表:")
    print("  " + "-" * 70)
    print(f"  {'ID':<5} {'用户名':<15} {'小区':<25} {'角色':<15}")
    print("  " + "-" * 70)
    for user in users:
        print(f"  {user[0]:<5} {user[1]:<15} {user[2]:<25} {user[3]:<15}")
    print("  " + "-" * 70)
    
    cursor.close()
    conn.close()
    
except Exception as e:
    print(f"✗ 连接失败: {e}")
    import traceback
    traceback.print_exc()

print()

# 3. 检查Flask应用的数据库连接
print("【3. 检查Flask应用连接】")
from app import app, db, User

with app.app_context():
    try:
        # 获取数据库URI
        print(f"Flask使用的数据库URI:")
        print(f"  {app.config['SQLALCHEMY_DATABASE_URI']}")
        print()
        
        # 查询用户
        users = User.query.all()
        print(f"✓ Flask查询到 {len(users)} 个用户:")
        
        for user in users:
            print(f"  - {user.USERNAME} ({user.COMMUNITY})")
        
    except Exception as e:
        print(f"✗ Flask查询失败: {e}")
        import traceback
        traceback.print_exc()

print()
print("=" * 60)
print("诊断建议:")
print("=" * 60)
print()
print("如果上面两个查询结果不同，说明Flask应用和直接连接")
print("使用了不同的数据库或配置。")
print()
print("请检查:")
print("1. config.py 文件是否是最新的")
print("2. 应用是否使用了其他配置文件（如 config_local.py）")
print("3. 是否有环境变量覆盖了配置")
print()
