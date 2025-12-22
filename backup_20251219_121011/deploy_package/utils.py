"""
公寓物业收费系统 - 工具函数模块
"""

from datetime import datetime
from flask import request, current_app
import jwt
from werkzeug.security import generate_password_hash, check_password_hash
from config import Config


def generate_bill_number():
    """
    生成格式为 WD + 年月日 + 时分秒 + 3位随机数 的账单号
    例如：WD20251209010158999
    """
    from datetime import datetime
    import random
    
    date_part = datetime.now().strftime('%Y%m%d%H%M%S')
    random_suffix = f"{random.randint(100, 999):03d}"
    return f"{Config.BILL_PREFIX}{date_part}{random_suffix}"


def log_operation(user_account, operation_type, details, community_num=None, commit_to_db=True):
    """
    记录操作日志（简化版：仅打印到控制台，避免数据库上下文问题）
    """
    # 暂时不操作数据库，仅打印日志
    log_msg = f"[操作日志] 用户: {user_account}, 操作: {operation_type}, 详情: {details}"
    print(log_msg)
    
    # 可选：未来恢复数据库记录时，再启用下面的代码
    # try:
    #     from app import db, OperationLog
    #     with current_app.app_context():
    #         log = OperationLog(...)
    #         db.session.add(log)
    #         if commit_to_db:
    #             db.session.commit()
    # except Exception as e:
    #     print(f"[日志记录失败] {e}")


def verify_password(stored_hashed_password, provided_password):
    """验证密码（使用 werkzeug.security）"""
    return check_password_hash(stored_hashed_password, provided_password)


def generate_token(user_id, username, community_num, role):
    """生成JWT令牌，用于保持登录状态"""
    from datetime import datetime, timedelta
    
    payload = {
        'user_id': user_id,
        'username': username,
        'community_num': community_num,
        'role': role,
        'exp': datetime.utcnow() + timedelta(hours=8)  # 令牌8小时后过期
    }
    token = jwt.encode(payload, Config.SECRET_KEY, algorithm='HS256')
    return token