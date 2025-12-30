# 公寓物业收费管理系统

## 项目简介
基于 Flask + Vue 3 + Element Plus 的物业收费管理系统，支持多种费用类型的收费管理、订单查询、报表统计等功能。

## 技术栈
- **后端**: Flask 3.1.2 + SQLAlchemy 2.0.35 + PyMySQL 1.1.2
- **前端**: Vue 3 + Element Plus + Flatpickr
- **数据库**: MySQL 8.0+

## 功能特性
- ✅ 用户登录认证（JWT Token）
- ✅ 多种费用类型管理（电费、水费、网费、停车费、房租、管理费）
- ✅ 订单生成与查询
- ✅ 退费功能
- ✅ 历史缴费记录查询
- ✅ 小区权限隔离
- ✅ 响应式界面设计

## 快速开始

### 1. 环境要求
- Python 3.8+
- MySQL 8.0+
- 推荐使用虚拟环境

### 2. 安装依赖
```bash
# 创建虚拟环境（可选但推荐）
python -m venv venv

# 激活虚拟环境
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt
```

### 3. 配置数据库
编辑 `config.py` 文件，修改数据库连接信息：
```python
SQLALCHEMY_DATABASE_URI = 'mysql+pymysql://用户名:密码@主机:端口/数据库名'
```

### 4. 运行应用
```bash
# Windows:
python app.py

# Linux:
python3 app.py
```

### 5. 访问系统
- 登录页面: http://localhost:5000/login
- 工作台: http://localhost:5000/
- 默认端口: 5000

## 项目结构
```
wjwy2/
├── app.py                  # Flask 主应用
├── config.py               # 配置文件
├── utils.py                # 工具函数
├── requirements.txt        # Python 依赖
├── templates/              # HTML 模板
│   ├── index.html         # 主工作台
│   ├── login.html         # 登录页面
│   ├── query.html         # 查询页面
│   └── ...
├── static/                 # 静态资源
│   └── lib/               # 第三方库
│       ├── vue.global.js
│       ├── element-plus.css
│       ├── element-plus.full.js
│       └── ...
└── logs/                   # 日志文件（自动生成）
```

## 版本标签
- `v1.0-stable-20251230`: 稳定版本 - 包含退费功能和所有静态资源

## 恢复到稳定版本
如果需要恢复到稳定版本：
```bash
# 使用标签恢复
git fetch --all
git checkout v1.0-stable-20251230

# 或使用提交 hash
git reset --hard e4192fd

# 从远程强制恢复
git fetch origin
git reset --hard origin/master
```

## 重要文件说明
- `app.py`: Flask 主程序，包含所有 API 路由
- `config.py`: 数据库和应用配置
- `utils.py`: 日志记录等工具函数
- `requirements.txt`: Python 依赖列表
- `templates/`: 前端页面模板
- `static/lib/`: 前端静态资源库

## 注意事项
1. 首次运行需要确保数据库已创建相应的表结构
2. 静态资源文件较大，确保完整克隆项目
3. 生产环境建议使用 gunicorn 或 uwsgi 部署
4. 修改 `SECRET_KEY` 和 `JWT_SECRET_KEY` 以提高安全性

## 许可证
仅限内部使用

## 联系方式
如有问题，请联系系统管理员
