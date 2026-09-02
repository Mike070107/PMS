import { getLastApiFailure, observability, type FeedbackType } from '@pms/api-client';

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

  const last = getLastApiFailure();
  const pages = getCurrentPages();
  const route = last?.route || `/${pages[pages.length - 1]?.route || ''}`;
  let version = '';
  try { version = wx.getAccountInfoSync().miniProgram.version || ''; } catch {}
  wx.showLoading({ title: '提交中…', mask: true });
  try {
    await observability.feedback({
      source: 'miniapp-staff',
      type: TYPES[picked.tapIndex]?.value || 'other',
      message: description,
      route,
      pageTitle: route,
      version,
      errorMessage: last?.message,
      context: last ? { ...last } : undefined,
    });
    wx.showToast({ title: '已反馈给后台' });
  } catch (error: any) {
    wx.showToast({ icon: 'none', title: error?.message || '反馈提交失败' });
  } finally {
    wx.hideLoading();
  }
}
