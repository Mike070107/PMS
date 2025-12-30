#!/usr/bin/env python3
import sys

# 读取 app.py 内容
with open('app.py', 'r', encoding='utf-8') as f:
    content = f.read()

# 检查是否已有 SECRET_KEY
if "SECRET_KEY" in content:
    print("✅ 文件中已存在 SECRET_KEY 配置")
    
    # 提取相关行
    lines = content.split('\n')
    for i, line in enumerate(lines):
        if 'SECRET_KEY' in line:
            print(f"   第{i+1}行: {line.strip()}")
else:
    print("❌ 文件中没有找到 SECRET_KEY 配置")
    
    # 查找配置部分位置
    config_section = -1
    for i, line in enumerate(lines):
        if 'app = Flask' in line:
            print(f"✅ 在第 {i+1} 行找到 Flask 应用定义")
            config_section = i + 1
            break
    
    if config_section > 0:
        # 在配置部分插入密钥配置
        insert_index = config_section
        for i in range(config_section, len(lines)):
            if 'app.config' in lines[i]:
                insert_index = i
                break
        
        # 构建插入内容
        insert_lines = [
            "# 安全密钥配置",
            "app.config['SECRET_KEY'] = 'wjwy-property-fee-system-2025'",
            "app.config['JWT_SECRET_KEY'] = 'wjwy-jwt-secret-2025'",
            "app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(hours=24)"
        ]
        
        # 插入新配置
        for line in reversed(insert_lines):
            lines.insert(insert_index + 1, line)
        
        # 写回文件
        with open('app.py', 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        
        print("✅ 已添加 SECRET_KEY 配置")
    else:
        print("❌ 无法找到配置插入位置")
