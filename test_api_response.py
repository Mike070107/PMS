from app import app, db, Order, User
from datetime import datetime, date
import json

# 模拟前端API调用
def test_api_response():
    with app.app_context():
        # 获取今天日期
        today = date.today()
        today_start = datetime.combine(today, datetime.min.time())
        today_end = datetime.combine(today, datetime.max.time())
        
        print(f"查询日期范围: {today_start} 到 {today_end}")
        
        # 模拟不同用户的API响应
        users = [
            {"USERNAME": "admin", "小区编号": 1, "Role": "系统管理员", "ID": 1},
            {"USERNAME": "user1", "小区编号": 1, "Role": "操作员", "ID": 2},
            {"USERNAME": "user2", "小区编号": 2, "Role": "操作员", "ID": 3},
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
            
            # 构建API响应数据
            result = []
            today_total = 0
            
            for order in orders:
                # 构建费用项目字符串
                fee_items = []
                
                # 电费
                if order.电费金额 and float(order.电费金额) > 0:
                    degree = float(order.电费度数) if order.电费度数 else 0
                    amount = float(order.电费金额) if order.电费金额 else 0
                    fee_items.append(f"电费 | {degree}度 | ¥{amount:.2f}")
                
                # 冷水费
                if order.冷水金额 and float(order.冷水金额) > 0:
                    ton = float(order.冷水吨数) if order.冷水吨数 else 0
                    amount = float(order.冷水金额) if order.冷水金额 else 0
                    fee_items.append(f"冷水费 | {ton}吨 | ¥{amount:.2f}")
                
                # 热水费
                if order.热水金额 and float(order.热水金额) > 0:
                    ton = float(order.热水吨数) if order.热水吨数 else 0
                    amount = float(order.热水金额) if order.热水金额 else 0
                    fee_items.append(f"热水费 | {ton}吨 | ¥{amount:.2f}")
                
                # 网费
                if order.网费金额 and float(order.网费金额) > 0:
                    months = int(order.网费月数) if order.网费月数 else 0
                    amount = float(order.网费金额) if order.网费金额 else 0
                    fee_items.append(f"网费 | {months}个月 | ¥{amount:.2f}")
                
                # 停车费
                if order.停车费金额 and float(order.停车费金额) > 0:
                    months = int(order.停车费月数) if order.停车费月数 else 0
                    amount = float(order.停车费金额) if order.停车费金额 else 0
                    fee_items.append(f"停车费 | {months}个月 | ¥{amount:.2f}")
                
                # 房租
                if order.房租金额 and float(order.房租金额) > 0:
                    months = int(order.房租月数) if order.房租月数 else 0
                    amount = float(order.房租金额) if order.房租金额 else 0
                    fee_items.append(f"房租 | {months}个月 | ¥{amount:.2f}")
                
                # 管理费
                if order.管理费金额 and float(order.管理费金额) > 0:
                    months = int(order.管理费月数) if order.管理费月数 else 0
                    amount = float(order.管理费金额) if order.管理费金额 else 0
                    fee_items.append(f"管理费 | {months}个月 | ¥{amount:.2f}")
                
                # 创建订单详情对象
                order_detail = {
                    'orderId': order.订单ID,
                    'billNumber': order.账单号,
                    'entryTime': order.录入时间.strftime('%Y-%m-%d %H:%M:%S') if order.录入时间 else '',
                    'building': order.地址.楼栋号 if order.地址 else '',
                    'room': order.地址.房间号 if order.地址 else '',
                    'residentName': order.地址.姓名 if order.地址 else '',
                    'residentPhone': order.地址.手机号 if order.地址 else '',
                    'feeItems': '，'.join(fee_items),  # 使用中文逗号分隔
                    'totalAmount': float(order.收款金额) if order.收款金额 else 0,
                    'paymentMethod': order.收款方式,
                    'remark': order.备注,
                    'operatorId': order.操作员ID
                }
                
                result.append(order_detail)
                today_total += float(order.收款金额) if order.收款金额 else 0
            
            # 模拟API响应
            api_response = {
                'status': 'success',
                'data': {
                    'orders': result,
                    'todayTotal': today_total
                }
            }
            
            print(f"API响应数据: {json.dumps(api_response, ensure_ascii=False, indent=2)}")
            
            # 模拟前端计算逻辑
            print("\n前端计算逻辑:")
            print(f"recentOrders长度: {len(result)}")
            
            # 筛选当前操作员的今日订单
            today_user_orders = []
            for order in result:
                # 检查是否是当前操作员的订单且是今日的
                order_date = datetime.strptime(order['entryTime'], '%Y-%m-%d %H:%M:%S').date()
                order_user_id = order['operatorId']
                
                if order_date == today and order_user_id == user_info['ID']:
                    today_user_orders.append(order)
            
            print(f"todayUserOrders长度: {len(today_user_orders)}")
            
            # 计算当前操作员的今日收费合计金额
            today_total_amount = 0
            for order in today_user_orders:
                today_total_amount += order['totalAmount']
            
            print(f"前端计算的今日收费金额合计: {today_total_amount}")

if __name__ == "__main__":
    test_api_response()