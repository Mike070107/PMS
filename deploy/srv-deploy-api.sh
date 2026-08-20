#!/bin/bash
set -e

PKG=$(ls -t /tmp/pms-api-*.tar.gz | head -1)
echo "deploying: $PKG"

cd /opt/pms-repair/apps

# 1) 备份现有 .env（万一被踩）
[ -f api/.env ] && cp api/.env /tmp/api.env.bak.$(date +%s)

# 2) 清旧产物（保留 .env，由解包后下一步处理）
mv api/.env /tmp/api.env.keep 2>/dev/null || true
rm -rf api/dist api/src api/node_modules api/package.json api/nest-cli.json \
       api/tsconfig.json api/ecosystem.config.cjs \
       api/.env.example api/.env.production.example 2>/dev/null

# 3) 解包（部署包内不带 .env，安全）
tar -xzf "$PKG"

# 4) 还原 .env
mv /tmp/api.env.keep api/.env 2>/dev/null || true

echo "--- api/ 目录 ---"
ls api/ | head -20

# 5) reload pm2（--update-env 确保 .env 变更生效）
echo "--- pm2 reload ---"
pm2 reload pms-api --update-env

echo "--- pm2 status ---"
pm2 status

wait_for_health() {
  local url="$1"
  local label="$2"
  for i in $(seq 1 20); do
    if curl -fsS "$url"; then
      echo
      return 0
    fi
    echo "waiting for $label ($i/20)..." >&2
    sleep 1
  done
  echo "health check failed: $url" >&2
  return 1
}

echo "--- 直连 4000 健康检查 ---"
wait_for_health http://127.0.0.1:4000/api/v1/health "api"
echo "--- 域名入口健康检查 ---"
wait_for_health https://prsznh.cn/api/v1/health "domain"
