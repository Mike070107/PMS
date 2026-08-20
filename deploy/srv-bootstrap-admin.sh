#!/bin/bash
set -e

ADMIN_USER='admin'
ADMIN_PASS='Admin@2026'
TENANT_NAME='演示物业'
ENV_FILE=/opt/pms-repair/apps/api/.env

# 1) 临时开 bootstrap（追加或替换 BOOTSTRAP_TOKEN）
BTOK=$(openssl rand -hex 16)
echo "BTOK=$BTOK"
if grep -q '^BOOTSTRAP_TOKEN=' "$ENV_FILE"; then
    sed -i "s|^BOOTSTRAP_TOKEN=.*|BOOTSTRAP_TOKEN=${BTOK}|" "$ENV_FILE"
else
    echo "BOOTSTRAP_TOKEN=${BTOK}" >> "$ENV_FILE"
fi
pm2 reload pms-api --update-env
sleep 3

# 2) 调 bootstrap-admin
echo "--- POST /api/v1/auth/bootstrap-admin ---"
curl -sS -X POST http://127.0.0.1:4000/api/v1/auth/bootstrap-admin \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"${BTOK}\",\"tenantName\":\"${TENANT_NAME}\",\"account\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\",\"name\":\"超级管理员\"}"
echo

# 3) 立刻关掉 bootstrap
sed -i 's|^BOOTSTRAP_TOKEN=.*|BOOTSTRAP_TOKEN=|' "$ENV_FILE"
pm2 reload pms-api --update-env
sleep 3

# 4) 试登
echo "--- POST /api/v1/auth/admin-login (验证) ---"
curl -sS -X POST http://127.0.0.1:4000/api/v1/auth/admin-login \
  -H 'Content-Type: application/json' \
  -d "{\"account\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}"
echo

# 5) 确认 bootstrap 已关
echo "--- 再调一次 bootstrap（应该报 disabled） ---"
curl -sS -X POST http://127.0.0.1:4000/api/v1/auth/bootstrap-admin \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"${BTOK}\",\"tenantName\":\"x\",\"account\":\"x2\",\"password\":\"xxxxxxxx\"}"
echo
