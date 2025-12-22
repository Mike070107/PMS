#!/usr/bin/env python3
"""
公寓物业收费系统 - 测试服务器配置文件
目标服务器: 192.168.1.251
"""

import os

class TestServerConfig:
    """测试服务器配置"""
    
    # === 数据库配置 (测试服务器数据库) ===
    DB_USER = 'WJWY'
    DB_PASSWORD = 'WjWy.2017456'  # 测试服务器数据库密码
    DB_HOST = '192.168.1.250'     # 数据库服务器IP (保持不变)
    DB_PORT = '3306'
    DB_NAME = 'wjwy'
    SQLALCHEMY_DATABASE_URI = f'mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}'
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # === 应用配置 ===
    SECRET_KEY = 'test-server-secret-key-2025-wjwy-system'
    JWT_SECRET_KEY = 'test-server-jwt-secret-2025-wjwy-system'
    
    # === 服务器配置 ===
    HOST = '0.0.0.0'  # 允许外部访问
    PORT = 5000
    DEBUG = False     # 生产环境关闭调试模式
    
    # === 文件路径配置 ===
    BASE_DIR = '/opt/wjwy_system'
    LOG_DIR = os.path.join(BASE_DIR, 'logs')
    TEMPLATE_DIR = os.path.join(BASE_DIR, 'templates')
    
    # === 日志配置 ===
    LOG_LEVEL = 'INFO'
    LOG_FILE = os.path.join(LOG_DIR, 'app.log')
    
    # === 账单号前缀 ===
    BILL_PREFIX = 'WD'

# 导出配置
config = TestServerConfig