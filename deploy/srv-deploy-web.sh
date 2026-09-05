#!/bin/bash
set -e

WEB=/opt/pms-repair/web
# 传了包路径就部署那一个（回滚用）；不传才取 /tmp 里最新的（同 srv-deploy-api.sh，2026-09-06）
PKG=${1:-$(ls -t /tmp/pms-web-*.tar.gz | head -1)}
if [ ! -f "$PKG" ]; then echo "包不存在：$PKG" >&2; exit 1; fi
echo "deploying: $PKG"

BAK=/opt/pms-repair/web.bak.$(date +%s)
mv "$WEB" "$BAK"
mkdir -p "$WEB"
tar -xzf "$PKG" -C "$WEB"
if id nginx >/dev/null 2>&1; then
  sudo chown -R nginx:nginx "$WEB"
elif id www-data >/dev/null 2>&1; then
  sudo chown -R www-data:www-data "$WEB"
else
  echo "warning: neither nginx nor www-data user exists; keep current ownership"
fi

echo "--- $WEB ---"
ls "$WEB"

echo "--- smoke test ---"
printf 'home  : '; curl -sS -o /dev/null -w '%{http_code}\n' https://prsznh.cn/
printf 'spa   : '; curl -sS -o /dev/null -w '%{http_code}\n' https://prsznh.cn/dashboard
printf 'login : '; curl -sS -o /dev/null -w '%{http_code}\n' https://prsznh.cn/login
printf 'asset : '; curl -sS -o /dev/null -w '%{http_code}\n' "https://prsznh.cn/$(ls $WEB/assets | head -1 | xargs -I{} echo assets/{})"
echo '--- first 5 lines of index.html ---'
head -5 "$WEB/index.html"

echo '--- 保留最近 3 份 web 备份 ---'
ls -dt /opt/pms-repair/web.bak.* 2>/dev/null | tail -n +4 | xargs -r sudo rm -rf
ls -d /opt/pms-repair/web.bak.* 2>/dev/null
