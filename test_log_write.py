#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""测试日志写入功能"""

from app import app, db, User
from log_utils import log_operation

with app.app_context():
    try:
        # 获取一个测试用户
        user = User.query.first()
        
        if not user:
            print("✗ 数据库中没有用户")
        else:
            print(f"✓ 找到用户: {user.USERNAME}")
            
            # 测试写入日志（模拟登录）
            log_operation(
                operation_type='测试登录',
                operation_module='系统登录',
                operation_detail='这是一条测试日志',
                user=user
            )
            
            print("✓ 日志写入成功")
            
            # 验证
            from app import OperationLog
            count = OperationLog.query.count()
            print(f"✓ 当前日志总数: {count}")
            
            if count > 0:
                latest = OperationLog.query.order_by(OperationLog.操作时间.desc()).first()
                print(f"✓ 最新日志: [{latest.操作时间}] {latest.用户账号} - {latest.操作类型}")
            
    except Exception as e:
        print(f"✗ 测试失败: {e}")
        import traceback
        traceback.print_exc()
