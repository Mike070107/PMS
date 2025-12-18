from app import app, db, Order, User
from datetime import datetime, date
import jwt

# 模拟API调用逻辑
def test_api_logic():
    with app.app_context():
        # 获取今天日期
        today = date.today()
        today_start = datetime.combine(today, datetime.min.time())
        today_end = datetime.combine(today, datetime.max.time())
        
        print(f"查询日期范围: {today_start} 到 {today_end}")
        
        # 模拟不同用户的查询
        users = [
            {"USERNAME": "admin", "小区编号": 1, "Role": "系统管理员"},
            {"USERNAME": "user1", "小区编号": 1, "Role": "操作员"},
            {"USERNAME": "user2", "小区编号": 2, "Role": "操作员"},
        ]
        
        for user_info in users:
            print(f"\n测试用户: {user_info['USERNAME']}, 小区编号: {user_info['小区编号']}, 角色: {user_info['Role']}")
            
            # 构建基础查询 - 查询今日的订单
            query = Order.query.filter(Order.录入时间 >= today_start, Order.录入时间 <= today_end)
            
            # 权限过滤：管理员看所有，操作员只看自己小区的订单
            if user_info['Role'] != '系统管理员':
                # 如果当前登录用户的小区编号=1，则只筛选录入时间=今日日期
                if user_info['小区编号'] == 1:
                    print(f"小区编号为1的用户，不限制小区筛选")
                else:
                    # 否则筛选小区ID=当前登录用户的小区编号
                    query = query.filter(Order.小区ID == user_info['小区编号'])
                    print(f"非管理员用户，限制查询小区ID: {user_info['小区编号']}")
            else:
                print(f"管理员用户，查看所有小区订单")
            
            # 获取今日所有记录，按录入时间倒序
            orders = query.order_by(Order.录入时间.desc()).all()
            print(f"查询到 {len(orders)} 条今日订单记录")
            
            # 计算今日合计
            today_total = 0
            for order in orders:
                today_total += float(order.收款金额) if order.收款金额 else 0
            
            print(f"今日收费金额合计: {today_total}")

if __name__ == "__main__":
    test_api_logic()