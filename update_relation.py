#!/usr/bin/env python3
import sys
sys.path.append('/var/www/web_app')

from app import app, db, User, FeePrice

with app.app_context():
    print("=== 更新数据关联 ===")
    
    # 1. 确保 fee_prices 表中有正确的数据
    # 注意：id 值要与 users.小区编号 对应
    fee_prices_data = [
        {
            'id': 1,  # 这个ID会被users.小区编号引用
            'community': '馨香公寓马桥店',
            'electricity': 1.00,
            'coldWater': 2.00,
            'hotWater': 3.00,
            'network': 4.00,
            'parking': 5.00,
            'rent_fee': 1000.00,
            'manage_fee': 200.00
        },
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
        },
        {
            'id': 3,
            'community': '明月小区',
            'electricity': 0.68,
            'coldWater': 3.80,
            'hotWater': 28.00,
            'network': 85.00,
            'parking': 350.00,
            'rent_fee': 1100.00,
            'manage_fee': 220.00
        }
    ]
    
    for price_data in fee_prices_data:
        existing = FeePrice.query.get(price_data['id'])
        if not existing:
            fee_price = FeePrice(**price_data)
            db.session.add(fee_price)
            print(f"✅ 已创建收费标准 ID: {price_data['id']}, 小区: {price_data['community']}")
        else:
            # 更新现有记录
            for key, value in price_data.items():
                setattr(existing, key, value)
            print(f"✅ 已更新收费标准 ID: {price_data['id']}")
    
    # 2. 确保用户有正确的小区编号
    admin_user = User.query.filter_by(USERNAME='admin').first()
    if admin_user:
        admin_user.小区编号 = 1  # 对应 fee_prices.id = 1 (馨香公寓马桥店)
        admin_user.COMMUNITY = '馨香公寓马桥店'  # 同时更新小区名称
        print(f"✅ 已设置用户 '{admin_user.USERNAME}' 的小区编号为: {admin_user.小区编号}")
        print(f"   小区名称: {admin_user.COMMUNITY}")
    
    # 可以添加更多用户
    # user1 = User.query.filter_by(USERNAME='user1').first()
    # if user1:
    #     user1.小区编号 = 2  # 对应 fee_prices.id = 2 (阳光小区)
    #     user1.COMMUNITY = '阳光小区'
    
    db.session.commit()
    print("✅ 数据更新完成")
    
    # 3. 验证关联
    print("\n=== 验证关联 ===")
    if admin_user:
        fee = FeePrice.query.get(admin_user.小区编号)
        if fee:
            print(f"admin 用户关联验证:")
            print(f"  用户.小区编号: {admin_user.小区编号}")
            print(f"  收费标准.id: {fee.id}")
            print(f"  收费标准.小区: {fee.community}")
            print(f"  电费单价: {fee.electricity}")
        else:
            print(f"⚠ admin 用户的小区编号 {admin_user.小区编号} 没有对应的收费标准")