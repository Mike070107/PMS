#!/usr/bin/env python3
"""
测试数据库连接脚本
"""

import pymysql

def test_connection():
    """测试数据库连接"""
    try:
        # 直接使用pymysql测试连接
        connection = pymysql.connect(
            host='192.168.1.250',
            user='WJWY',
            password='WjWy.2017456',
            database='wjwy',
            port=3306,
            charset='utf8mb4'
        )
        
        print("✓ 数据库连接成功!")
        
        # 测试查询
        with connection.cursor() as cursor:
            cursor.execute("SHOW TABLES;")
            tables = cursor.fetchall()
            print(f"✓ 数据库中有 {len(tables)} 个表")
            
        connection.close()
        return True
        
    except Exception as e:
        print(f"✗ 数据库连接失败: {e}")
        return False

if __name__ == '__main__':
    print("=== 测试数据库连接 ===")
    print("服务器: 192.168.1.250")
    print("数据库: wjwy")
    print("=" * 30)
    
    test_connection()