-- ================================================
-- 重置用户密码为明文密码
-- 执行方式：mysql -h192.168.1.250 -uWJWY -pWjWy.2017456 wjwy < reset_passwords_plaintext.sql
-- ================================================

USE wjwy;

-- 查看当前所有用户
SELECT '当前用户列表:' as '';
SELECT ID, USERNAME, COMMUNITY, Role, 
       CASE 
         WHEN PWD LIKE 'scrypt:%' OR PWD LIKE 'pbkdf2:%' OR PWD LIKE 'bcrypt:%' THEN '加密密码'
         ELSE CONCAT('明文(', LENGTH(PWD), '字符)')
       END as 密码类型
FROM users;

-- 重置所有用户密码为明文 'admin'
-- 如果需要为不同用户设置不同密码，可以修改下面的SQL

UPDATE users SET PWD = 'admin';

-- 显示更新后的结果
SELECT '' as '';
SELECT '密码已重置为明文' as '';
SELECT '' as '';
SELECT '更新后的用户列表:' as '';
SELECT ID, USERNAME, COMMUNITY, Role, PWD as 密码 
FROM users;

SELECT '' as '';
SELECT '所有用户密码已重置为: admin' as '提示';
