#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""检查操作日志表是否存在"""

from app import app, db, OperationLog

with app.app_context():
    try:
        # 检查表是否存在
        result = db.session.execute(db.text("SHOW TABLES LIKE 'operation_logs'")).fetchone()
        
        if result:
            print("✓ operation_logs表已存在")
            
            # 检查表结构
            cols = db.session.execute(db.text("DESCRIBE operation_logs")).fetchall()
            print(f"✓ 表包含 {len(cols)} 个字段")
            
            # 检查是否有数据
            count = db.session.execute(db.text("SELECT COUNT(*) FROM operation_logs")).scalar()
            print(f"✓ 当前有 {count} 条日志记录")
            
            # 显示最近的5条记录
            if count > 0:
                print("\n最近的5条日志:")
                logs = OperationLog.query.order_by(OperationLog.操作时间.desc()).limit(5).all()
                for log in logs:
                    print(f"  - [{log.操作时间}] {log.用户账号} - {log.操作类型} - {log.操作模块}")
        else:
            print("✗ operation_logs表不存在，需要执行SQL脚本创建")
            print("\n请执行以下命令创建表:")
            print("  mysql -u root -p wjwy_system < create_operation_log_table.sql")
            
    except Exception as e:
        print(f"✗ 检查失败: {e}")
        import traceback
        traceback.print_exc()
