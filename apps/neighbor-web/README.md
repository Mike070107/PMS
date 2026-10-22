# 邻修新版管理后台（apps/neighbor-web）

按 `design-system/redesign/邻修PMS-重设计稿-v1.html` 重做的管理后台，运行在
**https://prsznh.cn/beta/**（与正式后台同域子路径）。

## 它和正式后台的关系

| 项 | 正式后台 `apps/admin-web` | 本应用 `apps/neighbor-web` |
|---|---|---|
| 入口 | `/` | `/beta/` |
| 技术 | React + Ant Design | React + 设计稿原生 CSS（无 UI 框架） |
| 后端 | 生产 API | **同一个生产 API、同一个库** |
| 登录态 | sessionStorage `pms.admin.*` | 同一套键，同源两次登录互通 |
| 迁移状态 | 全功能 | 见下方「已迁移 / 未迁移」 |

共用数据和登录态是刻意的：测试环境里看到的就是真实在办的单，测试时的增删改会写进
正式数据。**不要把它当成沙箱随便点作废/撤单。**

## 已迁移

- 外壳：侧栏（设计稿的 8 组信息架构）、管理处切换、Ctrl+K 命令面板、通知角标
- 今日待办：真实工单统计、紧急/超时列表、维修工在手单数、今日前台收费流水
- 工单调度：看板（待派单/待接单/维修中/等材料/待验收）+ 列表、搜索、
  右侧抽屉详情（概况 / 处理进度 / 用料与收费 / 养护单）、派单与改派、代维修工接单、
  登记完工（含从库存领料扣库）、缺料转采购、代业主验收、撤回（带后端算好的影响预览）、
  撤单、作废、退回办公室、催办、添加进度、登记报修

## 未迁移（点进去会跳回旧后台同名页）

收银台、住户车辆与门禁、设备中心、采购流程、库存、系统设置，以及养护单、维修经验、
账单与欠费、对账、盘点、材料库、房产、业主、员工与权限、管理处、报表、报修码、
内网应用、日志。这些页面的功能仍全部在旧后台可用。

## 本地开发

```bash
cd apps/neighbor-web
pnpm dev            # http://127.0.0.1:4173 ，/api/v1 代理到 https://prsznh.cn
```

`4173` 是刻意选的：本机 5159–5258 段被 Windows 保留（Hyper-V），vite 绑 5173/5176
会直接 `EACCES`。

## 构建与发布到 /beta/

```bash
pnpm --filter @pms/neighbor-web build          # 产物 base 固定为 /beta/
cd apps/neighbor-web/dist && tar --force-local -czf /tmp/neighbor-beta.tar.gz .
scp -i ~/.ssh/pms_repair_key.pem /tmp/neighbor-beta.tar.gz ubuntu@124.223.179.214:/tmp/
ssh -i ~/.ssh/pms_repair_key.pem ubuntu@124.223.179.214 \
  'sudo tar -xzf /tmp/neighbor-beta.tar.gz -C /opt/pms-repair/beta && sudo chown -R www-data:www-data /opt/pms-repair/beta'
```

nginx（`/etc/nginx/conf.d/pms.conf`，prsznh.cn 的 server 块，放在 `location /` 之前）：

```nginx
location = /beta { return 301 /beta/; }
location ^~ /beta/assets/ {
    root /opt/pms-repair;
    expires 30d;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}
location /beta/ {
    root /opt/pms-repair;
    index index.html;
    try_files $uri $uri/ /beta/index.html;
}
location = /beta/index.html {
    root /opt/pms-repair;
    add_header Cache-Control "no-cache";
}
```

用 `root` 而不是 `alias`：目录名和路径段同名（`/opt/pms-repair/beta`），
`alias` + `try_files $uri` 会把 `/beta/` 拼成 `beta/beta/`。

回退：删掉上面四段 location → `sudo nginx -t && sudo systemctl reload nginx`，
再 `rm -rf /opt/pms-repair/beta`。正式后台不受影响。

## 已知缺口

- 照片/附件上传（完工照片、报修照片）、养护单签字与打印、房号选择器（现在手填地址文本）
- 收银台等 6 个页面尚未接入，占位页给了回旧后台的入口
