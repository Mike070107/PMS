#!/usr/bin/env python3
import re

# 读取原文件
with open('app.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. 确保有必要的导入
imports_to_add = []
if 'from flask_jwt_extended import' not in content:
    imports_to_add.append("from flask_jwt_extended import JWTManager, jwt_required, create_access_token, get_jwt_identity")
if 'from datetime import timedelta' not in content:
    imports_to_add.append("from datetime import timedelta")

if imports_to_add:
    # 在第一个import后面添加
    lines = content.split('\n')
    new_lines = []
    added = False
    for line in lines:
        new_lines.append(line)
        if line.startswith('from flask import') and not added:
            for imp in imports_to_add:
                new_lines.append(imp)
            added = True
    
    content = '\n'.join(new_lines)

# 2. 添加配置
if "app.config['SECRET_KEY']" not in content:
    # 找到 app = Flask(...) 之后的位置
    lines = content.split('\n')
    new_lines = []
    found_flask = False
    for i, line in enumerate(lines):
        new_lines.append(line)
        if 'app = Flask' in line and not found_flask:
            # 在这个后面添加配置
            config_lines = [
                "",
                "# 安全配置",
                "app.config['SECRET_KEY'] = 'wjwy-property-system-2025'",
                "app.config['JWT_SECRET_KEY'] = 'wjwy-jwt-token-2025'",
                "app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=24)",
                ""
            ]
            new_lines.extend(config_lines)
            found_flask = True
    
    content = '\n'.join(new_lines)

# 3. 确保有 JWT 初始化
if 'jwt = JWTManager(app)' not in content:
    lines = content.split('\n')
    new_lines = []
    for line in lines:
        new_lines.append(line)
        if 'CORS(app)' in line:
            new_lines.append('jwt = JWTManager(app)')
    
    content = '\n'.join(new_lines)

# 写回文件
with open('app.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("✅ 快速修复完成")
