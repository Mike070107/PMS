#!/usr/bin/env python3
import sys
sys.path.append('/var/www/web_app')

from app import app, db, User, FeePrice

with app.app_context():
    print("=== 检查用户小区编号与收费标准ID的匹配关系 ===")
    
    # 1. 检查所有用户
    users = User.query.all()
    print(f"总用户数: {len(users)}")
    
    for user in users:
        print(f"\n用户: {user.USERNAME} (ID: {user.ID})")
        print(f"  小区编号: {user.小区编号}")
        print(f"  小区名称: {user.COMMUNITY}")
        
        if user.小区编号:
            # 通过id查询收费标准
            fee_price = FeePrice.query.get(user.小区编号)
            if fee_price:
                print(f"  ✅ 找到对应的收费标准 (ID: {fee_price.id})")
                print(f"     小区名称: {fee_price.community}")
                print(f"     电费单价: {fee_price.electricity}")
                print(f"     冷水费单价: {fee_price.coldWater}")
                print(f"     热水费单价: {fee_price.hotWater}")
                print(f"     网费单价: {fee_price.network}")
                print(f"     停车费单价: {fee_price.parking}")
            else:
                print(f"  ❌ 未找到ID为 {user.小区编号} 的收费标准")
        else:
            print(f"  ⚠ 用户未设置小区编号")
    
    # 2. 检查所有收费标准
    print("\n=== 所有收费标准 ===")
    prices = FeePrice.query.all()
    for price in prices:
        print(f"ID: {price.id}, 小区: {price.community}")
        print(f"  电费: {price.electricity}, 冷水: {price.coldWater}, 热水: {price.hotWater}")
        print(f"  网费: {price.network}, 停车费: {price.parking}")
    
    # 3. 生成关联报告
    print("\n=== 关联报告 ===")
    for user in users:
        if user.小区编号:
            fee = FeePrice.query.get(user.小区编号)
            if fee:
                print(f"✅ {user.USERNAME}: 小区编号={user.小区编号} → 收费标准ID={fee.id} ({fee.community})")
            else:
                print(f"❌ {user.USERNAME}: 小区编号={user.小区编号} → 无对应收费标准")
        else:
            print(f"⚠ {user.USERNAME}: 未设置小区编号")
