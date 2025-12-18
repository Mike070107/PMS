from app import app, db, User

with app.app_context():
    admin_user = User.query.filter_by(USERNAME='admin').first()
    if admin_user:
        print(f'Admin user found: {admin_user.USERNAME}')
        print(f'Password field (PWD): {admin_user.PWD}')
        print(f'Role: {admin_user.Role}')
        print(f'Community: {admin_user.COMMUNITY}')
        print(f'Community Number: {admin_user.小区编号}')
    else:
        print('Admin user not found')