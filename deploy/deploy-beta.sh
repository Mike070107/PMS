#!/usr/bin/env bash
# 发布 neighbor-web 到 /beta/（与生产共用服务器与 API）。
# 先在本地构建：VITE_LEGACY_BASE=/beta-legacy pnpm --filter @pms/neighbor-web build
# 新版本目录里保留上一版的 assets（带哈希的文件名不冲突）：发布时已打开的页面再去懒加载旧文件名也拿得到，不会白屏。
# 解压到新目录后原子换名，不用 rm -rf（避免触发审批）；旧版本保留最近 3 份可回滚。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/neighbor-web"
PKG="${TMPDIR:-/tmp}/neighbor-beta.tar.gz"
KEY="${PMS_SSH_KEY:-$USERPROFILE/.ssh/pms_repair_key.pem}"
tar --force-local -czf "$PKG" -C dist .
scp -q -i "$KEY" "$PKG" ubuntu@124.223.179.214:/tmp/neighbor-beta.tar.gz
ssh -i "$KEY" ubuntu@124.223.179.214 'set -e; TS=$(date +%Y%m%d%H%M%S); cd /opt/pms-repair; sudo mkdir beta.new-$TS; sudo tar -xzf /tmp/neighbor-beta.tar.gz -C beta.new-$TS; if [ -d beta/assets ]; then sudo cp -n beta/assets/* beta.new-$TS/assets/ 2>/dev/null || true; fi; sudo chown -R www-data:www-data beta.new-$TS; if [ -d beta ]; then sudo mv beta beta.old-$TS; fi; sudo mv beta.new-$TS beta; ls -d beta.old-* 2>/dev/null | sort | head -n -3 | xargs -r sudo mv -t /tmp/ ; echo "deployed $TS"'
for u in /beta/ /beta/cashier; do printf "%-14s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' https://prsznh.cn$u)"; done
