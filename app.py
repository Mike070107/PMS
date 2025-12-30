#!/usr/bin/env python3
"""
公寓物业收费系统 - Flask 后端主程序
Author: 系统开发者
Date: 2025-12-09
版本: 2.1 (停车费功能优化)
"""

import os
import traceback
import jwt
import re
import random
import logging
import io
import pandas as pd
from logging.handlers import TimedRotatingFileHandler
from datetime import datetime, timedelta

from flask import Flask, request, jsonify, g, send_from_directory, render_template, redirect, send_file
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import func

from config import Config
from utils import log_operation

# ========== 初始化Flask应用 ==========
basedir = os.path.abspath(os.path.dirname(__file__))
app = Flask(__name__, 
           static_folder=os.path.join(basedir, 'static'),
           static_url_path='/static',
           template_folder=os.path.join(basedir, 'templates'))

# 加载配置 - 使用远程数据库配置
app.config.from_object(Config)

# 安全密钥配置（覆盖Config中的设置）
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-2025-wjwy-system')
app.config['JWT_SECRET_KEY'] = os.environ.get('JWT_SECRET_KEY', 'jwt-dev-secret-2025-wjwy-system')

# 允许跨域请求，支持凭证（用于开发环境）
CORS(app, resources={r"/api/*": {"origins": "*", "supports_credentials": True}})

# 数据库初始化
db = SQLAlchemy(app)

# ========== 日志配置 ==========
def setup_logging():
    """配置日志轮转：每天一个日志文件，保留7天"""
    # 创建日志目录
    log_dir = os.path.join(basedir, 'logs')
    if not os.path.exists(log_dir):
        os.makedirs(log_dir)
    
    # 配置日志文件路径
    log_file = os.path.join(log_dir, 'app.log')
    
    # 创建时间轮转处理器：每天午夜轮转，保留7天备份
    file_handler = TimedRotatingFileHandler(
        log_file,
        when='midnight',  # 每天午夜轮转
        interval=1,       # 每天一次
        backupCount=7,    # 保留7天备份
        encoding='utf-8'
    )
    
    # 设置日志格式
    formatter = logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(logging.INFO)
    
    # 配置应用日志
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.INFO)
    
    # 减少第三方库的日志级别
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    
    app.logger.info('公寓物业收费系统启动')
    return file_handler

# 初始化日志
file_handler = setup_logging()

# ========== 数据模型定义 (ORM) ==========
class User(db.Model):
    """用户表模型"""
    __tablename__ = 'users'
    
    ID = db.Column(db.Integer, primary_key=True, comment='用户唯一标识')
    USERNAME = db.Column(db.String(50), unique=True, nullable=False, comment='登录用户名')
    PWD = db.Column(db.String(255), nullable=False, comment='加密后的密码')
    用户姓名 = db.Column(db.String(50), nullable=True, comment='用户真实姓名')
    # 新增字段
    COMMUNITY = db.Column(db.String(100), nullable=False, comment='所属小区名称')
    小区编号 = db.Column(db.Integer, nullable=False, comment='用于权限隔离的数字编号')
    Role = db.Column(db.String(50), nullable=False, comment='角色')
    Edit = db.Column(db.Boolean, default=False, comment='编辑权限')
    Read = db.Column(db.Boolean, default=True, comment='读取权限')
    Report = db.Column(db.Boolean, default=False, comment='报表权限')
    
    def to_dict(self):
        """转换为字典格式"""
        return {
            'id': self.ID,
            'username': self.USERNAME,
            'real_name': self.用户姓名 or self.USERNAME,  # 新增：优先使用真实姓名
            'community': self.COMMUNITY,
            'community_num': self.小区编号,
            'role': self.Role,
            'permissions': {
                'edit': bool(self.Edit),
                'read': bool(self.Read),
                'report': bool(self.Report)
            }
        }

class Address(db.Model):
    """地址表模型"""
    __tablename__ = 'addresses'
    
    ID = db.Column(db.Integer, primary_key=True, comment='地址唯一标识')
    小区编号 = db.Column(db.Integer, nullable=False, comment='关联users表中的小区编号')
    楼栋号 = db.Column(db.String(50), nullable=False, comment='如：一号楼')
    房间号 = db.Column(db.String(50), nullable=False, comment='如：101')
    姓名 = db.Column(db.String(50), nullable=True, comment='住户姓名')  # 新增字段
    手机号 = db.Column(db.String(20), nullable=True, comment='住户手机号')  # 新增字段
    
    def to_dict(self):
        """转换为字典格式"""
        return {
            'id': self.ID,
            'building': self.楼栋号,
            'room': self.房间号,
            'community_num': self.小区编号,
            'name': self.姓名 or '',  # 新增
            'phone': self.手机号 or ''  # 新增
        }

class Order(db.Model):
    """订单表模型"""
    __tablename__ = 'orders'
    
    订单ID = db.Column(db.Integer, primary_key=True, comment='订单唯一标识')
    账单号 = db.Column(db.String(50), unique=True, nullable=False, comment='系统生成的唯一账单号')
    地址ID = db.Column(db.Integer, db.ForeignKey('addresses.ID'), nullable=False, comment='关联addresses表的ID')
    操作员ID = db.Column(db.Integer, db.ForeignKey('users.ID'), nullable=False, comment='关联users表的ID')
    小区ID = db.Column(db.Integer, nullable=False, comment='小区ID，来源于操作员的小区编号')
    录入时间 = db.Column(db.DateTime, default=datetime.now, nullable=False, comment='订单创建时间')
    收款金额 = db.Column(db.Numeric(10, 2), nullable=False, default=0.00, comment='订单总应收金额')
    退款金额 = db.Column(db.Numeric(10, 2), nullable=False, default=0.00, comment='订单总退款金额')
    收款方式 = db.Column(db.String(20), comment='如：微信')
    
    # 动态费用字段
    电费度数 = db.Column(db.Numeric(10, 2))
    电费金额 = db.Column(db.Numeric(10, 2))
    热水吨数 = db.Column(db.Numeric(10, 2))
    热水金额 = db.Column(db.Numeric(10, 2))
    冷水吨数 = db.Column(db.Numeric(10, 2))
    冷水金额 = db.Column(db.Numeric(10, 2))
    网费月数 = db.Column(db.Integer)
    网费金额 = db.Column(db.Numeric(10, 2))
    停车费月数 = db.Column(db.Integer)
    停车费金额 = db.Column(db.Numeric(10, 2))
    房租月数 = db.Column(db.Integer)
    房租金额 = db.Column(db.Numeric(10, 2))
    管理费月数 = db.Column(db.Integer)
    管理费金额 = db.Column(db.Numeric(10, 2))
    车牌号 = db.Column(db.String(30), nullable=True, comment='车牌号')  # 新增字段
    停车开始日期 = db.Column(db.Date, nullable=True, comment='停车开始日期')
    停车结束日期 = db.Column(db.Date, nullable=True, comment='停车结束日期')
    备注 = db.Column(db.Text, comment='订单备注')
    红冲 = db.Column(db.Integer, nullable=False, default=0, comment='是否为红冲订单，0：否，1：是')
    
    # 关系（便于查询）
    地址 = db.relationship('Address', backref='orders', lazy='joined')
    操作员 = db.relationship('User', backref='orders', lazy='joined')
    
    def to_dict(self):
        """转换为字典格式（简洁版，用于列表）"""
        return {
            '订单ID': self.订单ID,
            '账单号': self.账单号,
            '地址': self.地址,
            '操作员': self.操作员,
            '录入时间': self.录入时间,
            '收款金额': self.收款金额,
            '收款方式': self.收款方式,
            '备注': self.备注,
            # 费用字段
            '电费度数': self.电费度数,
            '电费金额': self.电费金额,
            '冷水吨数': self.冷水吨数,
            '冷水金额': self.冷水金额,
            '热水吨数': self.热水吨数,
            '热水金额': self.热水金额,
            '网费月数': self.网费月数,
            '网费金额': self.网费金额,
            '停车费月数': self.停车费月数,
            '停车费金额': self.停车费金额,
            '房租月数': self.房租月数,
            '房租金额': self.房租金额,
            '管理费月数': self.管理费月数,
            '管理费金额': self.管理费金额,
            '车牌号': self.车牌号,
            '停车开始日期': self.停车开始日期,
            '停车结束日期': self.停车结束日期,
            '红冲': self.红冲
        }

class FeePrice(db.Model):
    """各小区收费单价配置表模型 - 列存储结构（已修改）"""
    __tablename__ = 'fee_prices'
    
    id = db.Column(db.Integer, primary_key=True, comment='配置唯一标识')
    community = db.Column(db.String(100), nullable=False, unique=True, comment='小区名称，需与User表的COMMUNITY字段对应')
    electricity = db.Column(db.Numeric(10, 2), default=0.00, comment='电费单价')
    coldWater = db.Column(db.Numeric(10, 2), default=0.00, comment='冷水费单价')
    hotWater = db.Column(db.Numeric(10, 2), default=0.00, comment='热水费单价')
    network = db.Column(db.Numeric(10, 2), default=0.00, comment='网费单价')
    parking = db.Column(db.Numeric(10, 2), default=0.00, comment='停车费单价')
    rent_fee = db.Column(db.Numeric(10, 2), default=0.00, comment='房租单价')
    manage_fee = db.Column(db.Numeric(10, 2), default=0.00, comment='管理费单价')
    created_at = db.Column(db.TIMESTAMP, server_default=db.func.current_timestamp())
    updated_at = db.Column(db.TIMESTAMP, server_default=db.func.current_timestamp(), onupdate=db.func.current_timestamp())
    
    def to_dict(self):
        """转换为字典格式"""
        return {
            'id': self.id,
            'community': self.community,
            'electricity': float(self.electricity),
            'coldWater': float(self.coldWater),
            'hotWater': float(self.hotWater),
            'network': float(self.network),
            'parking': float(self.parking),
            'rent_fee': float(self.rent_fee),
            'manage_fee': float(self.manage_fee),
            'created_at': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None,
            'updated_at': self.updated_at.strftime('%Y-%m-%d %H:%M:%S') if self.updated_at else None
        }

class OperationLog(db.Model):
    """操作日志表模型"""
    __tablename__ = 'operation_logs'
    
    ID = db.Column(db.Integer, primary_key=True, comment='日志唯一标识')
    用户账号 = db.Column(db.String(50), nullable=False, comment='操作用户的USERNAME')
    操作时间 = db.Column(db.DateTime, default=datetime.now, nullable=False, comment='日志记录时间')
    电脑IP = db.Column(db.String(50), comment='用户操作时的IP地址')
    电脑名称 = db.Column(db.String(100), comment='用户操作时的计算机名')
    操作类型 = db.Column(db.String(100), nullable=False, comment='例如：用户登录')
    操作详情 = db.Column(db.Text, comment='更详细的信息')
    小区编号 = db.Column(db.Integer, comment='操作用户所属的小区编号')

# ========== 身份验证装饰器 ==========
def token_required(f):
    """验证JWT令牌的装饰器 - 用于API接口保护"""
    from functools import wraps
    
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        
        # 从请求头获取令牌
        auth_header = request.headers.get('Authorization')
        if auth_header:
            try:
                # 期望格式：Bearer <token>
                token = auth_header.split(" ")[1]
            except (IndexError, AttributeError):
                return jsonify({'status': 'error', 'message': '令牌格式错误'}), 401
        
        if not token:
            return jsonify({'status': 'error', 'message': '访问需要令牌'}), 401
        
        try:
            # 解码令牌
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
            current_user = User.query.get(data['user_id'])
            
            if current_user is None:
                return jsonify({'status': 'error', 'message': '用户不存在'}), 401
            
            # 将当前用户信息存入全局上下文g
            g.current_user = current_user
            g.token_data = data
            
        except jwt.ExpiredSignatureError:
            return jsonify({'status': 'error', 'message': '令牌已过期'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'status': 'error', 'message': '无效令牌'}), 401
        except Exception as e:
            app.logger.error(f"令牌验证失败: {str(e)}")
            return jsonify({'status': 'error', 'message': '令牌验证失败'}), 401
        
        return f(*args, **kwargs)
    
    return decorated

# ========== 辅助函数 ==========
def get_default_prices():
    """返回默认价格字典"""
    return {
        "electricity": 0.00,
        "coldWater": 0.00,
        "hotWater": 0.00,
        "network": 0.00,
        "parking": 0.00,
        "rent": 0.00,
        "management": 0.00
    }

# ========== 静态文件路由 ==========
@app.route('/static/<path:filename>')
def serve_static(filename):
    """服务静态文件"""
    return send_from_directory(app.static_folder, filename)

@app.route('/templates/<path:filename>')
def serve_template(filename):
    """服务模板文件"""
    return send_from_directory(app.template_folder, filename)

# ========== 前端页面路由 ==========
@app.route('/')
def index():
    """主工作台页面 - 由前端JavaScript控制登录状态检查"""
    return render_template('index.html')

@app.route('/login')
def login_page():
    """登录页面"""
    return render_template('login.html')

@app.route('/query_detailed')
def query_detailed_page():
    """详细订单查询页面"""
    return render_template('query_detailed.html')

@app.route('/fee_prices_manager')
def fee_prices_manager_page():
    """收费标准管理页面"""
    return render_template('fee_prices_manager.html')

@app.route('/reports')
def reports_page():
    """数据报表页面"""
    return render_template('reports.html')

@app.route('/test')
def test_page():
    """系统测试页面"""
    return '''
    <!DOCTYPE html>
    <html>
    <head><title>系统测试</title></head>
    <body>
        <h1>公寓物业收费系统 - 测试页</h1>
        <p><a href="/">主工作台</a></p>
        <p><a href="/login">登录页面</a></p>
        <p><a href="/query_detailed">详细查询</a></p>
        <p><a href="/test-static">静态文件测试</a></p>
        <p><a href="/api/test">API状态测试</a></p>
    </body>
    </html>
    '''

@app.route('/test-static')
def test_static():
    """测试静态文件是否可访问"""
    return '''
    <h1>静态文件测试</h1>
    <p>测试Vue.js: <a href="/static/lib/vue.global.js">/static/lib/vue.global.js</a></p>
    <p>测试CSS: <a href="/static/lib/index.css">/static/lib/index.css</a></p>
    <script>
        const files = [
            {name: 'Vue.js', url: '/static/lib/vue.global.js'},
            {name: 'Element Plus CSS', url: '/static/lib/index.css'}
        ];
        files.forEach(file => {
            fetch(file.url)
                .then(response => {
                    if(response.ok) {
                        document.write('<p style="color:green">✅ ' + file.name + ' 可访问</p>');
                    } else {
                        document.write('<p style="color:red">❌ ' + file.name + ' 不可访问</p>');
                    }
                })
                .catch(error => {
                    document.write('<p style="color:red">❌ ' + file.name + ' 加载失败</p>');
                });
        });
    </script>
    '''

# ========== API状态测试 ==========
@app.route('/api/test')
def api_test():
    """API服务状态测试"""
    return jsonify({
        'status': 'success',
        'message': '公寓物业收费系统API服务运行正常',
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'version': '2.1'
    })

# ========== 核心API路由 ==========

# 1. 用户认证
@app.route('/api/login', methods=['POST'])
def login():
    """用户登录"""
    data = request.get_json()
    
    if not data or not data.get('username') or not data.get('password'):
        return jsonify({'status': 'error', 'message': '请输入用户名和密码'}), 400
    
    try:
        # 查询用户
        user = User.query.filter_by(USERNAME=data['username']).first()
        
        # 注意：我们初始化数据用的是明文密码，这里直接对比
        if user and user.PWD == data['password']:
            # 生成JWT令牌 - 设置为当天有效，跨日期后自动失效
            from datetime import datetime, timedelta
            
            # 计算当天23:59:59的UTC时间戳
            today_end = datetime.now().replace(hour=23, minute=59, second=59, microsecond=999999)
            # JWT exp字段需要UTC时间戳（整数）
            exp_timestamp = int(today_end.timestamp())
            
            token = jwt.encode({
                'user_id': user.ID,
                'username': user.USERNAME,
                'real_name': user.用户姓名 or user.USERNAME,  # 新增真实姓名
                'community_num': user.小区编号,
                'role': user.Role,
                'exp': exp_timestamp
            }, app.config['SECRET_KEY'], algorithm='HS256')
            
            # 记录登录日志
            log_operation(
                user_account=user.USERNAME,
                operation_type='用户登录',
                details=f'用户 [{user.USERNAME}] 登录系统',
                community_num=user.小区编号
            )
            
            return jsonify({
                'status': 'success',
                'message': '登录成功',
                'token': token,
                'user': user.to_dict()  # 这里会包含 real_name
            })
        else:
            return jsonify({'status': 'error', 'message': '用户名或密码错误'}), 401
    
    except Exception as e:
        app.logger.error(f"登录异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500

# 2. 获取地址
@app.route('/api/addresses', methods=['GET'])
@token_required
def get_addresses():
    """获取当前用户有权访问的地址列表（两步选择）"""
    try:
        current_user = g.current_user
        step = request.args.get('step', 'buildings')  # 默认为获取楼栋列表
        
        # 构建查询：管理员看所有，操作员只看自己小区的
        if current_user.Role == '系统管理员':
            query = Address.query
        else:
            query = Address.query.filter_by(小区编号=current_user.小区编号)
        
        if step == 'buildings':
            # 第一步：获取楼栋列表（去重）
            buildings = query.with_entities(Address.楼栋号).distinct().all()
            building_list = [b[0] for b in buildings]
            
            # 对楼栋号进行自然排序
            def natural_sort_key_building(s):
                """楼栋号自然排序函数"""
                # 优先匹配数字开头的楼栋号（如"1号楼"、"12号楼"）
                num_match = re.match(r'^(\d+)(号楼)?$', s)
                if num_match:
                    return (0, int(num_match.group(1)))  # 数字楼栋号优先排序
                
                # 对于其他格式（纯文字），使用字符串排序
                return (1, s.lower())
            
            building_list.sort(key=natural_sort_key_building)
            
            return jsonify({
                'status': 'success',
                'data': building_list,
                'step': 'buildings'
            })
            
        elif step == 'rooms':
            # 第二步：根据楼栋号获取房间列表
            building = request.args.get('building', '')
            if not building:
                return jsonify({'status': 'error', 'message': '请提供楼栋号'}), 400
            
            addresses = query.filter_by(楼栋号=building).all()
            result = [addr.to_dict() for addr in addresses]
            
            # 对房间号进行自然排序
            def natural_sort_key_room(addr):
                """房间号自然排序函数"""
                room = addr.get('room', '')
                # 优先处理纯数字房间号
                if room.isdigit():
                    return (0, int(room))
                
                # 对于混合格式（如"101A"），提取数字部分
                num_match = re.match(r'^(\d+)', room)
                if num_match:
                    return (0, int(num_match.group(1)))
                
                # 其他情况按原样排序
                return (1, room)
            
            result.sort(key=natural_sort_key_room)
            
            return jsonify({
                'status': 'success',
                'data': result,
                'step': 'rooms'
            })
        else:
            return jsonify({'status': 'error', 'message': '无效的步骤参数'}), 400
    
    except Exception as e:
        app.logger.error(f"获取地址异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取地址失败'}), 500

# 3. 新增：获取当前用户所属小区的收费标准
@app.route('/api/fee_prices', methods=['GET'])
@token_required
def get_fee_prices():
    """
    根据当前登录用户的小区获取收费标准
    使用: users.小区编号 = fee_prices.id
    """
    try:
        current_user = g.current_user
        
        # 获取用户的小区编号（整数）
        community_num = getattr(current_user, '小区编号', None)
        
        if not community_num:
            return jsonify({
                "status": "success",  # 注意：这里要保持一致的响应格式
                "message": "用户未设置小区编号",
                "data": get_default_prices()
            })
        
        # 查询该小区的收费标准（通过id查询）
        fee_price = FeePrice.query.filter_by(id=community_num).first()
        
        if not fee_price:
            return jsonify({
                "status": "success",
                "message": f"未找到ID为 {community_num} 的收费标准",
                "data": get_default_prices()
            })
        
        # 直接返回所有费用类型的单价
        return jsonify({
            "status": "success",
            "data": {
                "electricity": float(fee_price.electricity),
                "coldWater": float(fee_price.coldWater),
                "hotWater": float(fee_price.hotWater),
                "network": float(fee_price.network),
                "parking": float(fee_price.parking),
                "rent_fee": float(fee_price.rent_fee),  # 修正为rent_fee
                "manage_fee": float(fee_price.manage_fee)  # 修正为manage_fee
            }
        })
        
    except Exception as e:
        app.logger.error(f"获取单价时发生错误: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500

# 更新收费标准
@app.route('/api/fee_prices', methods=['PUT'])
@token_required
def update_fee_prices():
    """
    更新当前用户所属小区的收费标准
    只能更新自己小区的收费标准
    """
    try:
        current_user = g.current_user
        data = request.get_json()
        
        app.logger.info(f"用户 {current_user.USERNAME} 请求更新收费标准")
        app.logger.info(f"接收到的数据: {data}")
        
        # 获取用户的小区编号
        community_num = getattr(current_user, '小区编号', None)
        
        if not community_num:
            return jsonify({
                "status": "error",
                "message": "用户未设置小区编号"
            }), 400
        
        # 查询该小区的收费标准
        fee_price = FeePrice.query.filter_by(id=community_num).first()
        
        if not fee_price:
            return jsonify({
                "status": "error",
                "message": f"未找到ID为 {community_num} 的收费标准配置"
            }), 404
        
        # 更新数据
        if 'electricity' in data:
            fee_price.electricity = float(data['electricity'])
        if 'coldWater' in data:
            fee_price.coldWater = float(data['coldWater'])
        if 'hotWater' in data:
            fee_price.hotWater = float(data['hotWater'])
        if 'network' in data:
            fee_price.network = float(data['network'])
        if 'parking' in data:
            fee_price.parking = float(data['parking'])
        if 'rent_fee' in data:
            fee_price.rent_fee = float(data['rent_fee'])
        if 'manage_fee' in data:
            fee_price.manage_fee = float(data['manage_fee'])
        
        # 手动更新updated_at字段
        fee_price.updated_at = datetime.now()
        
        # 提交数据库修改
        db.session.commit()
        
        app.logger.info(f"收费标准更新成功: 小区={fee_price.community}, ID={community_num}")
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='更新收费标准',
            details=f'更新小区 [{fee_price.community}] 的收费标准',
            community_num=community_num
        )
        
        return jsonify({
            "status": "success",
            "message": "收费标准更新成功",
            "data": fee_price.to_dict()
        })
        
    except ValueError as e:
        app.logger.error(f"数据格式错误: {str(e)}")
        return jsonify({"status": "error", "message": "数据格式错误"}), 400
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"更新收费标准失败: {str(e)}\n{traceback.format_exc()}")
        return jsonify({"status": "error", "message": "更新失败"}), 500

# 新增：获取小区列表（用于查询筛选）
@app.route('/api/communities', methods=['GET'])
@token_required
def get_communities():
    """获取所有小区列表（去重），用于查询筛选"""
    try:
        current_user = g.current_user
        
        # 系统管理员看所有小区，普通用户只看自己的小区
        if current_user.Role == '系统管理员':
            communities = db.session.query(User.COMMUNITY).distinct().all()
            community_list = [c[0] for c in communities if c[0]]  # 过滤空值
        else:
            # 普通用户只返回自己的小区
            community_list = [current_user.COMMUNITY] if current_user.COMMUNITY else []
        
        # 排序
        community_list.sort()
        
        return jsonify({
            'status': 'success',
            'data': community_list
        })
    
    except Exception as e:
        app.logger.error(f"获取小区列表异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取小区列表失败'}), 500

# 4. 创建订单
@app.route('/api/orders', methods=['POST'])
@token_required
def create_order():
    current_user = g.current_user
    
    # 检查编辑权限
    if not current_user.Edit:
        return jsonify({'status': 'error', 'message': '当前用户没有编辑权限'}), 403
    
    data = request.get_json()
    
    # 基础验证
    required_fields = ['addressId', 'paymentMethod', 'totalAmount', 'items']
    for field in required_fields:
        if field not in data:
            return jsonify({'status': 'error', 'message': f'缺少必要字段: {field}'}), 400
    
    try:
        # 1. 验证地址权限
        address = Address.query.get(data['addressId'])
        if not address:
            return jsonify({'status': 'error', 'message': '地址不存在'}), 400
        
        # 检查是否是红冲操作，如果是，则允许对原订单进行红冲
        is_red_reverse = 'originalOrderId' in data
        if is_red_reverse:
            # 对于红冲操作，验证原订单是否存在
            original_order_id = data['originalOrderId']
            original_order = Order.query.get(original_order_id)
            if not original_order:
                return jsonify({'status': 'error', 'message': '原订单不存在'}), 400
            # 红冲操作允许对原订单进行红冲，不检查地址权限
            app.logger.info(f"红冲操作：允许对原订单ID {original_order_id} 进行红冲")
        else:
            # 非红冲操作，需要检查地址权限
            if current_user.Role != '系统管理员' and address.小区编号 != current_user.小区编号:
                return jsonify({'status': 'error', 'message': '无权操作此地址'}), 403
        
        # 2. 更新地址的住户信息（如果提供了）
        if 'residentName' in data or 'residentPhone' in data:
            resident_name = (data.get('residentName') or '').strip()
            resident_phone = (data.get('residentPhone') or '').strip()
            
            # 验证姓名
            if resident_name:
                if not re.match(r'^[\u4e00-\u9fa5A-Za-z]{2,10}$', resident_name):
                    return jsonify({'status': 'error', 'message': '姓名格式不正确（2-10个中英文字符）'}), 400
            
            # 验证手机号
            if resident_phone:
                if not re.match(r'^1[3-9]\d{9}$', resident_phone):
                    return jsonify({'status': 'error', 'message': '手机号格式不正确（11位数字，1开头）'}), 400
            
            # 更新字段（只有提供了值且不为空才更新）
            if resident_name:
                address.姓名 = resident_name
            if resident_phone:
                address.手机号 = resident_phone
        
        # 3. 生成唯一账单号
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        random_suffix = f"{random.randint(100, 999):03d}"
        bill_number = f"WD{timestamp}{random_suffix}"
        
        # 4. 构建订单对象
        # 处理录入时间，如果前端提供了entryTime则使用，否则使用当前时间
        entry_time = datetime.now()
        if 'entryTime' in data and data['entryTime']:
            try:
                # 解析前端传递的时间字符串，格式为：YYYY-MM-DD HH:mm:ss
                app.logger.info(f"接收到前端entryTime: {data['entryTime']}")
                entry_time = datetime.strptime(data['entryTime'], '%Y-%m-%d %H:%M:%S')
                app.logger.info(f"解析后的entryTime: {entry_time}")
            except ValueError as e:
                # 如果解析失败，使用当前时间
                app.logger.warning(f"解析entryTime失败: {e}，使用当前时间")
                entry_time = datetime.now()
        
        app.logger.info(f"最终使用的entryTime: {entry_time}")
        
        new_order = Order(
            账单号=bill_number,
            地址ID=data['addressId'],
            操作员ID=current_user.ID,
            小区ID=current_user.小区编号,
            录入时间=entry_time,
            收款金额=float(data['totalAmount']),
            收款方式=data['paymentMethod'],
            备注=data.get('remark', '')
        )
        
        # 5. 处理动态费用项
        fee_mapping = {
            'electricity': ('电费度数', '电费金额'),
            'hotWater': ('热水吨数', '热水金额'),
            'coldWater': ('冷水吨数', '冷水金额'),
            'network': ('网费月数', '网费金额'),
            'parking': ('停车费月数', '停车费金额'),
            'rent': ('房租月数', '房租金额'),
            'management': ('管理费月数', '管理费金额')
        }
        
        # 处理费用项目
        for item in data['items']:
            fee_type = item.get('type')
            if fee_type in fee_mapping:
                quantity_field, amount_field = fee_mapping[fee_type]
                setattr(new_order, quantity_field, float(item.get('quantity', 0)))
                setattr(new_order, amount_field, float(item.get('amount', 0)))
                
                # 如果是停车费，保存车牌号、开始日期、结束日期
                if fee_type == 'parking':
                    new_order.车牌号 = item.get('carPlate', '')
                    
                    # 保存开始日期和结束日期
                    if item.get('startDate'):
                        try:
                            new_order.停车开始日期 = datetime.strptime(item.get('startDate'), '%Y-%m-%d').date()
                        except ValueError:
                            app.logger.warning(f"无效的开始日期格式: {item.get('startDate')}")
                    
                    if item.get('endDate'):
                        try:
                            new_order.停车结束日期 = datetime.strptime(item.get('endDate'), '%Y-%m-%d').date()
                        except ValueError:
                            app.logger.warning(f"无效的结束日期格式: {item.get('endDate')}")
        
        # 处理房租和管理费数据（从单独的字段获取）
        if 'rentMonths' in data:
            new_order.房租月数 = int(data.get('rentMonths', 0))
        if 'rentAmount' in data:
            new_order.房租金额 = float(data.get('rentAmount', 0))
        if 'managementMonths' in data:
            new_order.管理费月数 = int(data.get('managementMonths', 0))
        if 'managementAmount' in data:
            new_order.管理费金额 = float(data.get('managementAmount', 0))
        
        # 6. 保存到数据库
        db.session.add(new_order)
        db.session.commit()
        
        # 7. 检查是否是红冲操作，如果是，则更新原订单
        if 'originalOrderId' in data:
            try:
                original_order_id = data['originalOrderId']
                original_order = Order.query.get(original_order_id)
                
                if original_order:
                    # 更新原订单的备注，添加【已被红冲】
                    original_remark = original_order.备注 or ''
                    if '【已被红冲】' not in original_remark:
                        original_order.备注 = f"{original_remark}【已被红冲】"
                    
                    # 设置原订单的红冲字段为1
                    original_order.红冲 = 1
                    
                    # 设置新创建的红冲订单的红冲字段为1
                    new_order.红冲 = 1
                    
                    # 提交更改
                    db.session.commit()
                    
                    app.logger.info(f"红冲操作完成：原订单ID {original_order_id}，新订单ID {new_order.订单ID}")
                else:
                    app.logger.warning(f"未找到原订单ID {original_order_id}")
                    
            except Exception as e:
                app.logger.error(f"红冲操作更新原订单失败: {str(e)}")
                db.session.rollback()
                # 不影响红冲订单的创建，只记录错误
        
        # 8. 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='生成账单',
            details=f'生成了账单号为 {bill_number} 的订单，金额 {data["totalAmount"]} 元',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '订单创建成功',
            'data': {
                'orderId': new_order.订单ID,
                'billNumber': bill_number,
                'totalAmount': float(data['totalAmount'])
            }
        })
    
    except SQLAlchemyError as e:
        db.session.rollback()
        app.logger.error(f"订单创建数据库错误: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '数据库保存失败'}), 500
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"订单创建未知错误: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '订单创建失败'}), 500

# 5. 查询订单列表
@app.route('/api/orders', methods=['GET'])
@token_required
def get_orders():
    """查询订单列表（支持筛选）"""
    current_user = g.current_user
    
    if not current_user.Read:
        return jsonify({'status': 'error', 'message': '当前用户没有读取权限'}), 403
    
    try:
        # 获取筛选参数
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 20))
        bill_number = request.args.get('billNumber', '').strip()
        start_date = request.args.get('startDate')
        end_date = request.args.get('endDate')
        address_id = request.args.get('addressId')
        
        # 构建基础查询
        query = Order.query
        
        # 权限过滤：管理员看所有，操作员只看自己小区的订单
        if current_user.Role != '系统管理员':
            # 直接通过小区ID过滤
            query = query.filter(Order.小区ID == current_user.小区编号)
        
        # 应用筛选条件
        if bill_number:
            query = query.filter(Order.账单号.like(f'%{bill_number}%'))
        if address_id:
            query = query.filter(Order.地址ID == address_id)
        if start_date:
            query = query.filter(Order.录入时间 >= start_date)
        if end_date:
            # 结束日期加一天，包含当天的所有记录
            from datetime import datetime as dt, timedelta
            end_date_obj = dt.strptime(end_date, '%Y-%m-%d') if end_date else None
            if end_date_obj:
                end_date_obj = end_date_obj + timedelta(days=1)
                query = query.filter(Order.录入时间 < end_date_obj)
        
        # 执行分页查询
        pagination = query.order_by(Order.录入时间.desc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False
        )
        
        orders = pagination.items
        result = [order.to_dict() for order in orders]
        
        return jsonify({
            'status': 'success',
            'data': result,
            'pagination': {
                'page': pagination.page,
                'per_page': pagination.per_page,
                'total': pagination.total,
                'pages': pagination.pages
            }
        })
    
    except Exception as e:
        app.logger.error(f"查询订单异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '查询订单失败'}), 500

# 6. 获取订单详情
# 在现有的获取订单详情API中，也需要调整费用项目的返回格式
# 找到现有的 get_order_detail 函数，修改费用项目的构建方式

@app.route('/api/orders/<int:order_id>', methods=['GET'])
@token_required
def get_order(order_id):
    """获取单个订单详情 - 用于重打小票"""
    current_user = g.current_user
    
    try:
        # 查询订单
        order = Order.query.get(order_id)
        
        if not order:
            return jsonify({'status': 'error', 'message': '订单不存在'}), 404
        
        # 权限检查：管理员可以查看所有，操作员只能查看自己小区的订单
        if current_user.Role != '系统管理员':
            # 直接检查订单的小区ID是否与当前用户的小区编号匹配
            if order.小区ID != current_user.小区编号:
                return jsonify({'status': 'error', 'message': '没有权限查看此订单'}), 403
        
        # 获取地址信息
        address = order.地址 if hasattr(order, '地址') and order.地址 else None
        
        # 构建费用明细
        fee_details = []
        
        # 电费
        if order.电费金额 and float(order.电费金额) > 0:
            fee_details.append({
                'name': '电费',
                'quantity': float(order.电费度数) if order.电费度数 else 0,
                'unit': '度',
                'price': float(order.电费金额) / float(order.电费度数) if order.电费度数 and float(order.电费度数) > 0 else 0,
                'amount': float(order.电费金额)
            })
        
        # 冷水费
        if order.冷水金额 and float(order.冷水金额) > 0:
            fee_details.append({
                'name': '冷水费',
                'quantity': float(order.冷水吨数) if order.冷水吨数 else 0,
                'unit': '吨',
                'price': float(order.冷水金额) / float(order.冷水吨数) if order.冷水吨数 and float(order.冷水吨数) > 0 else 0,
                'amount': float(order.冷水金额)
            })
        
        # 热水费
        if order.热水金额 and float(order.热水金额) > 0:
            fee_details.append({
                'name': '热水费',
                'quantity': float(order.热水吨数) if order.热水吨数 else 0,
                'unit': '吨',
                'price': float(order.热水金额) / float(order.热水吨数) if order.热水吨数 and float(order.热水吨数) > 0 else 0,
                'amount': float(order.热水金额)
            })
        
        # 网费
        if order.网费金额 and float(order.网费金额) > 0:
            fee_details.append({
                'name': '网费',
                'quantity': int(order.网费月数) if order.网费月数 else 0,
                'unit': '月',
                'price': float(order.网费金额) / int(order.网费月数) if order.网费月数 and int(order.网费月数) > 0 else 0,
                'amount': float(order.网费金额)
            })
        
        # 停车费
        if order.停车费金额 and float(order.停车费金额) > 0:
            fee_details.append({
                'name': '停车费',
                'quantity': int(order.停车费月数) if order.停车费月数 else 0,
                'unit': '月',
                'price': float(order.停车费金额) / int(order.停车费月数) if order.停车费月数 and int(order.停车费月数) > 0 else 0,
                'amount': float(order.停车费金额),
                'carPlate': order.车牌号 if order.车牌号 else '',
                'startDate': order.停车开始日期.strftime('%Y-%m-%d') if order.停车开始日期 else '',
                'endDate': order.停车结束日期.strftime('%Y-%m-%d') if order.停车结束日期 else ''
            })
        
        # 房租
        if order.房租金额 and float(order.房租金额) > 0:
            fee_details.append({
                'name': '房租',
                'quantity': int(order.房租月数) if order.房租月数 else 0,
                'unit': '月',
                'price': float(order.房租金额) / int(order.房租月数) if order.房租月数 and int(order.房租月数) > 0 else 0,
                'amount': float(order.房租金额)
            })
        
        # 管理费
        if order.管理费金额 and float(order.管理费金额) > 0:
            fee_details.append({
                'name': '管理费',
                'quantity': int(order.管理费月数) if order.管理费月数 else 0,
                'unit': '月',
                'price': float(order.管理费金额) / int(order.管理费月数) if order.管理费月数 and int(order.管理费月数) > 0 else 0,
                'amount': float(order.管理费金额)
            })
        
        # 构建返回数据 - 注意：这里使用 录入时间 而不是 录入_time
        order_data = {
            'orderId': order.订单ID,
            'billNumber': order.账单号,
            'addressId': order.地址ID,  # 添加地址ID字段
            'entryTime': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
            'operator': current_user.用户姓名 if hasattr(current_user, '用户姓名') else current_user.USERNAME,
            'paymentMethod': order.收款方式,
            'totalAmount': float(order.收款金额) if order.收款金额 else 0,
            'remark': order.备注 if order.备注 else '',
            'redReverse': order.红冲,  # 添加红冲字段
            
            # 地址信息
            'address': {
                'building': address.楼栋号 if address else '',
                'room': address.房间号 if address else '',
                'residentName': address.姓名 if address else '',
                'residentPhone': address.手机号 if address else '',
                'community': address.小区编号 if address else ''
            },
            
            # 费用明细
            'feeDetails': fee_details
        }
        
        return jsonify({
            'status': 'success',
            'data': order_data
        })
    
    except Exception as e:
        app.logger.error(f"获取订单详情异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': f'获取订单详情失败: {str(e)}'}), 500

# 6.5. 删除订单
@app.route('/api/orders/<int:order_id>', methods=['DELETE'])
@token_required
def delete_order(order_id):
    """删除指定订单"""
    current_user = g.current_user
    
    try:
        # 查询订单
        order = Order.query.get(order_id)
        
        if not order:
            return jsonify({'status': 'error', 'message': '订单不存在'}), 404
        
        # 权限检查：系统管理员可以删除所有订单，小区经理可以删除自己小区的订单，操作员只能删除自己小区的订单
        if current_user.Role != '系统管理员':
            # 小区经理和操作员都只能删除自己小区的订单
            if order.小区ID != current_user.小区编号:
                return jsonify({'status': 'error', 'message': '没有权限删除此订单'}), 403
        
        # 记录订单信息用于日志
        bill_number = order.账单号
        amount = order.收款金额
        
        # 删除订单
        db.session.delete(order)
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='删除订单',
            details=f'删除了账单号为 {bill_number} 的订单，金额 {amount} 元',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '订单删除成功'
        })
    
    except SQLAlchemyError as e:
        db.session.rollback()
        app.logger.error(f"删除订单数据库错误: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '数据库操作失败'}), 500
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"删除订单异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '删除订单失败'}), 500





        
# 7. 操作日志查询（仅管理员）
@app.route('/api/operation-logs', methods=['GET'])
@token_required
def get_operation_logs():
    """查询操作日志（管理员权限）"""
    current_user = g.current_user
    
    # 仅管理员可查看操作日志
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        # 获取筛选参数
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 50))
        username = request.args.get('username', '').strip()
        operation_type = request.args.get('operationType', '').strip()
        start_date = request.args.get('startDate')
        end_date = request.args.get('endDate')
        
        # 构建查询
        query = OperationLog.query
        
        if username:
            query = query.filter(OperationLog.用户账号.like(f'%{username}%'))
        if operation_type:
            query = query.filter(OperationLog.操作类型.like(f'%{operation_type}%'))
        if start_date:
            query = query.filter(OperationLog.操作时间 >= start_date)
        if end_date:
            query = query.filter(OperationLog.操作时间 <= end_date)
        
        # 执行分页查询
        pagination = query.order_by(OperationLog.操作时间.desc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False
        )
        
        logs = pagination.items
        result = [
            {
                'id': log.ID,
                'username': log.用户账号,
                'operationTime': log.操作时间.strftime('%Y-%m-%d %H:%M:%S'),
                'ip': log.电脑IP or '',
                'computerName': log.电脑名称 or '',
                'operationType': log.操作类型,
                'details': log.操作详情 or '',
                'communityNum': log.小区编号 or 0
            }
            for log in logs
        ]
        
        return jsonify({
            'status': 'success',
            'data': result,
            'pagination': {
                'page': pagination.page,
                'per_page': pagination.per_page,
                'total': pagination.total,
                'pages': pagination.pages
            }
        })
    
    except Exception as e:
        app.logger.error(f"查询操作日志异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '查询日志失败'}), 500

# 8. 更新用户姓名（管理员权限）
@app.route('/api/users/<int:user_id>/update-name', methods=['POST'])
@token_required
def update_user_name(user_id):
    """更新用户姓名（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    data = request.get_json()
    real_name = data.get('real_name', '').strip()
    
    if not real_name:
        return jsonify({'status': 'error', 'message': '姓名不能为空'}), 400
    
    try:
        user = User.query.get(user_id)
        if not user:
            return jsonify({'status': 'error', 'message': '用户不存在'}), 404
        
        user.用户姓名 = real_name
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='更新用户信息',
            details=f'更新用户 [{user.USERNAME}] 的姓名为 [{real_name}]',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '用户姓名更新成功',
            'data': user.to_dict()
        })
    
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"更新用户姓名失败: {str(e)}")
        return jsonify({'status': 'error', 'message': '更新失败'}), 500

# 9. 更新地址的住户信息
@app.route('/api/addresses/<int:address_id>', methods=['PUT'])
@token_required
def update_address(address_id):
    """更新地址的住户信息"""
    current_user = g.current_user
    
    try:
        address = Address.query.get(address_id)
        if not address:
            return jsonify({'status': 'error', 'message': '地址不存在'}), 404
        
        # 权限检查：管理员或者同一小区的操作员可以修改
        if current_user.Role != '系统管理员' and address.小区编号 != current_user.小区编号:
            return jsonify({'status': 'error', 'message': '无权修改此地址'}), 403
        
        data = request.get_json()
        name = data.get('name', '').strip()
        phone = data.get('phone', '').strip()
        
        # 验证姓名（2-10个字符，支持中文和英文）
        if name:
            if not re.match(r'^[\u4e00-\u9fa5A-Za-z]{2,10}$', name):
                return jsonify({'status': 'error', 'message': '姓名格式不正确（2-10个中英文字符）'}), 400
        
        # 验证手机号（11位数字，1开头）
        if phone:
            if not re.match(r'^1[3-9]\d{9}$', phone):
                return jsonify({'status': 'error', 'message': '手机号格式不正确（11位数字，1开头）'}), 400
        
        # 更新字段（只有提供了值才更新）
        if 'name' in data:
            address.姓名 = name if name else None
        if 'phone' in data:
            address.手机号 = phone if phone else None
        
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='更新住户信息',
            details=f'更新地址 {address.楼栋号}{address.房间号} 的住户信息',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '住户信息更新成功',
            'data': address.to_dict()
        })
    
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"更新住户信息异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '更新住户信息失败'}), 500




# 1. 收费标准管理页面
@app.route('/admin/fee-prices')
@token_required
def fee_prices_admin_page():
    """收费标准管理页面"""
    current_user = g.current_user
    
    # 权限检查：仅管理员可访问
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    return render_template('fee_prices_admin.html')

# 2. 获取所有收费标准（管理员）
@app.route('/api/admin/fee_prices', methods=['GET'])
@token_required
def get_all_fee_prices():
    """获取所有小区的收费标准（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        # 获取分页参数
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 20))
        community = request.args.get('community', '').strip()
        
        # 构建查询
        query = FeePrice.query
        
        # 搜索过滤
        if community:
            query = query.filter(FeePrice.community.like(f'%{community}%'))
        
        # 执行分页查询
        pagination = query.order_by(FeePrice.community.asc()).paginate(
            page=page,
            per_page=per_page,
            error_out=False
        )
        
        fee_prices = pagination.items
        result = [fee_price.to_dict() for fee_price in fee_prices]
        
        return jsonify({
            'status': 'success',
            'data': result,
            'pagination': {
                'page': pagination.page,
                'per_page': pagination.per_page,
                'total': pagination.total,
                'pages': pagination.pages
            }
        })
    
    except Exception as e:
        app.logger.error(f"获取收费标准异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取收费标准失败'}), 500

# 3. 创建收费标准
@app.route('/api/admin/fee_prices', methods=['POST'])
@token_required
def create_fee_price():
    """创建收费标准（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        data = request.get_json()
        
        # 验证必要字段
        if not data.get('community'):
            return jsonify({'status': 'error', 'message': '小区名称不能为空'}), 400
        
        # 检查小区是否已存在
        existing = FeePrice.query.filter_by(community=data['community']).first()
        if existing:
            return jsonify({'status': 'error', 'message': '该小区收费标准已存在'}), 400
        
        # 创建新的收费标准
        new_fee_price = FeePrice(
            community=data['community'],
            electricity=data.get('electricity', 0.00),
            coldWater=data.get('coldWater', 0.00),
            hotWater=data.get('hotWater', 0.00),
            network=data.get('network', 0.00),
            parking=data.get('parking', 0.00),
            rent_fee=data.get('rent', 0.00),
            manage_fee=data.get('management', 0.00)
        )
        
        db.session.add(new_fee_price)
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='创建收费标准',
            details=f'创建小区 [{data["community"]}] 的收费标准',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '收费标准创建成功',
            'data': new_fee_price.to_dict()
        })
    
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"创建收费标准异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '创建收费标准失败'}), 500

# 4. 更新收费标准
@app.route('/api/admin/fee_prices/<int:id>', methods=['PUT'])
@token_required
def update_fee_price(id):
    """更新收费标准（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        fee_price = FeePrice.query.get(id)
        if not fee_price:
            return jsonify({'status': 'error', 'message': '收费标准不存在'}), 404
        
        data = request.get_json()
        
        # 更新字段（除了小区名称，因为它是唯一标识）
        if 'electricity' in data:
            fee_price.electricity = data['electricity']
        if 'coldWater' in data:
            fee_price.coldWater = data['coldWater']
        if 'hotWater' in data:
            fee_price.hotWater = data['hotWater']
        if 'network' in data:
            fee_price.network = data['network']
        if 'parking' in data:
            fee_price.parking = data['parking']
        if 'rent' in data:
            fee_price.rent_fee = data['rent']
        if 'management' in data:
            fee_price.manage_fee = data['management']
        
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='更新收费标准',
            details=f'更新小区 [{fee_price.community}] 的收费标准',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '收费标准更新成功',
            'data': fee_price.to_dict()
        })
    
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"更新收费标准异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '更新收费标准失败'}), 500

# 5. 删除收费标准
@app.route('/api/admin/fee_prices/<int:id>', methods=['DELETE'])
@token_required
def delete_fee_price(id):
    """删除收费标准（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        fee_price = FeePrice.query.get(id)
        if not fee_price:
            return jsonify({'status': 'error', 'message': '收费标准不存在'}), 404
        
        # 检查是否有用户正在使用该收费标准
        # （这里可以根据实际情况添加检查逻辑）
        
        community_name = fee_price.community
        db.session.delete(fee_price)
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='删除收费标准',
            details=f'删除小区 [{community_name}] 的收费标准',
            community_num=current_user.小区编号
        )
        
        return jsonify({
            'status': 'success',
            'message': '收费标准删除成功'
        })
    
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"删除收费标准异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '删除收费标准失败'}), 500

# 6. 导出收费标准
@app.route('/api/admin/fee_prices/export', methods=['GET'])
@token_required
def export_fee_prices():
    """导出收费标准为Excel（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        # 获取所有收费标准
        fee_prices = FeePrice.query.order_by(FeePrice.community.asc()).all()
        
        # 创建一个Excel文件
        import io
        import pandas as pd
        
        # 准备数据
        data = []
        for fp in fee_prices:
            data.append({
                '小区名称': fp.community,
                '电费单价(元/度)': float(fp.electricity),
                '冷水费单价(元/吨)': float(fp.coldWater),
                '热水费单价(元/吨)': float(fp.hotWater),
                '网费单价(元/月)': float(fp.network),
                '停车费单价(元/月)': float(fp.parking),
                '创建时间': fp.created_at.strftime('%Y-%m-%d %H:%M:%S') if fp.created_at else '',
                '更新时间': fp.updated_at.strftime('%Y-%m-%d %H:%M:%S') if fp.updated_at else ''
            })
        
        df = pd.DataFrame(data)
        
        # 写入到BytesIO
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, index=False, sheet_name='收费标准')
        
        output.seek(0)
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='导出收费标准',
            details='导出了所有收费标准',
            community_num=current_user.小区编号
        )
        
        # 返回文件
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=f'收费标准_{datetime.now().strftime("%Y%m%d_%H%M%S")}.xlsx'
        )
    
    except Exception as e:
        app.logger.error(f"导出收费标准异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '导出失败'}), 500

# 7. 导入收费标准模板下载
@app.route('/api/admin/fee_prices/template', methods=['GET'])
@token_required
def download_fee_prices_template():
    """下载导入模板（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        import io
        import pandas as pd
        
        # 创建模板数据
        template_data = [{
            '小区名称': '示例小区1',
            '电费单价(元/度)': 0.85,
            '冷水费单价(元/吨)': 3.50,
            '热水费单价(元/吨)': 25.00,
            '网费单价(元/月)': 80.00,
            '停车费单价(元/月)': 150.00
        }, {
            '小区名称': '示例小区2',
            '电费单价(元/度)': 0.90,
            '冷水费单价(元/吨)': 3.80,
            '热水费单价(元/吨)': 28.00,
            '网费单价(元/月)': 90.00,
            '停车费单价(元/月)': 180.00
        }]
        
        df = pd.DataFrame(template_data)
        
        # 写入到BytesIO
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, index=False, sheet_name='收费标准模板')
            
            # 添加说明
            worksheet = writer.sheets['收费标准模板']
            worksheet.insert_rows(0, 2)
            worksheet.cell(row=1, column=1, value='说明：')
            worksheet.cell(row=2, column=1, value='1. 请勿修改列标题')
            worksheet.cell(row=3, column=1, value='2. 小区名称必须与User表中的COMMUNITY字段一致')
            worksheet.cell(row=4, column=1, value='3. 单价请填写数字，最多两位小数')
        
        output.seek(0)
        
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name='收费标准导入模板.xlsx'
        )
    
    except Exception as e:
        app.logger.error(f"下载模板异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '下载模板失败'}), 500

# 8. 导入收费标准
@app.route('/api/admin/fee_prices/import', methods=['POST'])
@token_required
def import_fee_prices():
    """导入收费标准（管理员权限）"""
    current_user = g.current_user
    
    if current_user.Role != '系统管理员':
        return jsonify({'status': 'error', 'message': '需要管理员权限'}), 403
    
    try:
        # 检查是否有文件上传
        if 'file' not in request.files:
            return jsonify({'status': 'error', 'message': '没有上传文件'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'status': 'error', 'message': '没有选择文件'}), 400
        
        # 检查文件扩展名
        allowed_extensions = {'.xlsx', '.xls', '.csv'}
        file_ext = os.path.splitext(file.filename)[1].lower()
        if file_ext not in allowed_extensions:
            return jsonify({'status': 'error', 'message': '只支持Excel和CSV格式'}), 400
        
        # 读取文件
        import pandas as pd
        
        if file_ext == '.csv':
            df = pd.read_csv(file)
        else:
            df = pd.read_excel(file)
        
        # 验证列名
        required_columns = ['小区名称', '电费单价(元/度)', '冷水费单价(元/吨)', 
                          '热水费单价(元/吨)', '网费单价(元/月)', '停车费单价(元/月)',
                          '房租单价(元/月)', '管理费单价(元/月)']
        
        for col in required_columns:
            if col not in df.columns:
                return jsonify({'status': 'error', 'message': f'缺少必要列: {col}'}), 400
        
        # 处理数据
        success_count = 0
        error_count = 0
        errors = []
        
        for index, row in df.iterrows():
            try:
                community = str(row['小区名称']).strip()
                if not community:
                    continue
                
                # 检查是否已存在
                existing = FeePrice.query.filter_by(community=community).first()
                
                if existing:
                    # 更新现有记录
                    existing.electricity = float(row['电费单价(元/度)'] or 0)
                    existing.coldWater = float(row['冷水费单价(元/吨)'] or 0)
                    existing.hotWater = float(row['热水费单价(元/吨)'] or 0)
                    existing.network = float(row['网费单价(元/月)'] or 0)
                    existing.parking = float(row['停车费单价(元/月)'] or 0)
                    existing.rent_fee = float(row['房租单价(元/月)'] or 0)
                    existing.manage_fee = float(row['管理费单价(元/月)'] or 0)
                    success_count += 1
                else:
                    # 创建新记录
                    new_fee_price = FeePrice(
                        community=community,
                        electricity=float(row['电费单价(元/度)'] or 0),
                        coldWater=float(row['冷水费单价(元/吨)'] or 0),
                        hotWater=float(row['热水费单价(元/吨)'] or 0),
                        network=float(row['网费单价(元/月)'] or 0),
                        parking=float(row['停车费单价(元/月)'] or 0),
                        rent_fee=float(row['房租单价(元/月)'] or 0),
                        manage_fee=float(row['管理费单价(元/月)'] or 0)
                    )
                    db.session.add(new_fee_price)
                    success_count += 1
                    
            except Exception as e:
                error_count += 1
                errors.append(f"第{index + 1}行: {str(e)}")
        
        db.session.commit()
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='导入收费标准',
            details=f'导入收费标准，成功{success_count}条，失败{error_count}条',
            community_num=current_user.小区编号
        )
        
        result = {
            'status': 'success',
            'message': f'导入完成，成功{success_count}条，失败{error_count}条',
            'success_count': success_count,
            'error_count': error_count
        }
        
        if errors:
            result['errors'] = errors[:10]  # 只返回前10个错误
        
        return jsonify(result)
    
    except Exception as e:
        db.session.rollback()
        app.logger.error(f"导入收费标准异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '导入失败'}), 500



# ========== 添加：获取最近订单的API ==========

# 在现有的API路由部分添加以下代码

@app.route('/api/recent-orders', methods=['GET'])
@token_required
def get_recent_orders():
    """获取今日收费记录（包含今日合计）"""
    current_user = g.current_user
    app.logger.info(f"获取今日收费记录，用户: {current_user.USERNAME}, 角色: {current_user.Role}")
    
    try:
        # 获取今天日期 - 使用本地时区确保正确过滤
        from datetime import date, datetime, timedelta
        
        # 获取当前本地时间
        now = datetime.now()
        today = now.date()
        
        # 使用本地时区创建日期范围
        today_start = datetime(today.year, today.month, today.day, 0, 0, 0)
        today_end = datetime(today.year, today.month, today.day, 23, 59, 59)
        
        app.logger.info(f"查询日期范围: {today_start} 到 {today_end}")
        
        # 构建基础查询 - 查询今日的订单
        query = Order.query.filter(Order.录入时间 >= today_start, Order.录入时间 <= today_end)
        
        # 权限过滤：管理员看所有，操作员只看自己小区的订单
        if current_user.Role != '系统管理员':
            # 如果当前登录用户的小区编号=1，则只筛选录入时间=今日日期
            if current_user.小区编号 == 1:
                app.logger.info(f"小区编号为1的用户，不限制小区筛选")
            else:
                # 否则筛选小区ID=当前登录用户的小区编号
                query = query.filter(Order.小区ID == current_user.小区编号)
                app.logger.info(f"非管理员用户，限制查询小区ID: {current_user.小区编号}")
        else:
            app.logger.info(f"管理员用户，查看所有小区订单")
        
        # 获取今日所有记录，按录入时间倒序
        orders = query.order_by(Order.录入时间.desc()).all()
        app.logger.info(f"查询到 {len(orders)} 条今日订单记录")
        
        result = []
        
        # 计算今日合计
        today_total = 0
        
        for order in orders:
            address = order.地址
            
            # 构建费用项目字符串
            fee_items = []
            
            # 电费
            if order.电费金额 and float(order.电费金额) > 0:
                degree = float(order.电费度数) if order.电费度数 else 0
                amount = float(order.电费金额) if order.电费金额 else 0
                fee_items.append(f"电费 | {degree}度 | ¥{amount:.2f}")
            
            # 冷水费
            if order.冷水金额 and float(order.冷水金额) > 0:
                ton = float(order.冷水吨数) if order.冷水吨数 else 0
                amount = float(order.冷水金额) if order.冷水金额 else 0
                fee_items.append(f"冷水费 | {ton}吨 | ¥{amount:.2f}")
            
            # 热水费
            if order.热水金额 and float(order.热水金额) > 0:
                ton = float(order.热水吨数) if order.热水吨数 else 0
                amount = float(order.热水金额) if order.热水金额 else 0
                fee_items.append(f"热水费 | {ton}吨 | ¥{amount:.2f}")
            
            # 网费
            if order.网费金额 and float(order.网费金额) > 0:
                month = order.网费月数 if order.网费月数 else 0
                amount = float(order.网费金额) if order.网费金额 else 0
                fee_items.append(f"网费 | {month}个月 | ¥{amount:.2f}")
            
            # 停车费
            if order.停车费金额 and float(order.停车费金额) > 0:
                month = order.停车费月数 if order.停车费月数 else 0
                amount = float(order.停车费金额) if order.停车费金额 else 0
                car_plate = order.车牌号 if order.车牌号 else ""
                
                # 格式化日期范围
                start_date = ""
                end_date = ""
                if order.停车开始日期:
                    start_date = order.停车开始日期.strftime('%Y/%m/%d')
                if order.停车结束日期:
                    end_date = order.停车结束日期.strftime('%Y/%m/%d')
                date_range = f"{start_date}-{end_date}" if start_date and end_date else ""
                
                # 按照用户要求的格式：停车费 | 1个月 | ¥130.00 | 2025/12/1-2025/12/31| 皖CMV152
                if car_plate and date_range:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | {date_range}| {car_plate}")
                elif car_plate:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | | {car_plate}")
                elif date_range:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | {date_range}| ")
                else:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | | ")
            
            # 房租
            if order.房租金额 and float(order.房租金额) > 0:
                months = int(order.房租月数) if order.房租月数 else 0
                amount = float(order.房租金额) if order.房租金额 else 0
                fee_items.append(f"房租 | {months}个月 | ¥{amount:.2f}")
            
            # 管理费
            if order.管理费金额 and float(order.管理费金额) > 0:
                months = int(order.管理费月数) if order.管理费月数 else 0
                amount = float(order.管理费金额) if order.管理费金额 else 0
                fee_items.append(f"管理费 | {months}个月 | ¥{amount:.2f}")
            
            # 计算今日合计 - 所有订单都是今日订单
            today_total += float(order.收款金额) if order.收款金额 else 0
            
            # 创建订单详情对象
            order_detail = {
                'orderId': order.订单ID,
                'billNumber': order.账单号,
                'addressId': order.地址ID,  # 添加地址ID字段
                'entryTime': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
                'building': address.楼栋号 if address else '',
                'room': address.房间号 if address else '',
                'residentName': address.姓名 if address else '',
                'residentPhone': address.手机号 if address else '',
                'feeItems': '\n'.join(fee_items),  # 使用换行符分隔
                'totalAmount': float(order.收款金额) if order.收款金额 else 0,
                'paymentMethod': order.收款方式,
                'remark': order.备注,
                'redReverse': order.红冲  # 添加红冲字段
            }
            
            result.append(order_detail)
        
        app.logger.info(f"返回今日收费记录: {len(result)} 条, 今日合计: {today_total}")
        return jsonify({
            'status': 'success',
            'data': {
                'orders': result,
                'todayTotal': today_total
            }
        })
    
    except Exception as e:
        app.logger.error(f"获取最近订单异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取最近订单失败'}), 500






# ========== 添加：获取用户历史缴费记录API ==========
@app.route('/api/user-payment-history', methods=['GET'])
@token_required
def get_user_payment_history():
    """获取指定用户的历史缴费记录"""
    current_user = g.current_user
    
    try:
        # 获取请求参数
        address_id = request.args.get('address_id')
        limit = int(request.args.get('limit', 10))  # 默认获取最近10条记录
        
        if not address_id:
            return jsonify({'status': 'error', 'message': '地址ID不能为空'}), 400
        
        # 构建查询：根据地址ID查询订单
        query = Order.query.filter(Order.地址ID == address_id)
        
        # 权限过滤：管理员看所有，操作员只看自己小区的订单
        if current_user.Role != '系统管理员':
            query = query.join(Address).filter(Address.小区编号 == current_user.小区编号)
        
        # 获取最近N条记录，按录入时间倒序
        orders = query.order_by(Order.录入时间.desc()).limit(limit).all()
        
        result = []
        
        for order in orders:
            address = order.地址
            
            # 构建费用项目字符串
            fee_items = []
            
            # 电费
            if order.电费金额 and float(order.电费金额) > 0:
                degree = float(order.电费度数) if order.电费度数 else 0
                amount = float(order.电费金额) if order.电费金额 else 0
                fee_items.append(f"电费 | {degree}度 | ¥{amount:.2f}")
            
            # 冷水费
            if order.冷水金额 and float(order.冷水金额) > 0:
                ton = float(order.冷水吨数) if order.冷水吨数 else 0
                amount = float(order.冷水金额) if order.冷水金额 else 0
                fee_items.append(f"冷水费 | {ton}吨 | ¥{amount:.2f}")
            
            # 热水费
            if order.热水金额 and float(order.热水金额) > 0:
                ton = float(order.热水吨数) if order.热水吨数 else 0
                amount = float(order.热水金额) if order.热水金额 else 0
                fee_items.append(f"热水费 | {ton}吨 | ¥{amount:.2f}")
            
            # 网费
            if order.网费金额 and float(order.网费金额) > 0:
                month = order.网费月数 if order.网费月数 else 0
                amount = float(order.网费金额) if order.网费金额 else 0
                fee_items.append(f"网费 | {month}个月 | ¥{amount:.2f}")
            
            # 停车费
            if order.停车费金额 and float(order.停车费金额) > 0:
                month = order.停车费月数 if order.停车费月数 else 0
                amount = float(order.停车费金额) if order.停车费金额 else 0
                car_plate = order.车牌号 if order.车牌号 else ""
                
                # 格式化日期范围
                start_date = ""
                end_date = ""
                if order.停车开始日期:
                    start_date = order.停车开始日期.strftime('%Y/%m/%d')
                if order.停车结束日期:
                    end_date = order.停车结束日期.strftime('%Y/%m/%d')
                date_range = f"{start_date}-{end_date}" if start_date and end_date else ""
                
                if car_plate and date_range:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | {date_range} | {car_plate}")
                elif car_plate:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | | {car_plate}")
                elif date_range:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | {date_range} | ")
                else:
                    fee_items.append(f"停车费 | {month}个月 | ¥{amount:.2f} | | ")
            
            # 房租
            if order.房租金额 and float(order.房租金额) > 0:
                months = int(order.房租月数) if order.房租月数 else 0
                amount = float(order.房租金额) if order.房租金额 else 0
                fee_items.append(f"房租 | {months}个月 | ¥{amount:.2f}")
            
            # 管理费
            if order.管理费金额 and float(order.管理费金额) > 0:
                months = int(order.管理费月数) if order.管理费月数 else 0
                amount = float(order.管理费金额) if order.管理费金额 else 0
                fee_items.append(f"管理费 | {months}个月 | ¥{amount:.2f}")
            
            # 创建订单详情对象
            order_detail = {
                'orderId': order.订单ID,
                'billNumber': order.账单号,
                'entryTime': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
                'building': address.楼栋号 if address else '',
                'room': address.房间号 if address else '',
                'feeItems': '\n'.join(fee_items),  # 使用换行符分隔多个费用项目
                'paymentMethod': order.收款方式 if order.收款方式 else '',
                'totalAmount': float(order.收款金额) if order.收款金额 else 0,
                'remark': order.备注 if order.备注 else '',
                'redReverse': order.红冲  # 添加红冲字段
            }
            
            result.append(order_detail)
        
        return jsonify({
            'status': 'success',
            'data': {
                'orders': result,
                'count': len(result)
            }
        })
    
    except Exception as e:
        app.logger.error(f"获取用户历史缴费记录异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取用户历史缴费记录失败'}), 500


# ========== 添加：获取今日合计API ==========
@app.route('/api/today-total', methods=['GET'])
@token_required
def get_today_total():
    """获取今日收费金额合计"""
    current_user = g.current_user
    
    try:
        # 获取今天日期
        today = datetime.now().date()
        today_start = datetime.combine(today, datetime.min.time())
        today_end = datetime.combine(today, datetime.max.time())
        
        # 计算今日总金额
        query = Order.query.filter(Order.录入时间 >= today_start, Order.录入时间 <= today_end)
        
        # 权限过滤
        if current_user.Role != '系统管理员':
            query = query.join(Address).filter(Address.小区编号 == current_user.小区编号)
        
        total = query.with_entities(func.sum(Order.收款金额)).scalar()
        
        return jsonify({
            'status': 'success',
            'data': {
                'todayTotal': float(total or 0)
            }
        })
    
    except Exception as e:
        app.logger.error(f"获取今日合计异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取今日合计失败'}), 500


# ========== 订单查询API ==========
@app.route('/api/v1/orders/query', methods=['GET'])
@token_required
def query_orders():
    """订单查询页面专用API - 支持高级筛选和排序"""
    current_user = g.current_user
    
    if not current_user.Read:
        return jsonify({'status': 'error', 'message': '当前用户没有读取权限'}), 403
    
    try:
        # 获取筛选参数
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 10))
        start_time = request.args.get('startTime')  # 开始时间（YYYY-MM-DD HH:mm）
        end_time = request.args.get('endTime')      # 结束时间（YYYY-MM-DD HH:mm）
        building_id = request.args.get('buildingId')  # 楼栋ID
        room_id = request.args.get('roomId')          # 房间ID
        sort_column = request.args.get('sort', 'entryTime')  # 排序字段
        sort_order = request.args.get('order', 'desc')       # 排序方向
        
        app.logger.info(f"订单查询参数: page={page}, per_page={per_page}, startTime={start_time}, endTime={end_time}, buildingId={building_id}, roomId={room_id}, sort={sort_column}, order={sort_order}")
        
        # 构建基础查询
        query = Order.query.join(Address)
        
        # 权限过滤：管理员看所有，操作员只看自己小区的订单
        if current_user.Role != '系统管理员':
            query = query.filter(Address.小区编号 == current_user.小区编号)
        
        # 时间范围筛选
        if start_time:
            try:
                start_dt = datetime.strptime(start_time, '%Y-%m-%d %H:%M')
                query = query.filter(Order.录入时间 >= start_dt)
            except ValueError:
                return jsonify({'status': 'error', 'message': '开始时间格式错误，请使用 YYYY-MM-DD HH:mm 格式'}), 400
        
        if end_time:
            try:
                end_dt = datetime.strptime(end_time, '%Y-%m-%d %H:%M')
                query = query.filter(Order.录入时间 <= end_dt)
            except ValueError:
                return jsonify({'status': 'error', 'message': '结束时间格式错误，请使用 YYYY-MM-DD HH:mm 格式'}), 400
        
        # 楼栋筛选
        if building_id:
            query = query.filter(Address.楼栋号 == building_id)
        
        # 房间筛选
        if room_id:
            query = query.filter(Address.ID == room_id)
        
        # 排序处理
        if sort_column == 'orderId':
            order_field = Order.订单ID
        elif sort_column == 'totalAmount':
            order_field = Order.收款金额
        elif sort_column == 'entryTime':
            order_field = Order.录入时间
        else:
            order_field = Order.录入时间  # 默认按录入时间排序
        
        if sort_order == 'asc':
            query = query.order_by(order_field.asc())
        else:
            query = query.order_by(order_field.desc())
        
        # 执行分页查询
        pagination = query.paginate(
            page=page,
            per_page=per_page,
            error_out=False
        )
        
        # 构建返回数据
        orders_data = []
        for order in pagination.items:
            # 构建费用项目字符串
            fee_items = []
            
            # 电费
            if order.电费金额 and float(order.电费金额) > 0:
                degree = float(order.电费度数) if order.电费度数 else 0
                amount = float(order.电费金额) if order.电费金额 else 0
                fee_items.append(f"电费 | {degree}度 | ¥{amount:.2f}")
            
            # 冷水费
            if order.冷水金额 and float(order.冷水金额) > 0:
                ton = float(order.冷水吨数) if order.冷水吨数 else 0
                amount = float(order.冷水金额) if order.冷水金额 else 0
                fee_items.append(f"冷水费 | {ton}吨 | ¥{amount:.2f}")
            
            # 热水费
            if order.热水金额 and float(order.热水金额) > 0:
                ton = float(order.热水吨数) if order.热水吨数 else 0
                amount = float(order.热水金额) if order.热水金额 else 0
                fee_items.append(f"热水费 | {ton}吨 | ¥{amount:.2f}")
            
            # 网费
            if order.网费金额 and float(order.网费金额) > 0:
                months = int(order.网费月数) if order.网费月数 else 0
                amount = float(order.网费金额) if order.网费金额 else 0
                fee_items.append(f"网费 | {months}个月 | ¥{amount:.2f}")
            
            # 停车费
            if order.停车费金额 and float(order.停车费金额) > 0:
                months = int(order.停车费月数) if order.停车费月数 else 0
                amount = float(order.停车费金额) if order.停车费金额 else 0
                
                # 添加日期范围和车牌信息
                date_range = ""
                car_plate = ""
                
                if order.停车开始日期 and order.停车结束日期:
                    start_date = order.停车开始日期.strftime('%Y/%m/%d')
                    end_date = order.停车结束_date.strftime('%Y/%m/%d')
                    date_range = f"{start_date}-{end_date}"
                
                if order.车牌号:
                    car_plate = order.车牌号
                
                if car_plate and date_range:
                    fee_items.append(f"停车费 | {months}个月 | ¥{amount:.2f} | {date_range} | {car_plate}")
                elif car_plate:
                    fee_items.append(f"停车费 | {months}个月 | ¥{amount:.2f} | | {car_plate}")
                elif date_range:
                    fee_items.append(f"停车费 | {months}个月 | ¥{amount:.2f} | {date_range} | ")
                else:
                    fee_items.append(f"停车费 | {months}个月 | ¥{amount:.2f} | | ")
            
            # 房租
            if order.房租金额 and float(order.房租金额) > 0:
                months = int(order.房租月数) if order.房租月数 else 0
                amount = float(order.房租金额) if order.房租金额 else 0
                fee_items.append(f"房租 | {months}个月 | ¥{amount:.2f}")
            
            # 管理费
            if order.管理费金额 and float(order.管理费金额) > 0:
                months = int(order.管理费月数) if order.管理费月数 else 0
                amount = float(order.管理费金额) if order.管理费金额 else 0
                fee_items.append(f"管理费 | {months}个月 | ¥{amount:.2f}")
            
            # 构建订单对象
            order_data = {
                'orderId': order.订单ID,
                'billNumber': order.账单号,
                'entryTime': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
                'building': order.地址.楼栋号 if order.地址 else '',
                'room': order.地址.房间号 if order.地址 else '',
                'residentName': order.地址.姓名 if order.地址 else '',
                'residentPhone': order.地址.手机号 if order.地址 else '',
                'feeItems': '\n'.join(fee_items),  # 使用换行符分隔
                'totalAmount': float(order.收款金额) if order.收款金额 else 0,
                'paymentMethod': order.收款方式 or '',
                'remark': order.备注 or '',
                'redReverse': order.红冲  # 添加红冲字段
            }
            
            orders_data.append(order_data)
        
        return jsonify({
            'status': 'success',
            'data': orders_data,
            'pagination': {
                'page': pagination.page,
                'per_page': pagination.per_page,
                'total': pagination.total,
                'pages': pagination.pages
            }
        })
    
    except Exception as e:
        app.logger.error(f"订单查询异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '查询订单失败'}), 500
























# ========== 详细订单查询API ==========
@app.route('/api/orders/detailed', methods=['GET'])
@token_required
def get_orders_detailed():
    """详细订单查询 - 支持多条件筛选"""
    current_user = g.current_user
    
    if not current_user.Read:
        return jsonify({'status': 'error', 'message': '当前用户没有读取权限'}), 403
    
    try:
        # 获取筛选参数
        community = request.args.get('community', '').strip()  # 改为小区名称
        order_id = request.args.get('orderId', '').strip()
        building = request.args.get('building', '').strip()
        room = request.args.get('room', '').strip()
        fee_type = request.args.get('feeType', '').strip()
        payment_method = request.args.get('paymentMethod', '').strip()
        start_date = request.args.get('startDate', '').strip()
        end_date = request.args.get('endDate', '').strip()
        
        # 构建基础查询 - 联表查询
        query = db.session.query(Order, Address, User).join(
            Address, Order.地址ID == Address.ID
        ).join(
            User, Order.操作员ID == User.ID
        )
        
        # 权限过滤：管理员看所有，操作员只看自己小区的订单
        if current_user.Role != '系统管理员':
            query = query.filter(Order.小区ID == current_user.小区编号)
        
        # 应用筛选条件
        if community:  # 通过小区名称筛选
            query = query.filter(User.COMMUNITY == community)
        
        if order_id:
            query = query.filter(Order.账单号.like(f'%{order_id}%'))
        
        if building:
            query = query.filter(Address.楼栋号.like(f'%{building}%'))
        
        if room:
            query = query.filter(Address.房间号.like(f'%{room}%'))
        
        if payment_method:
            query = query.filter(Order.收款方式 == payment_method)
        
        # 收费项目筛选 - 根据费用金额是否大于0判断
        if fee_type:
            fee_field_map = {
                'electricity': Order.电费金额,
                'coldWater': Order.冷水金额,
                'hotWater': Order.热水金额,
                'network': Order.网费金额,
                'parking': Order.停车费金额,
                'rent': Order.房租金额,
                'management': Order.管理费金额
            }
            if fee_type in fee_field_map:
                query = query.filter(fee_field_map[fee_type] != None)
                query = query.filter(fee_field_map[fee_type] != 0)
        
        # 日期范围筛选 - 转换为datetime对象进行比较
        if start_date:
            start_date_obj = datetime.strptime(start_date, '%Y-%m-%d')
            query = query.filter(Order.录入时间 >= start_date_obj)
        if end_date:
            # 结束日期加一天，包含当天的所有记录
            end_date_obj = datetime.strptime(end_date, '%Y-%m-%d')
            end_date_obj = end_date_obj + timedelta(days=1)
            query = query.filter(Order.录入时间 < end_date_obj)
        
        # 执行查询，按时间倒序
        results = query.order_by(Order.录入时间.desc()).all()
        
        # 构建返回数据
        data = []
        for order, address, user in results:
            data.append({
                'orderId': order.账单号,
                'community': user.COMMUNITY or '',  # 添加小区字段
                'chargeDate': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
                'building': address.楼栋号,
                'room': address.房间号,
                'residentName': address.姓名 or '',
                'phone': address.手机号 or '',
                'totalAmount': float(order.收款金额) if order.收款金额 else 0,
                'paymentMethod': order.收款方式 or '',
                'electricityUsage': float(order.电费度数) if order.电费度数 else None,
                'electricityAmount': float(order.电费金额) if order.电费金额 else 0,
                'hotWaterUsage': float(order.热水吨数) if order.热水吨数 else None,
                'hotWaterAmount': float(order.热水金额) if order.热水金额 else 0,
                'coldWaterUsage': float(order.冷水吨数) if order.冷水吨数 else None,
                'coldWaterAmount': float(order.冷水金额) if order.冷水金额 else 0,
                'internetMonths': int(order.网费月数) if order.网费月数 else None,
                'internetAmount': float(order.网费金额) if order.网费金额 else 0,
                'rentMonths': int(order.房租月数) if order.房租月数 else None,
                'rentAmount': float(order.房租金额) if order.房租金额 else 0,
                'managementMonths': int(order.管理费月数) if order.管理费月数 else None,
                'managementAmount': float(order.管理费金额) if order.管理费金额 else 0,
                'parkingMonths': int(order.停车费月数) if order.停车费月数 else None,
                'parkingAmount': float(order.停车费金额) if order.停车费金额 else 0,
                'licensePlate': order.车牌号 or '',
                'parkingStartDate': order.停车开始日期.strftime('%Y-%m-%d') if order.停车开始日期 else '',
                'parkingEndDate': order.停车结束日期.strftime('%Y-%m-%d') if order.停车结束日期 else '',
                'remark': order.备注 or ''
            })
        
        return jsonify({
            'status': 'success',
            'data': data
        })
    
    except Exception as e:
        app.logger.error(f"详细订单查询异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '查询订单失败'}), 500


# ========== 详细订单导出Excel API ==========
@app.route('/api/orders/detailed/export', methods=['GET'])
@token_required
def export_orders_detailed():
    """导出详细订单查询结果为Excel"""
    current_user = g.current_user
    
    if not current_user.Read:
        return jsonify({'status': 'error', 'message': '当前用户没有读取权限'}), 403
    
    try:
        # 获取筛选参数（与查询接口相同）
        community = request.args.get('community', '').strip()  # 改为小区名称
        order_id = request.args.get('orderId', '').strip()
        building = request.args.get('building', '').strip()
        room = request.args.get('room', '').strip()
        fee_type = request.args.get('feeType', '').strip()
        payment_method = request.args.get('paymentMethod', '').strip()
        start_date = request.args.get('startDate', '').strip()
        end_date = request.args.get('endDate', '').strip()
        
        # 构建基础查询 - 联表查询
        query = db.session.query(Order, Address, User).join(
            Address, Order.地址ID == Address.ID
        ).join(
            User, Order.操作员ID == User.ID
        )
        
        # 权限过滤
        if current_user.Role != '系统管理员':
            query = query.filter(Order.小区ID == current_user.小区编号)
        
        # 应用筛选条件
        if community:  # 通过小区名称筛选
            query = query.filter(User.COMMUNITY == community)
        if order_id:
            query = query.filter(Order.账单号.like(f'%{order_id}%'))
        if building:
            query = query.filter(Address.楼栋号.like(f'%{building}%'))
        if room:
            query = query.filter(Address.房间号.like(f'%{room}%'))
        if payment_method:
            query = query.filter(Order.收款方式 == payment_method)
        if fee_type:
            fee_field_map = {
                'electricity': Order.电费金额,
                'coldWater': Order.冷水金额,
                'hotWater': Order.热水金额,
                'network': Order.网费金额,
                'parking': Order.停车费金额,
                'rent': Order.房租金额,
                'management': Order.管理费金额
            }
            if fee_type in fee_field_map:
                query = query.filter(fee_field_map[fee_type] != None)
                query = query.filter(fee_field_map[fee_type] != 0)
        # 日期范围筛选 - 转换为datetime对象进行比较
        if start_date:
            start_date_obj = datetime.strptime(start_date, '%Y-%m-%d')
            query = query.filter(Order.录入时间 >= start_date_obj)
        if end_date:
            end_date_obj = datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)
            query = query.filter(Order.录入时间 < end_date_obj)
        
        # 执行查询
        results = query.order_by(Order.录入时间.desc()).all()
        
        # 准备Excel数据
        data = []
        for idx, (order, address, user) in enumerate(results, start=1):
            data.append({
                '序号': idx,
                '小区': user.COMMUNITY or '',  # 改为小区
                '订单号': order.账单号,
                '收费日期': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
                '楼栋号': address.楼栋号,
                '房号': address.房间号,
                '姓名': address.姓名 or '',
                '电话': address.手机号 or '',
                '收费金额': float(order.收款金额) if order.收款金额 else 0,
                '收款方式': order.收款方式 or '',
                '电费度数': float(order.电费度数) if order.电费度数 else '',
                '电费金额': float(order.电费金额) if order.电费金额 else 0,
                '热水吨数': float(order.热水吨数) if order.热水吨数 else '',
                '热水金额': float(order.热水金额) if order.热水金额 else 0,
                '冷水吨数': float(order.冷水吨数) if order.冷水吨数 else '',
                '冷水金额': float(order.冷水金额) if order.冷水金额 else 0,
                '网费月数': int(order.网费月数) if order.网费月数 else '',
                '网费金额': float(order.网费金额) if order.网费金额 else 0,
                '房租月数': int(order.房租月数) if order.房租月数 else '',
                '房租金额': float(order.房租金额) if order.房租金额 else 0,
                '管理费月数': int(order.管理费月数) if order.管理费月数 else '',
                '管理费金额': float(order.管理费金额) if order.管理费金额 else 0,
                '停车费月数': int(order.停车费月数) if order.停车费月数 else '',
                '停车费金额': float(order.停车费金额) if order.停车费金额 else 0,
                '车牌号': order.车牌号 or '',
                '停车开始日期': order.停车开始日期.strftime('%Y-%m-%d') if order.停车开始日期 else '',
                '停车结束日期': order.停车结束日期.strftime('%Y-%m-%d') if order.停车结束日期 else '',
                '备注': order.备注 or ''
            })
        
        df = pd.DataFrame(data)
        
        # 写入到BytesIO
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            df.to_excel(writer, index=False, sheet_name='详细订单查询')
        
        output.seek(0)
        
        # 记录操作日志
        log_operation(
            user_account=current_user.USERNAME,
            operation_type='导出详细订单',
            details=f'导出了{len(data)}条详细订单数据',
            community_num=current_user.小区编号
        )
        
        # 返回文件
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name=f'详细订单查询_{datetime.now().strftime("%Y%m%d_%H%M%S")}.xlsx'
        )
    
    except Exception as e:
        app.logger.error(f"导出详细订单异常: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '导出失败'}), 500


# ========== 报表统计API ==========

@app.route('/api/reports/overview-stats', methods=['GET'])
@token_required
def get_overview_stats():
    """获取概览统计数据（总笔数、总金额、平均金额、最高单笔）"""
    try:
        current_user = g.current_user
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        community = request.args.get('community', '').strip()  # 获取小区参数
        
        if not start_date or not end_date:
            return jsonify({'status': 'error', 'message': '请提供日期范围'}), 400
        
        # 根据权限构建查询 - 联表查询以获取小区信息
        if current_user.Role == '系统管理员':
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID)
        else:
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID).filter(Order.小区ID == current_user.小区编号)
        
        # 如果指定了小区，过滤小区
        if community:
            query = query.filter(User.COMMUNITY == community)
        
        # 过滤日期范围
        query = query.filter(
            Order.录入时间 >= datetime.strptime(start_date, '%Y-%m-%d'),
            Order.录入时间 < datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)
        )
        
        results = query.all()
        orders = [order for order, user in results]  # 提取Order对象
        
        # 计算统计数据
        total_count = len(orders)
        total_amount = sum(float(order.收款金额) for order in orders)
        avg_amount = total_amount / total_count if total_count > 0 else 0
        max_amount = max((float(order.收款金额) for order in orders), default=0)
        
        # 计算环比增长（与上个相同时间段对比）
        start_dt = datetime.strptime(start_date, '%Y-%m-%d')
        end_dt = datetime.strptime(end_date, '%Y-%m-%d')
        days_diff = (end_dt - start_dt).days + 1
        
        prev_start = start_dt - timedelta(days=days_diff)
        prev_end = start_dt - timedelta(days=1)
        
        # 查询上期数据
        if current_user.Role == '系统管理员':
            prev_query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID)
        else:
            prev_query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID).filter(Order.小区ID == current_user.小区编号)
        
        # 如果指定了小区，过滤小区
        if community:
            prev_query = prev_query.filter(User.COMMUNITY == community)
        
        prev_query = prev_query.filter(
            Order.录入时间 >= prev_start,
            Order.录入时间 < prev_end + timedelta(days=1)
        )
        
        prev_results = prev_query.all()
        prev_orders = [order for order, user in prev_results]
        prev_count = len(prev_orders)
        prev_amount = sum(float(order.收款金额) for order in prev_orders)
        
        # 计算增长率
        count_change = round(((total_count - prev_count) / prev_count * 100) if prev_count > 0 else 0, 1)
        amount_change = round(((total_amount - prev_amount) / prev_amount * 100) if prev_amount > 0 else 0, 1)
        
        return jsonify({
            'status': 'success',
            'data': {
                'totalCount': total_count,
                'totalAmount': round(total_amount, 2),
                'avgAmount': round(avg_amount, 2),
                'maxAmount': round(max_amount, 2),
                'countChange': count_change,
                'amountChange': amount_change
            }
        })
    
    except Exception as e:
        app.logger.error(f"获取概览统计失败: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取数据失败'}), 500


@app.route('/api/reports/time-stats', methods=['GET'])
@token_required
def get_time_statistics():
    """获取时间维度统计数据（按天/周/月）"""
    try:
        current_user = g.current_user
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        dimension = request.args.get('dimension', 'day')  # day/week/month
        community = request.args.get('community', '').strip()  # 获取小区参数
        
        if not start_date or not end_date:
            return jsonify({'status': 'error', 'message': '请提供日期范围'}), 400
        
        # 根据权限构建查询 - 联表查询
        if current_user.Role == '系统管理员':
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID)
        else:
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID).filter(Order.小区ID == current_user.小区编号)
        
        # 如果指定了小区，过滤小区
        if community:
            query = query.filter(User.COMMUNITY == community)
        
        # 过滤日期范围
        query = query.filter(
            Order.录入时间 >= datetime.strptime(start_date, '%Y-%m-%d'),
            Order.录入时间 < datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)
        )
        
        results = query.all()
        orders = [order for order, user in results]
        
        # 按维度聚合数据
        stats_dict = {}
        
        for order in orders:
            if dimension == 'day':
                key = order.录入时间.strftime('%Y-%m-%d')
                display_key = order.录入时间.strftime('%m月%d日')  # 显示用
            elif dimension == 'week':
                # 计算周（周一开始）
                week_start = order.录入时间 - timedelta(days=order.录入时间.weekday())
                week_end = week_start + timedelta(days=6)
                # 使用周一日期作为排序key
                key = week_start.strftime('%Y-%m-%d')
                # 显示格式：12月23日-12月29日
                if week_start.month == week_end.month:
                    display_key = f"{week_start.strftime('%m月%d日')}-{week_end.strftime('%d日')}"
                else:
                    display_key = f"{week_start.strftime('%m月%d日')}-{week_end.strftime('%m月%d日')}"
            else:  # month
                key = order.录入时间.strftime('%Y-%m')
                display_key = order.录入时间.strftime('%Y年%m月')  # 显示用
            
            if key not in stats_dict:
                stats_dict[key] = {'count': 0, 'amount': 0, 'display': display_key}
            
            stats_dict[key]['count'] += 1
            stats_dict[key]['amount'] += float(order.收款金额)
        
        # 排序并转换为列表
        sorted_keys = sorted(stats_dict.keys())
        labels = [stats_dict[k]['display'] for k in sorted_keys]  # 使用友好的显示格式
        counts = [stats_dict[k]['count'] for k in sorted_keys]
        amounts = [round(stats_dict[k]['amount'], 2) for k in sorted_keys]
        
        return jsonify({
            'status': 'success',
            'data': {
                'labels': labels,
                'counts': counts,
                'amounts': amounts
            }
        })
    
    except Exception as e:
        app.logger.error(f"获取时间统计失败: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取数据失败'}), 500


@app.route('/api/reports/payment-stats', methods=['GET'])
@token_required
def get_payment_statistics():
    """获取收款方式统计数据"""
    try:
        current_user = g.current_user
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        community = request.args.get('community', '').strip()  # 获取小区参数
        
        if not start_date or not end_date:
            return jsonify({'status': 'error', 'message': '请提供日期范围'}), 400
        
        # 根据权限构建查询 - 联表查询
        if current_user.Role == '系统管理员':
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID)
        else:
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID).filter(Order.小区ID == current_user.小区编号)
        
        # 如果指定了小区，过滤小区
        if community:
            query = query.filter(User.COMMUNITY == community)
        
        # 过滤日期范围
        query = query.filter(
            Order.录入时间 >= datetime.strptime(start_date, '%Y-%m-%d'),
            Order.录入时间 < datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)
        )
        
        results = query.all()
        orders = [order for order, user in results]
        
        # 按收款方式统计
        payment_stats = {}
        for order in orders:
            payment_method = order.收款方式 or '未知'
            if payment_method not in payment_stats:
                payment_stats[payment_method] = {'count': 0, 'amount': 0}
            
            payment_stats[payment_method]['count'] += 1
            payment_stats[payment_method]['amount'] += float(order.收款金额)
        
        # 转换为列表
        result = [
            {
                'name': name,
                'count': stats['count'],
                'amount': round(stats['amount'], 2)
            }
            for name, stats in payment_stats.items()
        ]
        
        # 按金额降序排列
        result.sort(key=lambda x: x['amount'], reverse=True)
        
        return jsonify({
            'status': 'success',
            'data': result
        })
    
    except Exception as e:
        app.logger.error(f"获取收款方式统计失败: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取数据失败'}), 500


@app.route('/api/reports/fee-type-stats', methods=['GET'])
@token_required
def get_fee_type_statistics():
    """获取收费项目统计数据"""
    try:
        current_user = g.current_user
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        community = request.args.get('community', '').strip()  # 获取小区参数
        
        if not start_date or not end_date:
            return jsonify({'status': 'error', 'message': '请提供日期范围'}), 400
        
        # 根据权限构建查询 - 联表查询
        if current_user.Role == '系统管理员':
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID)
        else:
            query = db.session.query(Order, User).join(User, Order.操作员ID == User.ID).filter(Order.小区ID == current_user.小区编号)
        
        # 如果指定了小区，过滤小区
        if community:
            query = query.filter(User.COMMUNITY == community)
        
        # 过滤日期范围
        query = query.filter(
            Order.录入时间 >= datetime.strptime(start_date, '%Y-%m-%d'),
            Order.录入时间 < datetime.strptime(end_date, '%Y-%m-%d') + timedelta(days=1)
        )
        
        results = query.all()
        orders = [order for order, user in results]
        
        # 收费项目映射
        fee_types = {
            '电费': ('电费金额',),
            '冷水费': ('冷水金额',),
            '热水费': ('热水金额',),
            '网费': ('网费金额',),
            '停车费': ('停车费金额',),
            '房租': ('房租金额',),
            '管理费': ('管理费金额',)
        }
        
        # 统计每个项目
        fee_stats = {}
        for fee_name, (amount_field,) in fee_types.items():
            fee_stats[fee_name] = {'count': 0, 'amount': 0}
        
        for order in orders:
            for fee_name, (amount_field,) in fee_types.items():
                amount = getattr(order, amount_field, 0)
                if amount and float(amount) > 0:
                    fee_stats[fee_name]['count'] += 1
                    fee_stats[fee_name]['amount'] += float(amount)
        
        # 转换为列表（只返回有数据的项目）
        result = [
            {
                'name': name,
                'count': stats['count'],
                'amount': round(stats['amount'], 2)
            }
            for name, stats in fee_stats.items()
            if stats['count'] > 0
        ]
        
        # 按金额降序排列
        result.sort(key=lambda x: x['amount'], reverse=True)
        
        return jsonify({
            'status': 'success',
            'data': result
        })
    
    except Exception as e:
        app.logger.error(f"获取收费项目统计失败: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'status': 'error', 'message': '获取数据失败'}), 500


# ========== 错误处理 ==========
@app.errorhandler(404)
def not_found(error):
    return jsonify({'status': 'error', 'message': '请求的资源不存在'}), 404

@app.errorhandler(500)
def internal_error(error):
    app.logger.error(f"服务器内部错误: {str(error)}")
    return jsonify({'status': 'error', 'message': '服务器内部错误'}), 500

# ========== 应用启动 ==========
if __name__ == '__main__':
    # 解析命令行参数
    import argparse
    parser = argparse.ArgumentParser(description='公寓物业收费系统 - Flask后端服务')
    parser.add_argument('--port', type=int, default=5000, help='服务端口号 (默认: 5000)')
    parser.add_argument('--host', default='0.0.0.0', help='服务主机地址 (默认: 0.0.0.0)')
    args = parser.parse_args()
    
    # 创建数据库表（如果不存在）
    with app.app_context():
        db.create_all()
    
    print("=" * 50)
    print("公寓物业收费系统 - 后端服务启动")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"数据库: {app.config.get('SQLALCHEMY_DATABASE_URI', '未配置')}")
    print(f"服务地址: http://{args.host}:{args.port}")
    print(f"测试页面: http://localhost:{args.port}/test")
    print("=" * 50)
    
    # 启动开发服务器
    # 生产环境建议使用 Gunicorn: gunicorn -w 4 -b 0.0.0.0:5000 app:app
    app.run(host=args.host, port=args.port, debug=True)