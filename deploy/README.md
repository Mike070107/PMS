# Deploy Runbook · pms-repair

目标：腾讯云轻量 2C2G **Ubuntu**，单机跑 NestJS API + Postgres + Redis；对象存储用腾讯云 COS（托管，不本地部署）。

**生产入口**：`https://prsznh.cn/`
**生产实例**：`ubuntu@1.15.172.131`（使用 `~/.ssh/pms_repair_key.pem`）
**安装路径**：`/opt/pms-repair/`

## 拓扑

```
公网域名 : 443  ──►  nginx (静态站 + 反向代理)
                                  │
                                  └──►  127.0.0.1:4000  Node + pm2 (pms-api)
                                                │
                                                ├─► 127.0.0.1:5433  postgres (docker)
                                                └─► 127.0.0.1:6380  redis (docker)

对象存储 ──►  https://property-repair-2026-1259497259.cos.ap-shanghai.myqcloud.com (托管)
```

所有依赖端口只绑 `127.0.0.1`。腾讯云控制台防火墙规则需保留：22 (SSH)、80/443 (nginx)。

## 当前工作方式

本项目现在直接按线上真实服务器开发、部署和验收，不再使用本地 API、MinIO 或本地前端作为开发入口。

- 代码修改后在本机只做类型检查和构建。
- 产物通过 `scp -i ~/.ssh/pms_repair_key.pem` 上传到 `ubuntu@1.15.172.131:/tmp/`。
- 线上执行 `deploy/srv-deploy-api.sh` / `deploy/srv-deploy-web.sh`。
- 验证统一使用 `https://prsznh.cn/` 和 `https://prsznh.cn/api/v1/health`。

### 部署后必须标记：多个会话并行时靠它知道线上是哪一版（2026-08-27 起）

```powershell
node deploy/mark-deployed.mjs status          # 推送前先看：各目标线上在哪个提交、哪些提交还没上线、工作区有没有未提交的相关改动
node deploy/mark-deployed.mjs api --pkg pms-api-20260827-0010.tar.gz   # 部署成功后：移动 deployed/api 标签 + 追加 DEPLOY_LOG.md + 推送
node deploy/mark-deployed.mjs web --pkg pms-web-20260827-0006.tar.gz
node deploy/mark-deployed.mjs miniapp-staff   # 小程序同理（miniapp-owner）
```

- 标签 `deployed/api|web|miniapp-staff|miniapp-owner` 是可移动的，永远指向已上线的提交；`git log deployed/api..HEAD -- apps/api` 就是「API 还没上线的改动」。
- `pack.ps1` 按**工作区**打包：另一个会话没提交的半成品会被一起打进去。所以相关路径有未提交改动时 `mark` 会拒绝，确认包里确实带了才加 `--allow-dirty`（记录里会注明）。
- `deploy/DEPLOY_LOG.md` 由脚本追加，人只读不手改。

## 一次性：服务器初始化（历史记录）

> 以下为早期初始化记录。当前线上实例实际使用 `ubuntu` 用户和 Ubuntu 系统；日常发布不要重新执行本节。

```bash
# 1. 基础工具
dnf install -y curl ca-certificates rsync tar git dnf-plugins-core

# 2. Docker CE + compose plugin（用腾讯云镜像源，download.docker.com 国内访问慢）
dnf config-manager --add-repo https://mirrors.tencent.com/docker-ce/linux/centos/docker-ce.repo
sed -i 's|https://download.docker.com|https://mirrors.tencent.com/docker-ce|g' /etc/yum.repos.d/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# 配 docker registry 镜像（postgres/redis 镜像从 docker hub 拉也会慢）
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.m.daocloud.io"
  ],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "3" }
}
EOF
systemctl restart docker

# 3. Node 20（OpenCloudOS 9 base repo 自带 nodejs20-20.20.x，直接 dnf 装即可）
dnf install -y nodejs
npm config set registry https://registry.npmmirror.com
npm i -g pnpm pm2

# 4. pm2 日志目录
mkdir -p /var/log/pms-api

# 5. nginx
dnf install -y nginx
systemctl enable nginx

# 6. swap（2GB 内存，建议 2GB swap 兜底）
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 7. 部署目录
mkdir -p /opt/pms-repair/{docker,apps/api}
```

## 一次性：nginx 反代配置

```bash
# /etc/nginx/conf.d/pms-api.conf
cat > /etc/nginx/conf.d/pms-api.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
EOF

# OpenCloudOS 自带的 nginx.conf 里有个默认 server block，会跟我们的 default_server 冲突。
# 简单做法：用最小 http {} 替换掉，保留 include conf.d/*.conf 即可。
cat > /etc/nginx/nginx.conf <<'EOF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
include /usr/share/nginx/modules/*.conf;
events { worker_connections 1024; }
http {
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" "$http_user_agent" "$http_x_forwarded_for"';
    access_log /var/log/nginx/access.log main;
    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    types_hash_max_size 4096;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    include /etc/nginx/conf.d/*.conf;
}
EOF

nginx -t && systemctl restart nginx
```

## 每次发布

### 本机打包（不本地运行服务）

> 一键脚本：[deploy/pack.ps1](./pack.ps1)，等价于下方手工步骤，同时打 api 和 web。
>
> ```powershell
> .\deploy\pack.ps1              # 同时打 api + web
> .\deploy\pack.ps1 -Only api    # 只打 api
> .\deploy\pack.ps1 -Only web    # 只打 web
> ```
>
> 产物：`deploy/pms-api-<ts>.tar.gz` 和 `deploy/pms-web-<ts>.tar.gz`。

手工步骤（脚本失败时排查用）：

```powershell
# 1. 安装依赖 + 构建
pnpm install
pnpm --filter @pms/api build

# 2. 用 pnpm deploy 出自包含产物（含 prod 依赖 + dist）
# --legacy: pnpm v10+ 默认要求 inject-workspace-packages=true，api 不依赖 workspace 包，走 legacy 最稳
pnpm --filter @pms/api deploy --legacy --prod .\deploy\dist\api

# 3. 拷贝 ecosystem
Copy-Item .\apps\api\ecosystem.config.cjs .\deploy\dist\api\

# 4. 删除包内 .env，服务器 .env 必须保留在服务器上维护，避免被本地开发配置覆盖
Remove-Item .\deploy\dist\api\.env -ErrorAction SilentlyContinue

# 5. 打 tarball
cd .\deploy\dist
tar -czf ..\pms-api.tar.gz api\
cd ..\..
```

### 推送到服务器

```bash
scp -i ~/.ssh/pms_repair_key.pem ./deploy/pms-api-*.tar.gz ubuntu@1.15.172.131:/tmp/
scp -i ~/.ssh/pms_repair_key.pem ./deploy/srv-deploy-api.sh ubuntu@1.15.172.131:/tmp/
ssh -i ~/.ssh/pms_repair_key.pem ubuntu@1.15.172.131 'bash /tmp/srv-deploy-api.sh'
```

### 服务器端首次启动

```bash
# 1. 依赖容器 .env（自动生成强密码）
cd /opt/pms-repair
PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
REDIS_PASS=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
cat > docker/.env <<EOF
POSTGRES_DB=pms_repair
POSTGRES_USER=pms
POSTGRES_PASSWORD=${PG_PASS}
REDIS_PASSWORD=${REDIS_PASS}
EOF
chmod 600 docker/.env

# 把 docker-compose.prod.yml 上传到 /opt/pms-repair/docker/
docker compose --env-file docker/.env -f docker/docker-compose.prod.yml up -d

# 2. 解压 API 产物
cd /opt/pms-repair/apps
tar -xzf /tmp/pms-api.tar.gz

# 3. 配 API 的 .env
#    如果新开了 shell（上面的 PG_PASS/REDIS_PASS 已丢），从 docker/.env 重新读：
PG_PASS=$(grep '^POSTGRES_PASSWORD=' /opt/pms-repair/docker/.env | cut -d= -f2-)
REDIS_PASS=$(grep '^REDIS_PASSWORD=' /opt/pms-repair/docker/.env | cut -d= -f2-)
#    COS_SECRET_ID / COS_SECRET_KEY 从腾讯云 CAM 子账号生成（权限只覆盖目标桶）
JWT=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-64)
cat > api/.env <<EOF
PORT=4000
NODE_ENV=production
TZ=Asia/Shanghai
API_GLOBAL_PREFIX=api/v1
# COS 桶是私有的，照片一律经 GET /upload/file?key= 代理读。
# 小程序 <image> 只认绝对地址，这一项不配 = 小程序里所有照片黑屏/灰图。
APP_PUBLIC_BASE_URL=https://prsznh.cn

DB_HOST=127.0.0.1
DB_PORT=5433
DB_NAME=pms_repair
DB_USER=pms
DB_PASS=${PG_PASS}
DB_SYNCHRONIZE=true
DB_LOGGING=false

REDIS_HOST=127.0.0.1
REDIS_PORT=6380
REDIS_PASSWORD=${REDIS_PASS}

COS_REGION=ap-shanghai
COS_BUCKET=property-repair-2026-1259497259
COS_SECRET_ID=<from-CAM>
COS_SECRET_KEY=<from-CAM>
COS_PUBLIC_BASE_URL=https://property-repair-2026-1259497259.cos.ap-shanghai.myqcloud.com

JWT_SECRET=${JWT}
JWT_ACCESS_EXPIRES_IN=2h
JWT_REFRESH_EXPIRES_IN=7d

WX_OWNER_APPID=
WX_OWNER_SECRET=
WX_STAFF_APPID=
WX_STAFF_SECRET=
EOF
chmod 600 api/.env

# 4. 启动 pm2
cd /opt/pms-repair/apps/api
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root   # 输出一行 systemd 命令；以 root 跑就直接执行那行

# 5. 自测
curl http://127.0.0.1:4000/api/v1/health     # 直连 node
curl http://127.0.0.1/api/v1/health          # 经 nginx
curl https://prsznh.cn/api/v1/health         # 域名公网入口
curl http://1.15.172.131/api/v1/health       # IP 直连排障备用
# 期望 {"status":"ok","db":"up",...}
```

### 后续发布

```bash
# 本地构建 + 打包 + scp（同上）

# 服务器：备份 .env，清掉旧 dist/src/node_modules 再展开（避免旧文件残留 / 软链失效），最后 reload
cd /opt/pms-repair/apps
cp api/.env /tmp/api.env.bak.$(date +%s)
rm -rf api/dist api/src api/node_modules api/package.json api/nest-cli.json \
       api/tsconfig.json api/ecosystem.config.cjs \
       api/.env.example api/.env.production.example 2>/dev/null
tar -xzf /tmp/pms-api.tar.gz          # 部署包不含 .env，服务器 .env 不动
pm2 reload pms-api --update-env       # ⚠️ 必须带 --update-env，否则改过的 .env 不会进进程
curl -sS http://127.0.0.1:4000/api/v1/health
```

> **重要**：`pm2 reload` 默认**不会**重读 .env，pm2 进程内 `process.env` 会保留启动时的值。每次都加 `--update-env`，或保证 .env 没改的时候省略也行。

## 一次性：bootstrap 首个 superadmin

API 提供 `POST /auth/bootstrap-admin`，只有当 `BOOTSTRAP_TOKEN` 非空时才启用。流程：

```bash
# 1. 临时打开 bootstrap
BTOK=$(openssl rand -hex 16)
sed -i "s|^BOOTSTRAP_TOKEN=.*|BOOTSTRAP_TOKEN=${BTOK}|" /opt/pms-repair/apps/api/.env
pm2 reload pms-api --update-env

# 2. 创建首个 superadmin（账号/密码改成你想要的）
curl -sS -X POST http://127.0.0.1:4000/api/v1/auth/bootstrap-admin \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"${BTOK}\",\"tenantName\":\"演示物业\",\"account\":\"admin\",\"password\":\"ChangeMe!2026\",\"name\":\"超级管理员\"}"

# 3. 立刻关掉 bootstrap（生产硬性要求）
sed -i 's|^BOOTSTRAP_TOKEN=.*|BOOTSTRAP_TOKEN=|' /opt/pms-repair/apps/api/.env
pm2 reload pms-api --update-env

# 4. 验证：用上一步的账号密码登录
curl -sS -X POST http://127.0.0.1:4000/api/v1/auth/admin-login \
  -H 'Content-Type: application/json' \
  -d '{"account":"admin","password":"ChangeMe!2026"}'
# 期望返回 { "accessToken": "...", "user": { "role":"superadmin", ... } }
```

## admin-web 同域托管

后台前端走 nginx 静态站，与 API 同域 → 浏览器 `/api/v1/*` 由 nginx 反代到 node，无 CORS。

### 一次性：nginx 切到 [deploy/nginx-pms-api.conf](./nginx-pms-api.conf)

新版配置同时托管静态站和反代 API（旧版只有反代）。**首次启用前**先建好 web 目录，否则 nginx 启动报 root 路径不存在。

```bash
mkdir -p /opt/pms-repair/web
# 临时占位，等会儿被替换
echo '<h1>pms-repair admin-web placeholder</h1>' > /opt/pms-repair/web/index.html

# 推 conf
scp -i ~/.ssh/pms_repair_key.pem deploy/nginx-pms-api.conf ubuntu@1.15.172.131:/tmp/pms-api.conf
ssh -i ~/.ssh/pms_repair_key.pem ubuntu@1.15.172.131 'sudo mv /tmp/pms-api.conf /etc/nginx/conf.d/pms-api.conf && sudo nginx -t && sudo systemctl reload nginx'
```

### 本机构建 + 打包

```powershell
pnpm install
pnpm web:build

# 把 dist 整个打包（包名带时间戳便于回滚）
$ts = Get-Date -Format 'yyyyMMdd-HHmm'
tar -czf ".\deploy\pms-web-$ts.tar.gz" -C .\apps\admin-web\dist .
```

### 推送到服务器 + 原子切换

```bash
# 上传
scp -i ~/.ssh/pms_repair_key.pem ./deploy/pms-web-*.tar.gz ubuntu@1.15.172.131:/tmp/
scp -i ~/.ssh/pms_repair_key.pem ./deploy/srv-deploy-web.sh ubuntu@1.15.172.131:/tmp/

# 服务器
ssh -i ~/.ssh/pms_repair_key.pem ubuntu@1.15.172.131 << 'EOF'
set -e
WEB=/opt/pms-repair/web
BAK=/opt/pms-repair/web.bak.$(date +%s)
PKG=$(ls -t /tmp/pms-web-*.tar.gz | head -1)
[ -d "$WEB" ] && mv "$WEB" "$BAK"
mkdir -p "$WEB"
tar -xzf "$PKG" -C "$WEB"
sudo chown -R www-data:www-data "$WEB"
# nginx 不需要 reload（root 路径不变，静态文件就地生效）
curl -sS https://prsznh.cn/ -o /dev/null -w 'admin-web HTTP %{http_code}\n'
# 保留最近 3 个备份
ls -dt /opt/pms-repair/web.bak.* 2>/dev/null | tail -n +4 | xargs -r sudo rm -rf
EOF
```

### 验证清单

```bash
# 都应返回 200
curl -sS -o /dev/null -w 'static  %{http_code}\n' https://prsznh.cn/
curl -sS -o /dev/null -w 'asset   %{http_code}\n' https://prsznh.cn/assets/  # 404 也正常（目录本身）
curl -sS -o /dev/null -w 'spa     %{http_code}\n' https://prsznh.cn/dashboard  # SPA fallback → 200
curl -sS https://prsznh.cn/api/v1/health
# 期望 {"status":"ok","db":"up",...}
```

浏览器打开 `https://prsznh.cn/`，应直达登录页，输入上一步 bootstrap 的账号密码。

## 常用排查

### `pm2 reload` 报「Process 0 not found」

进程反复崩溃重启到一定次数后，pm2 会把它从进程表里摘掉，这时 `reload` 无从下手，
部署脚本会停在健康检查上。**先看崩溃原因**（`pm2 logs pms-api --err --lines 60`），
修完用 `start` 而不是 `reload` 把它挂回来：

```bash
cd /opt/pms-repair/apps/api && pm2 start ecosystem.config.cjs --update-env && pm2 save
```

2026-08-26 踩过一次：`main.ts` 里直接 `import { json } from 'express'`，
而 express 只是 `@nestjs/platform-express` 的传递依赖、没写进 `apps/api/package.json`，
`pnpm deploy --prod` 打出来的产物里它不在顶层 node_modules，线上一起就
`MODULE_NOT_FOUND`。**改 main.ts 引入新的第三方包时，先确认它在 dependencies 里**，
body 大小这类需求用 `app.useBodyParser(...)`（platform-express 自带）绕开。

```bash
pm2 logs pms-api --lines 100
pm2 status
docker compose --env-file /opt/pms-repair/docker/.env -f /opt/pms-repair/docker/docker-compose.prod.yml ps
docker logs pms-postgres --tail 100
docker logs pms-redis --tail 100
free -h
df -h
systemctl status nginx pm2-root
journalctl -u docker --since "10 min ago"
tail -f /var/log/nginx/access.log
```

## 已验证

- 2026-06-04：API health check `{"status":"ok","db":"up"}` 经 nginx 80 公网访问通过
- 2026-06-08：admin-web（Vite + React + AntD）切到同域托管，nginx 同时反代 `/api/*` 和静态站 SPA fallback（**配置已就绪，未真上线**）

## Postgres 每日备份（已上线）

每天 **03:30 Asia/Shanghai** 跑 `/usr/local/bin/pms-pg-backup.sh`，把库 dump → gzip → 上传到 `cos://property-repair-2026-1259497259/backups/pg/YYYY-MM-DD.sql.gz`。

```bash
# 手动跑一次
/usr/local/bin/pms-pg-backup.sh
tail /var/log/pms-pg-backup.log

# 看 COS 上的备份
coscmd list backups/pg/

# 恢复某天的备份到容器（注意会覆盖现有数据）
DATE=2026-06-04
coscmd download backups/pg/${DATE}.sql.gz /tmp/${DATE}.sql.gz
gunzip -c /tmp/${DATE}.sql.gz \
  | docker exec -i pms-postgres psql -U pms -d pms_repair
```

**Retention**：在 COS 控制台给 `backups/pg/` 前缀加生命周期规则（保留 30 天后转低频，60 天后删除），不要在脚本里 `coscmd delete` 滚动 —— 避免 bug 导致误删。

**凭据来源**：`/root/.cos.conf`（0600，root-only）与 `/opt/pms-repair/apps/api/.env` 同步，用同一对 CAM 子账号 SecretId/Key。换 key 时两处都要改。

## 安全 TODO

- [ ] 备案过了之后域名 + Let's Encrypt + nginx 80→443
- [ ] DB `DB_SYNCHRONIZE=false`，生成首版 migration，提交版本控制
- [ ] 服务器 SSH 改用 key-only、禁密码登录、禁 root 直登（先创非 root 用户）
- [ ] COS 控制台给 `backups/pg/` 配生命周期规则（30 天保留）
- [ ] CAM 子账号 SecretId/Key 每 90 天轮换；轮换时同步更新 `apps/api/.env` 和 `/root/.cos.conf`
- [ ] 微信小程序 AppID/Secret 备案后填入 `.env`
