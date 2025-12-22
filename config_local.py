import os

class ConfigLocal:
    # === 本地开发数据库配置 ===
    # 使用SQLite作为本地开发数据库
    basedir = os.path.abspath(os.path.dirname(__file__))
    SQLALCHEMY_DATABASE_URI = f'sqlite:///{os.path.join(basedir, "wjwy_local.db")}'
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # === 应用秘钥 ===
    SECRET_KEY = 'dev-secret-key-2025-wjwy-system-local'
    JWT_SECRET_KEY = 'jwt-dev-secret-2025-wjwy-system-local'

    # === 账单号前缀 ===
    BILL_PREFIX = 'WD'

    # === 开发环境配置 ===
    DEBUG = True
    TESTING = False