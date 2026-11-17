# 收银台尾号搜索 / 移动选房 / 图片预览（2026-11-17 Asia/Shanghai）
## 目标与授权
- 恢复03212尾号查询；手机房号三级列可见；粘贴目标不溢出；全部图片查看复用共享遮罩、缩放、空白/Esc关闭与焦点恢复。
- 最新用户明确“已完成的先上线”：授权本批已验收修复现在发布，之后的新开发不含本次授权。原六项仍未完成，goal active rev7 round7/64。
## 已完成与验证
- 完工浮层官方auto发布退出0：Web2.0.20261117-1748/70f1d2a2，公网提交/哈希核验；main最后b55cf010。API3fb3e8d、助手2.5.54/d075f81d未变，现场安装/业务未验。task99 rev6及[验收记录](<outputs/work-order-completion-overlay-20261117/acceptance.md>)已同步。
- 手机列375px原跨-48到607px复现后修flex/窄屏换行，320/375/812/1440最终140室可选择；粘贴卡片原溢出复现后修minHeight/wrap，375/1440通过。
- 03212生产只读证据：最近5次completed各1辆，Owner__owner_Name=198/03/301；本地车辆0，houses id15=198/3/301。实际共享resolver带03不命中，旧Cashier continue丢车；不是列表裁切。
- [Cashier](<apps/neighbor-web/src/pages/Cashier.tsx>)只规范数字房号前导零、不改03212；lane/building/room唯一匹配，错户/多户/无房号和失败/超时明确错误。8单元+1真实Chrome1440/375=9/9，tsc通过。task102 rev3。
- 共享ImagePreview增加按钮/复位、实际图片外空白关闭、拖动不误关，Esc和click隔离父Sheet/行；NewPlateCard重复实现已移除。PhotoField含标签图片统一预览、PDF保留链接。
- FeedbackDialog移除capture键盘/旧lightbox，Stock旧photo-viewer换共享；页面级专项回归待补。
- round5新增薄触发器[ImagePreviewButton](<apps/neighbor-web/src/components/ImagePreviewButton.tsx>)，无平行查看实现；FamilyCars独立资料/办理详情、StockOps入库附件、Materials SKU已接入。
- round5实际产品页面Chrome1440/375四入口通过；保留PDF，Esc不关入库Sheet，预览不触发行编辑，焦点恢复。截图[手机入库](<outputs/image-preview-unification-20261117/receipt-375.png>)。
- 最新组合35/35：统一预览1、四入口1、亲情车加载25/导航5、审核3。旧导航harness缺timeline/useSearchParams已修；新页面fixture分页/source字段补齐后通过，不改产品校验。tsc和diff check通过。
## 待办与下一步
- round6：RequestComposer/StockDocs候选+明细、StockOps候选5入口接共享；先复现缺预览按钮，修复后累计9个实际入口1440/375通过，手机touch tap开/放大/关，名称仍选入，预览不加材料/不改数量。联合10/10，tsc/diff通过；purchase-export旧harness缺formatBeijingDateTime，加载真实时间/timeline模块修正。
- round7补Purchase明细、MaterialPicker候选（拆并列查看/选择，已选仍可看不重复加）、PlateForm本地待上传照片（PDF/删除保留、无提交）；3入口先失败再修，累计12处实际入口1440/375触屏/桌面通过，联合12/12，tsc/diff通过。[覆盖清单](<outputs/image-preview-unification-20261117/coverage.md>)下一步维保签名/二维码及剩余专项。
- FamilyCars/Vehicles/QrCodes/Login/NoticeTemplateSection/维保二维码逐个审计；保留扫码/下载，非图标图片查看统一。
- 补Feedback/Stock真实入口、拖动与touch、图片失败、上传点击/拖拽/多目标粘贴回归；清理旧预览CSS前查所有使用点。
- task100 rev3/101 rev6/102 rev4仍in_progress：用户授权本批已官方auto上线，退出0/205.1秒；Web2.0.20261117-1903/fb182217，sourceHash95e74055651e2ca848f2008a404ad52affae675fb706cb36d082ac7eb022d4c7，公网提交/JS哈希及deployed/web远端核对通过。70/70、tsc/正式构建/发布门禁通过；API/助手不变，现场业务未验。
## 环境
- 工作区D:/00项目开发/PMS-release-simplification-20261117 main；保留历史dirty三个artifacts/release-checks/api-{expected,source,verified}.json。
- Node=C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe；pnpm同dependencies/pnpm/bin/pnpm.mjs；Python313。
- tsc：node apps/neighbor-web/node_modules/typescript/bin/tsc --noEmit --project apps/neighbor-web/tsconfig.json；测试node --test apps/neighbor-web/test/*指定*.test.cjs。
- 构建PATH先outputs/omission-release-20261117/tool-bin再Node/bin；pnpm verify_deps_before_run=warn,node_linker=isolated，virtual_store_dir=D:/00项目开发/PMS-release-batch-eight-20261116/node_modules/.pnpm，store同级.pnpm-release-store。
- 本轮所有验证均本地真实Chrome+合成只读API，不是正式登录态业务；没有上传/支付/库存/车辆或设备写入。按项目默认单agent，无新代理。
- 原六项仍欠标准门禁/停车其余路由与真实厂商适配、停车绑定UI/实际绑定、登录态Web、双端picker实机、实卡.80设备闭环、双端体验指针保存刷新回读。
- 双端开发包1.0.20261117a/4912774f已上传≠体验生效；PMS9222/login、公众平台9223无token为历史只读结果。仅生产124.223.179.214，禁止旧机。
