#!/usr/bin/env python3
import sys

with open('app.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

print("检查必要的导入:")
imports_required = [
    'from flask import',
    'from flask_jwt_extended import',
    'from datetime import timedelta',
    'from flask_cors import CORS',
    'from flask_sqlalchemy import SQLAlchemy'
]

for req in imports_required:
    found = any(req in line for line in lines[:50])
    if found:
        print(f"✅ {req}")
    else:
        print(f"❌ {req}")

# 特别检查 JWT 导入
jwt_imports = ['jwt_required', 'JWTManager', 'create_access_token', 'get_jwt_identity']
for imp in jwt_imports:
    if any(imp in line for line in lines):
        print(f"✅ {imp} 已导入")
    else:
        print(f"❌ {imp} 未导入")
