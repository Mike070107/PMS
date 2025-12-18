#!/usr/bin/env python3
import sys
sys.path.append('/var/www/web_app')

from app import app, db, User, FeePrice

with app.app_context():
    print("=== 开始初始化数据 ===")
    
    # 1. 确保 fee_prices 表中有正确的数据（列存储结构）
    fee_prices_data = [
        {
            'id': 1,  # ID 应与 users.小区编号 对应
            'community': '馨香公寓马桥店',
            'electricity': 1.00,
            'coldWater': 2.00,
            'hotWater': 3.00,
            'network': 4.00,
            'parking': 5.00,
            'rent_fee': 1000.00,
            'manage_fee': 200.00
        },
        # 可以添加更多小区
        {
            'id': 2,
            'community': '阳光小区',
            'electricity': 0.65,
            'coldWater': 3.50,
            'hotWater': 25.00,
            'network': 80.00,
            'parking': 300.00,
            'rent_fee': 1200.00,
            'manage_fee': 250.00
        }
    ]
    
    for price_data in fee_prices_data:
        # 检查是否已存在
        existing = FeePrice.query.filter_by(community=price_data['community']).first()
        
        if not existing:
            fee_price = FeePrice(**price_data)
            db.session.add(fee_price)
            print(f"已创建收费标准: {price_data['community']}")
        else:
            # 更新现有记录
            for key, value in price_data.items():
                setattr(existing, key, value)
            print(f"已更新收费标准: {price_data['community']}")
    
    # 2. 确保用户有正确的小区名称
    admin_user = User.query.filter_by(USERNAME='admin').first()
    if admin_user:
        admin_user.COMMUNITY = '馨香公寓马桥店'  # 必须与 fee_prices.community 完全一致
        admin_user.小区编号 = 1  # 对应 fee_prices.id = 1
        print(f"已设置用户 '{admin_user.USERNAME}' 的小区: {admin_user.COMMUNITY}, 编号: {admin_user.小区编号}")
    
    db.session.commit()
    print("=== 数据初始化完成 ===")