#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""下载favicon图标"""

import requests

# 使用Material Design Icons的公寓/建筑图标
# 颜色使用Element Plus的主题色 #409EFF
icon_url = "https://api.iconify.design/mdi:office-building.svg?color=%23409eff"

try:
    print("正在下载图标...")
    response = requests.get(icon_url, timeout=10)
    
    if response.status_code == 200:
        with open('static/favicon.ico', 'wb') as f:
            f.write(response.content)
        print(f"✓ 图标下载成功，大小: {len(response.content)} 字节")
        print(f"✓ 图标已保存到: static/favicon.ico")
    else:
        print(f"✗ 下载失败，HTTP状态码: {response.status_code}")
        
except Exception as e:
    print(f"✗ 下载失败: {e}")
    print("\n备用方案：使用本地SVG图标")
    
    # 创建一个漂亮的本地SVG图标
    svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <defs>
        <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#409EFF;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#66B1FF;stop-opacity:1" />
        </linearGradient>
    </defs>
    <rect fill="url(#grad1)" x="0" y="0" width="24" height="24" rx="4"/>
    <path fill="white" d="M12 3L2 8v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V8l-10-5zm0 2.18l7 3.5V14c0 4.52-2.98 8.69-7 9.93-4.02-1.24-7-5.41-7-9.93V8.68l7-3.5z"/>
    <path fill="white" d="M9 12h2v5H9v-5m4 0h2v5h-2v-5M9 9h2v2H9V9m4 0h2v2h-2V9"/>
</svg>'''
    
    with open('static/favicon.ico', 'w', encoding='utf-8') as f:
        f.write(svg_content)
    print("✓ 已创建本地SVG图标（建筑+盾牌样式）")
