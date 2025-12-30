#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""测试日志插入功能"""

from app import app, db, OperationLog, User
from datetime import datetime

with app.app_context():
    try:
        # 模拟创建一条日志
        user = User.query.first()
        
        if not user:
            print("✗ 数据库中没有用户")
        else:
            print(f"✓ 找到用户: {user.USERNAME}")
            
            log = OperationLog()
            log.操作时间 = datetime.now()
            log.用户ID = user.ID
            log.用户账号 = user.USERNAME
            log.用户姓名 = user.用户姓名 or user.USERNAME
            log.用户角色 = user.Role
            log.所属小区 = user.COMMUNITY or ''
            log.小区编号 = user.小区编号
            log.电脑IP = '127.0.0.1'
            log.MAC地址 = 'test-mac'
            log.用户代理 = 'test-agent'
            log.操作类型 = '测试登录'
            log.操作模块 = '系统登录'
            log.操作详情 = '这是一条测试日志'
            log.操作结果 = 'success'
            log.请求方法 = 'POST'
            log.请求URL = '/api/login'
            
            db.session.add(log)
            db.session.commit()
            
            print("✓ 测试日志插入成功")
            
            # 验证插入
            count = db.session.execute(db.text("SELECT COUNT(*) FROM operation_logs")).scalar()
            print(f"✓ 当前日志总数: {count}")
            
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
