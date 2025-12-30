@echo off
echo 使用SSH密钥连接到服务器 192.168.1.251...
ssh -o StrictHostKeyChecking=no -i C:\Users\Administrator\.ssh\id_rsa_wjwy root@192.168.1.251
pause