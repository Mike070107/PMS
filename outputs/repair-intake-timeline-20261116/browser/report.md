# 报修公区与照片：隔离真实浏览器验收

## 结果

**已完成**：只读链路调查与lead实现后的桌面1440×1000、窄屏375×812真实Chrome交互验收；未发现阻塞性产品缺陷。

命令：
```text
node --test outputs/repair-intake-timeline-20261116/browser/acceptance.test.cjs
✔ 实际报修组件：公区与照片完整边界、两屏、失败重试、单粘贴目标及迟到隔离
 tests 1 / pass 1 / fail 0 / duration_ms 14990.7648
```

测试是1个完整集成用例，包含15个主要交互边界，不表述为15个独立测试。最终一轮包含9次真实multipart HTTP上传、5次合成create和5次合成detail读取；组件冻结源码指纹在构建前与结束后断言相等。照片采用可解码合成PNG，并断言实际img naturalWidth=240；详情CSS背景的链接与create附件URL精确相同。

### 清单对账

| 项目 | 状态 | 验收要点 |
|---|---|---|
| 社区公区 | 已完成 | 无楼栋小区可选社区公共区域，create无buildingId/houseId；桌面与375首次点选均通过 |
| 楼栋/住户/预填 | 已完成 | 楼栋公区仅buildingId；住户带两ID；fixed仅community/text不推断ID |
| 三上传入口 | 已完成 | whole-zone点击触发真实file chooser；DataTransfer拖拽；真实ClipboardItem图片写入系统剪贴板后键盘Control+V |
| 上传等待 | 已完成 | HTTP保持未返回时上传状态可见，submit与clear禁用 |
| 上传失败处理 | 已完成 | 原File名称和成功URLs保留；显式重试上传成功；显式放弃不删除既有成功照片 |
| 提交失败与成功 | 已完成 | 合成400后地址/位置/联系人/描述/4图保留；重试payload正确；busy禁重复且Esc不关闭创建中表单 |
| 详情/刷新 | 已完成 | 实际WorkOrderSheet通过模拟detail读取4张同URL照片，页面重新加载后再次读取仍4张 |
| 多区粘贴 | 已完成 | 两个实际PhotoField焦点切换，一次ClipboardEvent只产生一次HTTP和一个active标记；非目标无图；混合文本粘贴不劫持 |
| 重开隔离 | 已完成 | 上传未完成时关闭并重开，再释放旧HTTP，旧URL未进入新草稿 |
| 时间线 | 已完成 | 实际WorkOrderSheet接收乱序合成logs，按11:00/10:00/09:00倒序，桌面/375截图 |

## 证据

- [结构化结果](<outputs/repair-intake-timeline-20261116/browser/result.json>)
- [合成payload与multipart请求头](<outputs/repair-intake-timeline-20261116/browser/captured-boundary.json>)
- [最终受测源码指纹](<outputs/repair-intake-timeline-20261116/browser/tested-source-hashes.json>)
- [实际组件入口](<outputs/repair-intake-timeline-20261116/browser/fixture.tsx>)、[合成API边界](<outputs/repair-intake-timeline-20261116/browser/fixture-api.ts>)、[隔离HTTP/打包runner](<outputs/repair-intake-timeline-20261116/browser/browser.test.cjs>)、[完整断言](<outputs/repair-intake-timeline-20261116/browser/acceptance.test.cjs>)
- [桌面社区公区](<outputs/repair-intake-timeline-20261116/browser/desktop-community-public.png>)、[375社区公区](<outputs/repair-intake-timeline-20261116/browser/narrow-community-public.png>)
- [上传等待](<outputs/repair-intake-timeline-20261116/browser/desktop-upload-wait.png>)、[上传失败保留](<outputs/repair-intake-timeline-20261116/browser/desktop-upload-error.png>)
- [375提交失败输入保留](<outputs/repair-intake-timeline-20261116/browser/narrow-submit-error-retained.png>)、[375成功照片保留](<outputs/repair-intake-timeline-20261116/browser/narrow-retained-photos.png>)、[375创建后详情](<outputs/repair-intake-timeline-20261116/browser/narrow-created-detail.png>)
- [双上传区单粘贴目标](<outputs/repair-intake-timeline-20261116/browser/desktop-single-paste-target.png>)
- [桌面倒序时间线](<outputs/repair-intake-timeline-20261116/browser/desktop-timeline-newest-first.png>)、[375倒序时间线](<outputs/repair-intake-timeline-20261116/browser/narrow-timeline-newest-first.png>)

## 剩余风险与未验证项

- **未验证真实业务闭环**：浏览器挂载的是实际React组件和实际uploadImage，但API/身份替换为合成边界；创建和详情数据只存在本机HTTP内存。不是真实API权限、数据库持久、真实对象存储、通知、生产或原生设备验收。lead另行执行的API service内存事务测试不由本报告冒领。
- 375为桌面Chrome缩窄视口，不等于真手机/小程序原生设备；本次时间线截图只覆盖neighbor-web详情，不代表admin-web和miniapp交互验收。
- 只读调查确认：实际repairs.create为POST /repair-requests，仍受原owner/staff入口角色/权限及来源语义约束；不是office创建路由。社区级公共区域后端原先已接受，不必新增DTO字段。
- 上传POST受JWT及文件签名约束；现有/upload/file按key读取并无报修详情鉴权，不声明其具备更强的附件读取权限。
- 非阻塞UX观察：长表单提交失败时ErrorNote位于顶部，当前停留底部的用户可能要上滚才能看到；输入及照片已确认完整保留。已告lead，不擅改产品。
- 早期失败均为夹具问题（依赖解析、TEMP恢复、aria-label严格匹配、相对auth替换、CSS背景定位、fixture面板遮挡），已修正并最终全绿；保留的旧failure诊断不代表最终产品结论。
- 本agent只写本目录；未改产品源码、依赖、索引、提交、推送、构建生产制品、上传开发版或真实业务数据。
