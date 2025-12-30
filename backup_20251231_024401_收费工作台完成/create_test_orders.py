from app import app, db, Order, User, Address
from datetime import datetime, date
import random

# 创建测试订单
def create_test_orders():
    with app.app_context():
        # 获取用户和地址
        users = User.query.all()
        addresses = Address.query.all()
        
        if not users or not addresses:
            print("没有用户或地址数据，无法创建测试订单")
            return
        
        print(f"找到 {len(users)} 个用户, {len(addresses)} 个地址")
        
        # 为不同小区创建今日测试订单
        today = datetime.now()
        
        # 为小区1创建2个订单
        for i in range(2):
            user = next((u for u in users if u.小区编号 == 1), users[0])
            address = random.choice(addresses)
            
            order = Order(
                账单号=f"TEST{today.strftime('%Y%m%d')}{i+1:03d}",
                地址ID=address.ID,
                操作员ID=user.ID,
                小区ID=1,  # 小区1的订单
                录入时间=today,
                电费度数=random.randint(50, 200),
                电费金额=random.uniform(50, 200),
                冷水吨数=random.randint(5, 20),
                冷水金额=random.uniform(20, 50),
                收款金额=random.uniform(100, 300),
                收款方式=random.choice(['微信', '支付宝', '现金']),
                备注='测试订单'
            )
            
            db.session.add(order)
        
        # 为小区2创建2个订单
        for i in range(2):
            user = next((u for u in users if u.小区编号 == 2), users[0])
            address = random.choice(addresses)
            
            order = Order(
                账单号=f"TEST{today.strftime('%Y%m%d')}{i+3:03d}",
                地址ID=address.ID,
                操作员ID=user.ID,
                小区ID=2,  # 小区2的订单
                录入时间=today,
                电费度数=random.randint(50, 200),
                电费金额=random.uniform(50, 200),
                冷水吨数=random.randint(5, 20),
                冷水金额=random.uniform(20, 50),
                收款金额=random.uniform(100, 300),
                收款方式=random.choice(['微信', '支付宝', '现金']),
                备注='测试订单'
            )
            
            db.session.add(order)
        
        # 提交到数据库
        db.session.commit()
        print("已创建4个测试订单（小区1和小区2各2个）")

if __name__ == "__main__":
    create_test_orders()