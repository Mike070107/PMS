#!/bin/bash
set -e

# 同一时间只允许一个部署在跑。
# 两个部署并行过一次（2026-08-25）：A 把 .env 挪到 /tmp/api.env.keep，B 紧接着解包写进了
# 打包机上的开发 .env，A 先把 keep 用掉，B 就没得还原 —— 线上 .env 变成本地开发库的密码，
# 接口全线连不上数据库。并行部署本来就没有意义，直接拦掉。
exec 9>/tmp/pms-deploy-api.lock
if ! flock -n 9; then
  echo "另一个部署正在进行，先等它跑完再来" >&2
  exit 1
fi

# 传了包路径就部署那一个（回滚用）；不传才取 /tmp 里最新的。2026-09-06 回滚时才发现原来一直不看参数，把坏包又装了一遍
PKG=${1:-$(ls -t /tmp/pms-api-*.tar.gz | head -1)}
if [ ! -f "$PKG" ]; then echo "包不存在：$PKG" >&2; exit 1; fi
echo "deploying: $PKG"

cd /opt/pms-repair/apps

# 快速包只包含新 dist 和运行元数据；依赖未变时保留服务器上的 node_modules，
# 避免每次发布重复上传约 87MB 的完整 API 包。快速包由 publish-production.ps1 生成，
# 依赖变化时仍会退回下面的完整包路径。
if tar -tzf "$PKG" 2>/dev/null | grep -qx 'api/.pms-fast-release'; then
  STAGE=$(mktemp -d /tmp/pms-api-fast.XXXXXX)
  OLD_DIST="/tmp/pms-api-dist.bak.$$"
  RESTORE_NEEDED=0
  cleanup_fast() {
    rm -rf "$STAGE"
    if [ "$RESTORE_NEEDED" = 1 ] && [ -d "$OLD_DIST" ]; then
      rm -rf api/dist
      mv "$OLD_DIST" api/dist
      pm2 reload pms-api --update-env >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_fast EXIT
  tar -xzf "$PKG" -C "$STAGE"
  if [ ! -f "$STAGE/api/dist/main.js" ]; then
    echo "!! 快速包缺少 api/dist/main.js，已中止" >&2
    exit 1
  fi
  for required in "$STAGE/api/package.json" "$STAGE/api/ecosystem.config.cjs"; do
    if [ ! -f "$required" ]; then
      echo "!! 快速包缺少 $(basename "$required")，已中止" >&2
      exit 1
    fi
  done
  mv api/dist "$OLD_DIST"
  RESTORE_NEEDED=1
  mv "$STAGE/api/dist" api/dist
  cp "$STAGE/api/package.json" api/package.json
  cp "$STAGE/api/ecosystem.config.cjs" api/ecosystem.config.cjs
  pm2 reload pms-api --update-env
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
  echo "--- 快速 API 健康检查 ---"
  wait_for_health http://127.0.0.1:4000/api/v1/health "api"
  wait_for_health https://prsznh.cn/api/v1/health "domain"
  rm -rf "$OLD_DIST"
  RESTORE_NEEDED=0
  trap - EXIT
  echo "--- 清理旧临时包（各类型保留最近 2 份） ---"
  ls -t /tmp/pms-api-*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f
  exit 0
fi

# 1) 备份现有 .env（万一被踩）
[ -f api/.env ] && cp api/.env /tmp/api.env.bak.$(date +%s)

# 2) 清旧产物（保留 .env，由解包后下一步处理）
#    keep 文件带上 pid：万一有人绕过锁并行跑，两边也不会抢同一个文件
KEEP=/tmp/api.env.keep.$$
mv api/.env "$KEEP" 2>/dev/null || true
rm -rf api/dist api/src api/node_modules api/package.json api/nest-cli.json        api/tsconfig.json api/ecosystem.config.cjs        api/.env.example api/.env.production.example 2>/dev/null

# 3) 解包
tar -xzf "$PKG"
# 部署包里本来就不该带 .env（pack.ps1 会剔掉）。真带了就是打包机的开发配置，
# 留着会顶掉线上密码 —— 一律删，线上 .env 只认第 4 步还原回来的那份。
if [ -f api/.env ]; then
  echo "!! 部署包里带了 .env（打包机的开发配置），已丢弃" >&2
  rm -f api/.env
fi

# 4) 还原 .env
mv "$KEEP" api/.env 2>/dev/null || true

# 4.5) 还原结果自检：reload 之前就要发现「.env 没了 / 不是线上那份」，
#      否则 pm2 起来连不上库，日志里只剩一堆 password authentication failed。
if [ ! -f api/.env ] || ! grep -q '^NODE_ENV=production' api/.env; then
  echo "!! api/.env 缺失或不是线上配置，已中止（没有 reload pm2）" >&2
  echo "   最近的备份：$(ls -t /tmp/api.env.bak.* 2>/dev/null | head -3 | tr '
' ' ')" >&2
  echo "   恢复：cp <备份> /opt/pms-repair/apps/api/.env && pm2 reload pms-api --update-env" >&2
  exit 1
fi

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

echo "--- 清理旧临时包（各类型保留最近 2 份） ---"
ls -t /tmp/pms-api-*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f
