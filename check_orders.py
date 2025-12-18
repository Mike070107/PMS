from app import app, db, Order
from datetime import datetime, date

with app.app_context():
    # 检查数据库中所有订单数量
    total_orders = Order.query.count()
    print(f'数据库中总订单数: {total_orders}')
    
    # 检查今日订单数量
    today = date.today()
    today_start = datetime.combine(today, datetime.min.time())
    today_end = datetime.combine(today, datetime.max.time())
    
    today_orders = Order.query.filter(Order.录入时间 >= today_start, Order.录入时间 <= today_end).all()
    print(f'今日订单数: {len(today_orders)}')
    
    # 检查最近几天的订单
    recent_orders = Order.query.order_by(Order.录入时间.desc()).limit(5).all()
    print(f'最近5条订单:')
    for order in recent_orders:
        print(f'  订单ID: {order.订单ID}, 录入时间: {order.录入时间}, 小区ID: {order.小区ID}, 收款金额: {order.收款金额}')