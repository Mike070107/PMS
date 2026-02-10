#!/usr/bin/env python3
"""本地开发启动脚本"""

import os
import sys
from app import app

if __name__ == '__main__':
    # 从命令行参数获取端口，默认为5000
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    
    print("公寓物业收费系统 - 本地开发模式启动")
    print(f"时间: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("数据库: SQLite (本地)")
    print(f"服务地址: http://0.0.0.0:{port}")
    print(f"测试页面: http://localhost:{port}/test")
    print("=" * 50)
    
    app.run(host='0.0.0.0', port=port, debug=True)