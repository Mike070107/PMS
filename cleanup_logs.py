#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
操作日志自动清理脚本
自动清理超过指定天数的操作日志记录
建议通过Windows计划任务或Linux Cron定期执行
"""

import os
import sys
from datetime import datetime, timedelta

# 添加项目根目录到系统路径
basedir = os.path.abspath(os.path.dirname(__file__))
sys.path.insert(0, basedir)

from app import app, db, OperationLog


def clean_old_logs(days=365, batch_size=1000):
    """
    清理超过指定天数的日志记录
    
    参数:
        days: 保留天数，默认365天（1年）
        batch_size: 每批次删除的记录数，避免一次性删除过多导致数据库压力
    
    返回:
        tuple: (成功删除的记录数, 是否有错误)
    """
    with app.app_context():
        try:
            # 计算截止日期
            cutoff_date = datetime.now() - timedelta(days=days)
            
            print(f"开始清理操作日志...")
            print(f"当前时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"将删除 {cutoff_date.strftime('%Y-%m-%d %H:%M:%S')} 之前的所有记录")
            
            # 查询需要删除的记录总数
            total_count = OperationLog.query.filter(
                OperationLog.操作时间 < cutoff_date
            ).count()
            
            if total_count == 0:
                print(f"✓ 没有需要清理的记录")
                return 0, False
            
            print(f"发现 {total_count} 条需要清理的记录")
            
            # 分批删除
            deleted_count = 0
            has_error = False
            
            while True:
                try:
                    # 查询一批待删除记录
                    logs_to_delete = OperationLog.query.filter(
                        OperationLog.操作时间 < cutoff_date
                    ).limit(batch_size).all()
                    
                    if not logs_to_delete:
                        break
                    
                    # 批量删除
                    for log in logs_to_delete:
                        db.session.delete(log)
                    
                    db.session.commit()
                    
                    deleted_count += len(logs_to_delete)
                    print(f"已删除 {deleted_count}/{total_count} 条记录...")
                    
                except Exception as e:
                    print(f"✗ 删除批次时出错: {str(e)}")
                    db.session.rollback()
                    has_error = True
                    # 继续处理下一批
                    continue
            
            print(f"✓ 清理完成，共删除 {deleted_count} 条记录")
            return deleted_count, has_error
            
        except Exception as e:
            print(f"✗ 清理日志失败: {str(e)}")
            import traceback
            traceback.print_exc()
            return 0, True


def print_log_statistics():
    """打印日志统计信息"""
    with app.app_context():
        try:
            # 总记录数
            total = OperationLog.query.count()
            
            # 最早记录
            earliest = OperationLog.query.order_by(OperationLog.操作时间.asc()).first()
            earliest_date = earliest.操作时间.strftime('%Y-%m-%d %H:%M:%S') if earliest else 'N/A'
            
            # 最新记录
            latest = OperationLog.query.order_by(OperationLog.操作时间.desc()).first()
            latest_date = latest.操作时间.strftime('%Y-%m-%d %H:%M:%S') if latest else 'N/A'
            
            # 近30天记录
            thirty_days_ago = datetime.now() - timedelta(days=30)
            recent_count = OperationLog.query.filter(
                OperationLog.操作时间 >= thirty_days_ago
            ).count()
            
            print("\n" + "="*60)
            print("操作日志统计信息")
            print("="*60)
            print(f"总记录数: {total:,} 条")
            print(f"最早记录: {earliest_date}")
            print(f"最新记录: {latest_date}")
            print(f"近30天记录: {recent_count:,} 条")
            print("="*60 + "\n")
            
        except Exception as e:
            print(f"✗ 获取统计信息失败: {str(e)}")


if __name__ == '__main__':
    print("\n" + "="*60)
    print("操作日志自动清理脚本")
    print("="*60 + "\n")
    
    # 打印清理前的统计信息
    print_log_statistics()
    
    # 执行清理（默认保留1年）
    # 可以通过命令行参数指定保留天数，例如：python cleanup_logs.py 180
    retention_days = 365
    if len(sys.argv) > 1:
        try:
            retention_days = int(sys.argv[1])
            print(f"使用自定义保留天数: {retention_days} 天\n")
        except ValueError:
            print(f"无效的天数参数，使用默认值: {retention_days} 天\n")
    else:
        print(f"使用默认保留天数: {retention_days} 天\n")
    
    # 执行清理
    deleted, has_error = clean_old_logs(days=retention_days)
    
    # 打印清理后的统计信息
    if deleted > 0:
        print_log_statistics()
    
    # 退出码
    sys.exit(1 if has_error else 0)
