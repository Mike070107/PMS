import os

class Config:
    # === 数据库配置 (指向远程数据库服务器) ===
    DB_USER = 'WJWY'
    DB_PASSWORD = 'WjWy.2017456'  # 务必与步骤1.2中设置的密码一致
    DB_HOST = '192.168.1.250'               # 远程数据库服务器IP
    DB_PORT = '3306'
    DB_NAME = 'wjwy'
    SQLALCHEMY_DATABASE_URI = f'mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}'
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # === 应用秘钥 ===
    SECRET_KEY = 'your-super-secret-jwt-key-change-this-in-production'

    # === 账单号前缀 ===
    BILL_PREFIX = 'WD'