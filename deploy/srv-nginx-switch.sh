#!/bin/bash
set -e

# nginx 已在前一步切完 + reload 完，这里只做烟雾测试
echo "--- 当前 nginx 配置（应已是新版，含 admin-web）---"
grep -c admin-web /etc/nginx/conf.d/pms-api.conf
echo "--- web 目录 ---"
ls /opt/pms-repair/web/

echo "--- smoke test ---"
printf 'static : '; curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/
printf 'spa    : '; curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/dashboard
printf 'api    : '; curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/v1/health
echo '--- /api/v1/health body ---'
curl -sS http://127.0.0.1/api/v1/health
echo
