import { getLastApiFailure, observability, upload, type FeedbackType } from '@pms/api-client';

const TYPES: Array<{ label: string; value: FeedbackType }> = [
  { label: '页面报错 / 操作失败', value: 'error' },
  { label: '不好用 / 找不到功能', value: 'hard_to_use' },
  { label: '数据显示不对', value: 'data_issue' },
  { label: '改进建议', value: 'suggestion' },
  { label: '其他', value: 'other' },
];

export async function openFeedback() {
  const picked = await wx.showActionSheet({ itemList: TYPES.map((item) => item.label) }).catch(() => null);
  if (!picked || picked.tapIndex < 0) return;
  const input = await wx.showModal({
    title: '反馈问题',
    content: '请说明刚才点了什么、看到什么。系统会自动带上出错页面和最近错误。',
    editable: true,
    placeholderText: '例如：点完工提交后提示失败，重试两次一样',
    confirmText: '提交',
  }).catch(() => null);
  const description = String(input?.content || '').trim();
  if (!input?.confirm) return;
  if (description.length < 5) return wx.showToast({ icon: 'none', title: '至少说明 5 个字' });

  const attachChoice = await wx.showActionSheet({
    itemList: ['添加现场图片/视频', '不添加，直接提交'],
  }).catch(() => null);
  if (!attachChoice) return;
  let selected: WechatMiniprogram.ChooseMediaSuccessCallbackResult['tempFiles'] = [];
  if (attachChoice.tapIndex === 0) {
    const media = await wx.chooseMedia({
      count: 5,
      mediaType: ['image', 'video'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      maxDuration: 30,
      camera: 'back',
    }).catch(() => null);
    const images = (media?.tempFiles || []).filter((item) => item.fileType === 'image').slice(0, 4);
    const videos = (media?.tempFiles || []).filter((item) => item.fileType === 'video').slice(0, 1);
    selected = [...images, ...videos];
    if ((media?.tempFiles.length || 0) > selected.length) {
      wx.showToast({ icon: 'none', title: '已保留前 4 张图片和 1 个视频' });
    }
  }

  const last = getLastApiFailure();
  const pages = getCurrentPages();
  const current: any = pages[pages.length - 1];
  const route = last?.route || `/${current?.route || ''}`;
  /**
   * 带上工单号。
   *
   * 不带的话后台只看到「work order cannot be completed / 页面 order-detail」，
   * 是哪一张单全靠去翻 nginx 日志（2026-09-04 就这么翻出来的 45 号单）。
   * 优先取页面上正在看的那张单；页面没有就从失败请求的路径里抠 id（/work-orders/45/complete）。
   */
  const workOrderNo: string = current?.data?.detail?.workOrder?.orderNo || '';
  const workOrderId =
    Number(current?.data?.id) || Number(/\/work-orders\/(\d+)/.exec(last?.url || '')?.[1]) || 0;
  const orderTag = workOrderNo || (workOrderId ? `#${workOrderId}` : '');
  let version = '';
  try { version = wx.getAccountInfoSync().miniProgram.version || ''; } catch {}
  wx.showLoading({ title: '提交中…', mask: true });
  try {
    const attachments: Array<{ type: 'image' | 'video'; url: string }> = [];
    for (const file of selected) {
      const uploaded = await upload.uploadTempFile(file.tempFilePath, 120000);
      attachments.push({ type: file.fileType, url: uploaded.displayUrl || uploaded.publicUrl });
    }
    await observability.feedback({
      source: 'miniapp-staff',
      type: TYPES[picked.tapIndex]?.value || 'other',
      // 单号写进正文：后台的反馈列表、导出、转给谁看，都只保证这一段一定在
      message: orderTag ? `[工单 ${orderTag}] ${description}` : description,
      route,
      pageTitle: route,
      version,
      errorMessage: last?.message,
      context: {
        ...(last || {}),
        ...(workOrderId ? { workOrderId } : {}),
        ...(workOrderNo ? { workOrderNo } : {}),
      },
      attachments,
    });
    wx.showToast({ title: '已反馈给后台' });
  } catch (error: any) {
    wx.showToast({ icon: 'none', title: error?.message || '反馈提交失败' });
  } finally {
    wx.hideLoading();
  }
}
