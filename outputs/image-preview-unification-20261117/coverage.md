# 图片入口统一覆盖清单（进行中，尚未上线）

## 已接入共享 ImagePreview
- 报修照片 PhotoField 普通缩略图；附件标签图片也改为缩略图，PDF保留原链接。
- 工单 WorkOrderMedia、日志反馈附件 Logs：既有共享入口，需最终受影响回归。
- 车辆登记审核 NewPlateCard：移除重复预览，复用共享弹窗。
- 反馈提交 FeedbackDialog、库存 Stock：旧弹窗已替换；页面级新回归待补。
- round5：亲情车独立资料/办理详情图片、入库记录附件、材料SKU照片采用 ImagePreviewButton（仅封装触发状态，全部查看行为仍由既有ImagePreview负责）。
- 共享弹窗阻止点击冒泡，防止图库按钮反向触发行点击编辑；Esc不关闭父Sheet。

## 当前验证
- 共享预览375/1440：卡片包含性、滚轮/按钮/复位、Esc/遮罩/图片外空白、焦点恢复、标签PDF隔离、父行不误触均通过。
- 车辆审核真实Chrome3/3通过（含错误图片、PDF、画廊、焦点环绕）。
- 亲情车加载25/25通过；导航回归5/5（旧harness遗漏timeline和useSearchParams适配已修正，不修改产品权限）。
- 应用tsc、git diff --check通过。页面级亲情车2入口/入库/SKU真实Chrome在1440/375全部通过；组合35/35。补挂实际IconSprite后再次1/1通过并刷新截图，关闭图标可见。页面级证据不以共享组件测试替代。

## 待迁移/确认
- round7已补Purchase采购明细、MaterialPicker候选、PlateForm本地待上传照片：三个入口均先复现0个预览按钮再修复。MaterialPicker拆并列预览/选择按钮，不嵌套，选中后仍可看图且不会重复加料；PlateForm保留PDF/删除，不提交上传。累计12处实际入口1440/375通过，联合采购/审核/共享预览12/12，tsc/diff通过。
- RequestComposer/StockDocs候选及明细、StockOps候选已在round6迁移：图片独立预览，不加材料；点名称仍选入。先失败复现0个预览按钮，修复后9个实际入口1440/375通过，手机使用touch tap打开/放大/关闭，桌面Esc恢复焦点，数量保持1。联合库存/采购导出10/10；旧导出harness缺北京时间格式化已加载真实共享模块修正。
- MaintEditor签名、二维码。
- FamilyCars/Vehicles/QrCodes/Login/NoticeTemplateSection二维码显示入口逐一审查（扫码/下载功能保留）。
- 清理旧预览CSS前先查使用范围；完成所有入口桌面/窄屏后再冻结、提交推送、正式构建。

## 边界
本地浏览器使用真实产品组件及CSS、合成只读API，不是真实客户业务验收。未生产上传、收费、库存修改或设备写入；用户最新“已完成的先上线”已授权本批已验收修复发布；70/70受影响回归通过，正在冻结提交并走官方auto发布，未完成前不称已上线。
