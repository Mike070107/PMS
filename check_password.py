from app import app, User, db

with app.app_context():
    admin_user = User.query.filter_by(USERNAME='admin').first()
    if admin_user:
        print(f"找到admin用户，检查密码验证:")
        print(f"密码'admin123'验证结果: {admin_user.check_password('admin123')}")
        print(f"密码'admin'验证结果: {admin_user.check_password('admin')}")
        print(f"密码'123456'验证结果: {admin_user.check_password('123456')}")
    else:
        print("未找到admin用户")