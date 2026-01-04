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
    
    # === 数据库连接池优化 ===
    SQLALCHEMY_POOL_SIZE = 10          # 连接池大小
    SQLALCHEMY_POOL_TIMEOUT = 20       # 连接超时时间(秒)
    SQLALCHEMY_POOL_RECYCLE = 1800     # 连接回收时间(30分钟)
    SQLALCHEMY_MAX_OVERFLOW = 5        # 超出连接池大小的额外连接数

    # === 应用秘钥 ===
    SECRET_KEY = 'your-super-secret-jwt-key-change-this-in-production'

    # === 账单号前缀 ===
    BILL_PREFIX = 'WD'
