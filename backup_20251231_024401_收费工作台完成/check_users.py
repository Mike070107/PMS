#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
查看数据库中的用户信息
"""

from app import app, db, User

with app.app_context():
    users = User.query.all()
    print(f"数据库中共有 {len(users)} 个用户:")
    for user in users:
        print(f"用户名: {user.USERNAME}, 角色: {user.Role}, 小区编号: {user.小区编号}")