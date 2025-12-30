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
    记录操作日志（写入数据库）
    """
    try:
        from app import db, OperationLog, User
        from flask import request, has_request_context
        from datetime import datetime
        
        # 获取IP地址
        ip_address = 'unknown'
        mac_address = ''
        user_agent = ''
        request_method = ''
        request_url = ''
        
        if has_request_context():
            ip_address = request.remote_addr or 'unknown'
            if request.environ.get('HTTP_X_FORWARDED_FOR'):
                ip_address = request.environ['HTTP_X_FORWARDED_FOR'].split(',')[0].strip()
            
            # 获取MAC地址（从请求头获取，需要前端上报）
            mac_address = request.headers.get('X-Client-MAC', '')
            
            # 获取UserAgent
            user_agent = request.headers.get('User-Agent', '')
            
            # 获取请求信息
            request_method = request.method
            request_url = request.url
        
        # 查询用户信息
        user = User.query.filter_by(USERNAME=user_account).first()
        
        if user:
            log = OperationLog()
            log.操作时间 = datetime.now()
            log.用户ID = user.ID
            log.用户账号 = user_account
            log.用户姓名 = user.用户姓名 or user_account
            log.用户角色 = user.Role
            log.所属小区 = user.COMMUNITY or ''
            log.电脑IP = ip_address
            log.MAC地址 = mac_address
            log.用户代理 = user_agent
            log.操作类型 = operation_type
            log.操作模块 = '系统登录' if operation_type in ['用户登录', '用户登出'] else '系统操作'
            log.操作详情 = details
            log.操作结果 = 'success'
            log.请求方法 = request_method
            log.请求URL = request_url
            
            db.session.add(log)
            if commit_to_db:
                db.session.commit()
                
            print(f"[操作日志] 用户: {user_account}, 操作: {operation_type}, 详情: {details}")
        else:
            print(f"[日志记录失败] 用户不存在: {user_account}")
            
    except Exception as e:
        print(f"[日志记录失败] {e}")
        import traceback
        traceback.print_exc()


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