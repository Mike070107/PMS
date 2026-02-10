#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
快速修复登录问题脚本
用于重置用户密码为明文，方便登录
"""

import sys
import os

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

print("=" * 60)
print("登录问题快速修复工具")
print("=" * 60)
print()

# 初始化应用
try:
    from app import app, db, User
    print("✓ 应用初始化成功")
except Exception as e:
    print(f"✗ 应用初始化失败: {e}")
    sys.exit(1)

print()
print("此工具将把用户密码重置为明文密码，方便登录测试")
print()

# 列出所有用户
with app.app_context():
    try:
        users = User.query.all()
        
        if not users:
            print("✗ 数据库中没有用户")
            sys.exit(1)
        
        print("当前数据库中的用户:")
        print("-" * 80)
        print(f"{'编号':<5} {'用户名':<15} {'小区':<20} {'角色':<15}")
        print("-" * 80)
        
        for idx, user in enumerate(users, 1):
            print(f"{idx:<5} {user.USERNAME:<15} {user.COMMUNITY:<20} {user.Role:<15}")
        
        print("-" * 80)
        print()
        
        # 选择用户
        user_idx = input(f"请选择要重置密码的用户编号 (1-{len(users)}): ").strip()
        
        if not user_idx.isdigit() or int(user_idx) < 1 or int(user_idx) > len(users):
            print("✗ 无效的编号")
            sys.exit(1)
        
        selected_user = users[int(user_idx) - 1]
        
        print()
        print(f"选择的用户: {selected_user.USERNAME}")
        print()
        
        # 输入新密码
        new_password = input("请输入新密码（明文，建议先使用简单密码如 'admin' 测试）: ").strip()
        
        if not new_password:
            print("✗ 密码不能为空")
            sys.exit(1)
        
        print()
        print(f"将用户 '{selected_user.USERNAME}' 的密码设置为: {new_password}")
        confirm = input("确认执行？(y/n): ").strip().lower()
        
        if confirm != 'y':
            print("操作已取消")
            sys.exit(0)
        
        print()
        print("正在更新密码...")
        
        # 更新密码为明文
        selected_user.PWD = new_password
        db.session.commit()
        
        print(f"✓ 密码已更新为明文")
        print()
        print("=" * 60)
        print("修复完成")
        print("=" * 60)
        print()
        print("现在可以尝试使用以下信息登录:")
        print(f"  用户名: {selected_user.USERNAME}")
        print(f"  密码: {new_password}")
        print()
        print("如果登录成功，说明问题已解决")
        print("如果仍然失败，请运行诊断脚本: python diagnose_login.py")
        print()
        
    except Exception as e:
        print(f"✗ 操作失败: {e}")
        import traceback
        traceback.print_exc()
        db.session.rollback()
        sys.exit(1)
