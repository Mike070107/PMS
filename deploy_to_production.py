#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生产环境部署脚本
用于在 Rocky Linux 9 等生产环境中快速部署应用
"""

import os
import sys
import subprocess
import shutil

def install_dependencies():
    """安装项目依赖"""
    print("正在安装项目依赖...")
    
    # 检查是否存在 requirements.txt
    if os.path.exists('requirements.txt'):
        try:
            subprocess.run([sys.executable, '-m', 'pip', 'install', '-r', 'requirements.txt'], check=True)
            print("✅ 依赖安装成功")
        except subprocess.CalledProcessError as e:
            print(f"❌ 依赖安装失败: {e}")
            return False
    else:
        print("❌ 未找到 requirements.txt 文件")
        return False
    
    return True

def copy_deploy_files():
    """复制部署所需的文件到目标目录"""
    print("正在准备部署文件...")
    
    # 确保 deploy_package 目录存在
    if not os.path.exists('deploy_package'):
        print("❌ deploy_package 目录不存在")
        return False
    
    # 复制核心文件
    core_files = [
        'app.py',
        'config.py',
        'utils.py',
        'log_utils.py'
    ]
    
    for file in core_files:
        src = os.path.join('deploy_package', file)
        dst = file
        if os.path.exists(src):
            shutil.copy2(src, dst)
            print(f"✅ 已复制 {file}")
        else:
            print(f"⚠️  源文件不存在: {src}")
    
    # 复制模板目录
    src_templates = os.path.join('deploy_package', 'templates')
    dst_templates = 'templates'
    if os.path.exists(src_templates):
        if os.path.exists(dst_templates):
            shutil.rmtree(dst_templates)
        shutil.copytree(src_templates, dst_templates)
        print(f"✅ 已复制 templates 目录")
    
    # 复制静态文件目录
    src_static = os.path.join('deploy_package', 'static')
    dst_static = 'static'
    if os.path.exists(src_static):
        if os.path.exists(dst_static):
            shutil.rmtree(dst_static)
        shutil.copytree(src_static, dst_static)
        print(f"✅ 已复制 static 目录")
    
    return True

def main():
    """主函数"""
    print("公寓物业收费系统 - 生产环境部署工具")
    print("="*50)
    
    # 安装依赖
    if not install_dependencies():
        print("依赖安装失败，部署中止")
        sys.exit(1)
    
    # 准备部署文件
    if not copy_deploy_files():
        print("文件复制失败，部署中止")
        sys.exit(1)
    
    print("\n🎉 部署准备完成!")
    print("接下来您可以:")
    print("1. 检查并修改 config.py 中的数据库配置")
    print("2. 启动应用: python app.py")

if __name__ == "__main__":
    main()