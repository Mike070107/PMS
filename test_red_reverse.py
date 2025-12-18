#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
测试红冲功能
"""

import requests
import json
from datetime import datetime

# 登录获取token
def login():
    login_url = "http://localhost:5000/api/login"
    login_data = {
        "username": "admin",
        "password": "admin"
    }
    
    try:
        response = requests.post(login_url, json=login_data)
        if response.status_code == 200:
            result = response.json()
            if result.get('status') == 'success':
                return result.get('token')  # Token is at root level, not in data
        print(f"登录失败: {response.text}")
        return None
    except Exception as e:
        print(f"登录异常: {str(e)}")
        return None

# 获取订单列表
def get_orders(token):
    orders_url = "http://localhost:5000/api/recent-orders"
    headers = {
        "Authorization": f"Bearer {token}"
    }
    
    try:
        response = requests.get(orders_url, headers=headers)
        if response.status_code == 200:
            result = response.json()
            if result.get('status') == 'success':
                return result.get('data', {}).get('orders', [])
        print(f"获取订单列表失败: {response.text}")
        return []
    except Exception as e:
        print(f"获取订单列表异常: {str(e)}")
        return []

# 获取订单详情
def get_order_detail(token, order_id):
    order_url = f"http://localhost:5000/api/orders/{order_id}"
    headers = {
        "Authorization": f"Bearer {token}"
    }
    
    try:
        response = requests.get(order_url, headers=headers)
        if response.status_code == 200:
            result = response.json()
            if result.get('status') == 'success':
                return result.get('data')
        print(f"获取订单详情失败: {response.text}")
        return None
    except Exception as e:
        print(f"获取订单详情异常: {str(e)}")
        return None

# 执行红冲操作
def create_red_reverse_order(token, original_order, reason):
    """创建红冲订单"""
    create_order_url = "http://localhost:5000/api/orders"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    # 构建红冲记录数据
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    red_reverse_data = {
        "addressId": original_order.get('addressId'),
        "paymentMethod": original_order.get('paymentMethod'),
        "totalAmount": -abs(original_order.get('totalAmount', 0)),  # 金额改为负数
        "remark": f"【红冲】\n原订单号：{original_order.get('billNumber')}\n原因：{reason}",
        "residentName": original_order.get('residentName'),
        "residentPhone": original_order.get('residentPhone'),
        "entryTime": current_time,
        "originalOrderId": original_order.get('orderId'),  # 添加原订单ID
        "items": []
    }
    
    # 处理费用项目
    fee_details = original_order.get('feeDetails', [])
    for item in fee_details:
        item_type = 'other'
        item_name = item.get('name', '').lower()
        
        if '电' in item_name:
            item_type = 'electricity'
        elif '热' in item_name:
            item_type = 'hotWater'
        elif '冷' in item_name:
            item_type = 'coldWater'
        elif '网' in item_name:
            item_type = 'network'
        elif '停' in item_name:
            item_type = 'parking'
        elif '房租' in item_name:
            item_type = 'rent'
        elif '管理费' in item_name:
            item_type = 'management'
            
        red_reverse_data['items'].append({
            "type": item_type,
            "quantity": item.get('quantity', 0),
            "unitPrice": item.get('price', 0),
            "amount": -abs(item.get('amount', 0))  # 金额改为负数
        })
    
    try:
        response = requests.post(create_order_url, headers=headers, json=red_reverse_data)
        if response.status_code == 200:
            result = response.json()
            print(f"红冲订单创建结果: {json.dumps(result, ensure_ascii=False, indent=2)}")
            return result
        else:
            print(f"创建红冲订单失败: {response.text}")
            return None
    except Exception as e:
        print(f"创建红冲订单异常: {str(e)}")
        return None

# 测试红冲功能
def test_red_reverse():
    print("===== 测试红冲功能 =====")
    
    # 1. 登录
    print("1. 登录系统...")
    token = login()
    if not token:
        print("登录失败，无法继续测试")
        return
    
    print("登录成功")
    
    # 2. 获取订单列表
    print("\n2. 获取订单列表...")
    orders = get_orders(token)
    if not orders:
        print("没有找到订单，无法继续测试")
        return
    
    print(f"找到 {len(orders)} 个订单")
    
    # 3. 选择第一个订单进行红冲
    original_order = orders[0]
    order_id = original_order.get('orderId')
    print(f"\n3. 选择订单 {order_id} 进行红冲测试")
    
    # 获取订单详情
    order_detail = get_order_detail(token, order_id)
    if not order_detail:
        print("获取订单详情失败，无法继续测试")
        return
    
    print(f"订单详情: {json.dumps(order_detail, ensure_ascii=False, indent=2)}")
    
    # 4. 执行红冲操作
    reason = "测试红冲功能"
    print(f"\n4. 执行红冲操作，原因: {reason}")
    
    red_reverse_result = create_red_reverse_order(token, order_detail, reason)
    if not red_reverse_result:
        print("红冲操作失败")
        return
    
    if red_reverse_result.get('status') == 'success':
        print("红冲操作成功")
        new_order_id = red_reverse_result.get('data', {}).get('orderId')
        print(f"新订单ID: {new_order_id}")
        
        # 5. 验证原订单是否被更新
        print("\n5. 验证原订单是否被更新...")
        updated_order_detail = get_order_detail(token, order_id)
        if updated_order_detail:
            print(f"更新后的订单详情: {json.dumps(updated_order_detail, ensure_ascii=False, indent=2)}")
            
            # 检查备注是否包含【已被红冲】
            remark = updated_order_detail.get('remark', '')
            if '【已被红冲】' in remark:
                print("✓ 原订单备注已更新，包含【已被红冲】")
            else:
                print("✗ 原订单备注未更新")
            
            # 检查红冲字段是否为1
            red_reverse_flag = updated_order_detail.get('redReverse', 0)
            if red_reverse_flag == 1:
                print("✓ 原订单红冲字段已更新为1")
            else:
                print(f"✗ 原订单红冲字段未更新，当前值: {red_reverse_flag}")
        
        # 6. 验证新红冲订单的红冲字段是否为1
        print("\n6. 验证新红冲订单的红冲字段...")
        new_order_detail = get_order_detail(token, new_order_id)
        if new_order_detail:
            print(f"新红冲订单详情: {json.dumps(new_order_detail, ensure_ascii=False, indent=2)}")
            
            # 检查红冲字段是否为1
            red_reverse_flag = new_order_detail.get('redReverse', 0)
            if red_reverse_flag == 1:
                print("✓ 新红冲订单的红冲字段已更新为1")
            else:
                print(f"✗ 新红冲订单的红冲字段未更新，当前值: {red_reverse_flag}")
    else:
        print(f"红冲操作失败: {red_reverse_result.get('message')}")

if __name__ == "__main__":
    test_red_reverse()