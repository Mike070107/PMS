"""
操作日志工具模块 - 优化版本
提供日志记录、装饰器等功能，优化文件句柄管理
"""

import json
import time
import logging
from datetime import datetime
from flask import request, g
from functools import wraps

# 配置日志
logger = logging.getLogger(__name__)

def get_client_ip():
    """获取客户端真实IP地址"""
    if request.environ.get('HTTP_X_FORWARDED_FOR'):
        ip = request.environ['HTTP_X_FORWARDED_FOR'].split(',')[0].strip()
    elif request.environ.get('HTTP_X_REAL_IP'):
        ip = request.environ.get('HTTP_X_REAL_IP')
    else:
        ip = request.remote_addr or 'unknown'
    return ip

def get_mac_address_from_request():
    """
    从请求中获取MAC地址（需要前端上报）
    Web环境无法直接获取客户端MAC，需要前端JavaScript协助
    """
    # 尝试从请求头或请求参数中获取（需要前端配合）
    mac = request.headers.get('X-Client-MAC')
    if not mac:
        mac = request.args.get('client_mac') or request.form.get('client_mac')
    return mac or ''

def get_user_agent():
    """获取浏览器UserAgent"""
    return request.headers.get('User-Agent', '')

def safe_db_operation(func):
    """安全的数据库操作装饰器"""
    def wrapper(*args, **kwargs):
        try:
            result = func(*args, **kwargs)
            return result
        except Exception as e:
            logger.error(f"数据库操作失败: {str(e)}")
            # 尝试回滚事务
            try:
                from flask import current_app
                if 'sqlalchemy' in current_app.extensions:
                    db = current_app.extensions['sqlalchemy']
                    db.session.rollback()
            except Exception as rollback_error:
                logger.error(f"回滚事务失败: {str(rollback_error)}")
            raise
    return wrapper

@safe_db_operation
def log_operation(
    operation_type,
    operation_module,
    operation_detail='',
    target_id='',
    target_type='',
    operation_result='success',
    error_message='',
    response_time=0,
    user=None
):
    """
    记录操作日志 - 优化版本
    """
    try:
        # 延迟导入避免循环依赖
        from flask import request, has_request_context, current_app
        
        # 获取当前用户信息
        if user is None:
            current_user = getattr(g, 'current_user', None)
            if not current_user:
                logger.warning("log_operation called without current_user in context")
                return
        else:
            current_user = user
        
        # 通过current_app获取db和OperationLog（避免循环导入）
        from flask import current_app
        if 'sqlalchemy' not in current_app.extensions:
            logger.error("SQLAlchemy extension not initialized")
            return
        db = current_app.extensions['sqlalchemy']
        from app import OperationLog
        
        # 构建日志对象
        log = OperationLog()
        log.操作时间 = datetime.now()
        
        # 用户信息
        log.用户ID = current_user.ID
        log.用户账号 = current_user.USERNAME
        log.用户姓名 = current_user.用户姓名 or current_user.USERNAME
        log.用户角色 = current_user.Role
        log.所属小区 = current_user.COMMUNITY or ''
        log.小区编号 = current_user.小区编号
        
        # 网络信息（只在有请求上下文时获取）
        if has_request_context():
            log.电脑IP = get_client_ip()
            log.MAC地址 = get_mac_address_from_request()
            log.用户代理 = get_user_agent()
            log.请求方法 = request.method
            log.请求URL = request.url
            
            # 获取请求参数（安全处理，避免记录敏感信息）
            params = {}
            if request.method == 'GET':
                params = dict(request.args)
            elif request.method in ['POST', 'PUT', 'DELETE']:
                if request.is_json:
                    params = request.get_json() or {}
                else:
                    params = dict(request.form)
            
            # 过滤敏感字段
            sensitive_fields = ['password', 'passwd', 'pwd', 'token', 'secret', 'key']
            filtered_params = {k: '***' if any(s in k.lower() for s in sensitive_fields) else v 
                              for k, v in params.items()}
            log.请求参数 = json.dumps(filtered_params, ensure_ascii=False)
        else:
            log.电脑IP = 'unknown'
            log.MAC地址 = ''
            log.用户代理 = ''
            log.请求方法 = ''
            log.请求URL = ''
            log.请求参数 = ''
        
        # 操作信息
        log.操作类型 = operation_type
        log.操作模块 = operation_module
        log.操作详情 = operation_detail if isinstance(operation_detail, str) else json.dumps(operation_detail, ensure_ascii=False)
        
        # 业务相关
        log.目标ID = str(target_id) if target_id else ''
        log.目标类型 = target_type
        
        # 结果信息
        log.操作结果 = operation_result
        log.错误信息 = error_message
        
        # 响应信息
        log.响应时间 = response_time
        
        # 保存到数据库
        db.session.add(log)
        db.session.commit()
        
        # 及时清理会话
        db.session.remove()
        
    except Exception as e:
        logger.error(f"记录操作日志失败: {str(e)}")
        # 日志记录失败不应影响主业务，仅记录错误
        # 确保会话清理
        try:
            from flask import current_app
            if 'sqlalchemy' in current_app.extensions:
                db = current_app.extensions['sqlalchemy']
                db.session.rollback()
                db.session.remove()
        except:
            pass


def log_decorator(operation_type, operation_module, target_type=''):
    """
    操作日志装饰器 - 自动记录API操作
    
    使用示例:
        @app.route('/api/orders', methods=['POST'])
        @token_required
        @log_decorator('新增', '订单管理', '订单')
        def create_order():
            # ... 业务逻辑
            return jsonify({'status': 'success', 'order_id': 123})
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            start_time = time.time()
            operation_result = 'success'
            error_msg = ''
            target_id = ''
            detail = {}
            
            try:
                # 执行原函数
                response = f(*args, **kwargs)
                
                # 尝试提取目标ID（从响应中）
                if isinstance(response, tuple) and len(response) > 0:
                    resp_data = response[0]
                    if hasattr(resp_data, 'get_json'):
                        json_data = resp_data.get_json()
                        if json_data:
                            # 常见的ID字段名
                            for id_field in ['id', 'order_id', 'user_id', 'ID', 'orderId']:
                                if id_field in json_data:
                                    target_id = str(json_data[id_field])
                                    break
                            
                            # 提取操作详情
                            detail = {
                                'status': json_data.get('status', ''),
                                'message': json_data.get('message', '')
                            }
                            
                            # 判断操作结果
                            if json_data.get('status') == 'error':
                                operation_result = 'fail'
                                error_msg = json_data.get('message', '')
                
                return response
                
            except Exception as e:
                operation_result = 'error'
                error_msg = str(e)
                raise
                
            finally:
                # 计算响应时间
                end_time = time.time()
                response_time = int((end_time - start_time) * 1000)
                
                # 记录日志
                log_operation(
                    operation_type=operation_type,
                    operation_module=operation_module,
                    operation_detail=json.dumps(detail, ensure_ascii=False),
                    target_id=target_id,
                    target_type=target_type,
                    operation_result=operation_result,
                    error_message=error_msg,
                    response_time=response_time
                )
        
        return decorated_function
    return decorator
