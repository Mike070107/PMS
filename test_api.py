import requests
import json

# Login to get a token
login_data = {
    'username': 'admin',
    'password': 'admin'
}

response = requests.post('http://localhost:5000/api/login', json=login_data)
print(f'Login response status: {response.status_code}')
if response.status_code == 200:
    result = response.json()
    print(f'Login response: {result}')
    if result.get('status') == 'success':
        token = result.get('token')  # Token is at root level, not in data
        print(f'Token: {token}')
        
        # Test the recent-orders API
        headers = {'Authorization': f'Bearer {token}'}
        orders_response = requests.get('http://localhost:5000/api/recent-orders', headers=headers)
        print(f'Orders response status: {orders_response.status_code}')
        if orders_response.status_code == 200:
            orders_result = orders_response.json()
            print(f'Orders response: {orders_result}')
        else:
            print(f'Orders error: {orders_response.text}')
    else:
        print(f'Login failed: {result.get("message")}')
else:
    print(f'Login error: {response.text}')