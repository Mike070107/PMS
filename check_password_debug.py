#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
明文密码验证调试脚本
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("=" * 60)
print("明文密码验证调试")
print("=" * 60)
print()

# 初始化应用
from app import app, db, User

print("请输入登录信息:")
username = input("用户名: ").strip()
password = input("密码: ").strip()

print()
print("=" * 60)

with app.app_context():
    # 查询用户
    user = User.query.filter_by(USERNAME=username).first()
    
    if not user:
        print(f"✗ 用户 '{username}' 不存在")
        print()
        print("数据库中的用户列表:")
        all_users = User.query.all()
        for u in all_users:
            print(f"  - {u.USERNAME}")
        sys.exit(1)
    
    print(f"✓ 找到用户: {user.USERNAME}")
    print()
    
    # 显示密码信息
    stored_pwd = user.PWD
    input_pwd = password
    
    print("密码对比:")
    print("-" * 60)
    print(f"数据库中的密码: '{stored_pwd}'")
    print(f"数据库密码长度: {len(stored_pwd)} 字符")
    print(f"数据库密码HEX: {stored_pwd.encode().hex()}")
    print()
    print(f"您输入的密码: '{input_pwd}'")
    print(f"输入密码长度: {len(input_pwd)} 字符")
    print(f"输入密码HEX: {input_pwd.encode().hex()}")
    print("-" * 60)
    print()
    
    # 检查是否完全相同
    if stored_pwd == input_pwd:
        print("✓ 密码匹配成功！")
        print()
        print("如果网站登录还是失败，请检查:")
        print("1. 浏览器是否清除了缓存")
        print("2. 应用是否重启")
        print("3. 查看应用日志: tail -f logs/app.log.$(date +%Y-%m-%d)")
    else:
        print("✗ 密码不匹配！")
        print()
        
        # 详细对比
        print("字符逐位对比:")
        max_len = max(len(stored_pwd), len(input_pwd))
        for i in range(max_len):
            db_char = stored_pwd[i] if i < len(stored_pwd) else '(无)'
            in_char = input_pwd[i] if i < len(input_pwd) else '(无)'
            match = '✓' if db_char == in_char else '✗'
            print(f"  位置 {i}: 数据库='{db_char}' vs 输入='{in_char}' {match}")
        
        print()
        print("可能的原因:")
        
        # 检查空格
        if stored_pwd.strip() == input_pwd or stored_pwd == input_pwd.strip():
            print("✗ 密码中包含多余的空格")
            print(f"  建议修改数据库密码为: '{input_pwd}'")
            print()
            fix = input("是否立即修复？(y/n): ").strip().lower()
            if fix == 'y':
                user.PWD = input_pwd
                db.session.commit()
                print("✓ 密码已修复，请重新登录")
        
        # 检查加密前缀
        elif stored_pwd.startswith(('scrypt:', 'pbkdf2:', 'bcrypt:')):
            print("✗ 数据库中的密码是加密的，不是明文")
            print(f"  密码格式: {stored_pwd[:20]}...")
            print()
            fix = input(f"是否将密码改为明文 '{input_pwd}'？(y/n): ").strip().lower()
            if fix == 'y':
                user.PWD = input_pwd
                db.session.commit()
                print("✓ 密码已改为明文，请重新登录")
        
        else:
            print("✗ 密码内容不同")
            print()
            print("建议操作:")
            print("1. 直接在数据库中修改密码:")
            print(f"   UPDATE users SET PWD='{input_pwd}' WHERE USERNAME='{username}';")
            print()
            fix = input(f"是否将密码改为 '{input_pwd}'？(y/n): ").strip().lower()
            if fix == 'y':
                user.PWD = input_pwd
                db.session.commit()
                print("✓ 密码已更新，请重新登录")

print()
print("=" * 60)
