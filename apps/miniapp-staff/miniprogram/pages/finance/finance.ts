import {
  finance,
  type FinanceDashboard,
  type FinanceEntry,
  type FinanceInvoice,
  type FinanceProject,
  type FinanceReimbursement,
} from '@pms/api-client';
import { createHoldToTalk, speechErrorTip, type HoldToTalk } from '@pms/miniapp-ui';

let speechManager: any = null;
try { speechManager = requirePlugin('WechatSI').getRecordRecognitionManager(); } catch { speechManager = null; }
let hold: HoldToTalk | null = null;

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const money = (value: unknown) => Number(value || 0).toFixed(2);
const shortDate = (value: string) => value ? value.slice(0, 10) : '日期待识别';
const ownerLabels: Record<string, string> = { osiris: 'OsirisList', pruis: '普睿斯', personal: '个人' };
const paymentLabels: Record<string, string> = { wechat: '微信', alipay: '支付宝', bank: '对公转账', cash: '现金' };
const reimbursementLabels: Record<string, string> = { pending: '待报销', reimbursed: '已报销', not_required: '无需报销' };
const invoiceLabels: Record<string, string> = { inbox: '待匹配', matched: '已匹配', duplicate: '疑似重复', discarded: '已丢弃', error: '处理失败' };

type EntryView = FinanceEntry & {
  amountText: string; flowClass: string; flowIcon: string; sign: string; ownerText: string;
  paymentText: string; reimbursementText: string; projectText: string;
};
type InvoiceView = FinanceInvoice & { amountText: string; createdText: string; sourceText: string; statusText: string };
type ReimbursementView = FinanceReimbursement & { amountText: string; statusText: string };

const emptyDashboard = { incomeText: '0.00', expenseText: '0.00', balanceText: '0.00', pendingReimbursement: 0, invoiceInbox: 0, projects: 0 };

Page({
  data: {
    loading: true,
    saving: false,
    uploading: false,
    activeTab: 'overview',
    tabs: [
      { key: 'overview', label: '总览', icon: 'overview', badge: 0 },
      { key: 'entries', label: '流水', icon: 'ledger', badge: 0 },
      { key: 'projects', label: '项目', icon: 'folder', badge: 0 },
      { key: 'invoices', label: '发票', icon: 'invoice', badge: 0 },
      { key: 'reimbursements', label: '报销', icon: 'wallet', badge: 0 },
    ],
    dashboard: emptyDashboard,
    entries: [] as EntryView[],
    recentEntries: [] as EntryView[],
    pendingEntries: [] as EntryView[],
    projects: [] as FinanceProject[],
    projectGroups: [] as Array<FinanceProject & { descriptionText: string; children: FinanceProject[] }>,
    projectOptions: ['暂不选择'],
    parentProjectOptions: ['不选择，创建一级项目'],
    selectedProjectName: '暂不选择',
    selectedParentName: '不选择，创建一级项目',
    projectParentIndex: 0,
    invoices: [] as InvoiceView[],
    reimbursements: [] as ReimbursementView[],
    candidates: [] as EntryView[],
    matchingInvoice: null as InvoiceView | null,
    sheet: '' as '' | 'entry' | 'project' | 'match' | 'reimburse',
    sheetTitle: '', sheetEyebrow: '', sheetSubmitText: '',
    hasSpeech: false, recording: false, pressing: false,
    paymentOptions: [
      { value: 'wechat', label: '微信' }, { value: 'alipay', label: '支付宝' },
      { value: 'bank', label: '对公转账' }, { value: 'cash', label: '现金' },
    ],
    entryForm: { businessDate: today(), flowType: 'expense', owner: 'pruis', reason: '', amount: '', paymentMethod: 'wechat', projectId: null as number | null, reimbursementRequired: true },
    projectForm: { parentId: null as number | null, name: '', description: '' },
    reimburseForm: { claimantName: '', phone: '', applicationDate: today(), bankName: '', bankAccount: '', reason: '', entryIds: [] as number[] },
  },

  onLoad() { this.bindSpeech(); void this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  async load() {
    this.setData({ loading: true });
    try {
      const [dashboard, entries, projects, invoices, reimbursements] = await Promise.all([
        finance.dashboard(), finance.entries(), finance.projects(), finance.invoices(), finance.reimbursements(),
      ]);
      const rootProjects = projects.filter((project) => !project.parentId);
      const nameById = new Map(projects.map((project) => [project.id, project.name]));
      const entryViews = entries.map((entry) => this.entryView(entry, nameById));
      const invoiceViews = invoices.map((invoice) => this.invoiceView(invoice));
      const reimbursementViews = reimbursements.map((item) => this.reimbursementView(item));
      const dashboardView = this.dashboardView(dashboard);
      const tabs = this.data.tabs.map((tab: any) => ({
        ...tab,
        badge: tab.key === 'invoices' ? dashboard.invoiceInbox : tab.key === 'reimbursements' ? dashboard.pendingReimbursement : 0,
      }));
      this.setData({
        dashboard: dashboardView,
        tabs,
        entries: entryViews,
        recentEntries: entryViews.slice(0, 5),
        pendingEntries: entryViews.filter((entry) => entry.reimbursementStatus === 'pending'),
        projects,
        projectGroups: rootProjects.map((project) => ({ ...project, descriptionText: project.description || '暂无项目说明', children: projects.filter((child) => child.parentId === project.id) })),
        projectOptions: ['暂不选择', ...projects.map((project) => project.parentId ? `${nameById.get(project.parentId)} / ${project.name}` : project.name)],
        parentProjectOptions: ['不选择，创建一级项目', ...rootProjects.map((project) => project.name)],
        invoices: invoiceViews,
        reimbursements: reimbursementViews,
      });
    } catch (error: any) {
      wx.showToast({ icon: 'none', title: error?.message || '财务数据加载失败' });
    } finally { this.setData({ loading: false }); }
  },

  dashboardView(value: FinanceDashboard) {
    return { incomeText: money(value.month.income), expenseText: money(value.month.expense), balanceText: money(value.month.balance), pendingReimbursement: value.pendingReimbursement, invoiceInbox: value.invoiceInbox, projects: value.projects };
  },
  entryView(entry: FinanceEntry, names: Map<number, string>) : EntryView {
    const flowClass = entry.flowType === 'income' ? 'income' : 'expense';
    const projectText = entry.subProjectId ? names.get(entry.subProjectId) : entry.projectId ? names.get(entry.projectId) : '未归属项目';
    return { ...entry, amountText: money(entry.amount), flowClass, flowIcon: flowClass, sign: flowClass === 'income' ? '+' : '-', ownerText: ownerLabels[entry.owner] || entry.owner, paymentText: paymentLabels[entry.paymentMethod] || entry.paymentMethod, reimbursementText: reimbursementLabels[entry.reimbursementStatus] || entry.reimbursementStatus, projectText: projectText || '未归属项目' };
  },
  invoiceView(invoice: FinanceInvoice): InvoiceView {
    return { ...invoice, amountText: invoice.amount ? `¥${money(invoice.amount)}` : '金额待识别', createdText: shortDate(invoice.createdAt), sourceText: invoice.source === 'email' ? 'QQ 邮箱' : '手工上传', statusText: invoiceLabels[invoice.status] || invoice.status };
  },
  reimbursementView(item: FinanceReimbursement): ReimbursementView {
    return { ...item, amountText: money(item.amount), statusText: item.status === 'paid' ? '已报销' : item.status === 'cancelled' ? '已取消' : '待付款' };
  },

  setTab(event: any) { this.setData({ activeTab: event.currentTarget.dataset.key }); },
  openEntryForm() { this.openSheet('entry', '快速登记', '记一笔收入或支出', '保存流水'); },
  openProjectForm(event?: any) {
    const parentId = Number(event?.currentTarget?.dataset?.parent || 0) || null;
    const roots = this.data.projects.filter((project) => !project.parentId);
    const index = parentId ? roots.findIndex((project) => project.id === parentId) + 1 : 0;
    this.setData({ projectParentIndex: index, selectedParentName: this.data.parentProjectOptions[index], projectForm: { parentId, name: '', description: '' } });
    this.openSheet('project', parentId ? '项目管理 · 子项目' : '项目管理', parentId ? '新建子项目' : '新建项目', '创建项目');
  },
  openReimburseForm() {
    if (!this.data.pendingEntries.length) return wx.showToast({ icon: 'none', title: '目前没有待报销流水' });
    this.setData({ reimburseForm: { claimantName: '', phone: '', applicationDate: today(), bankName: '', bankAccount: '', reason: '', entryIds: [] } });
    this.openSheet('reimburse', '报销管理', '发起报销申请', '提交申请');
  },
  openSheet(sheet: any, sheetEyebrow: string, sheetTitle: string, sheetSubmitText: string) { this.setData({ sheet, sheetEyebrow, sheetTitle, sheetSubmitText }); },
  closeSheet() { if (!this.data.saving) this.setData({ sheet: '', candidates: [], matchingInvoice: null }); },

  bindSpeech() {
    if (!speechManager) return;
    hold = createHoldToTalk(speechManager, { onPressing: (pressing) => this.setData({ pressing }) });
    this.setData({ hasSpeech: true });
    speechManager.onStart = () => { this.setData({ recording: true }); hold?.started(); };
    speechManager.onRecognize = () => undefined;
    speechManager.onStop = (result: { result?: string }) => {
      hold?.ended(); const text = String(result.result || '').trim(); const before = this.data.entryForm.reason.trim();
      this.setData({ recording: false, 'entryForm.reason': text ? (before ? `${before}；${text}` : text) : before });
    };
    speechManager.onError = (error: any) => { hold?.ended(); this.setData({ recording: false }); speechErrorTip(error).then((title) => wx.showToast({ icon: 'none', title })); };
  },
  onStartRecord() { hold?.press(); }, onStopRecord() { hold?.release(); }, onHoldMove() {}, noop() {},
  setFlow(event: any) { this.setData({ 'entryForm.flowType': event.currentTarget.dataset.value }); },
  setOwner(event: any) { this.setData({ 'entryForm.owner': event.currentTarget.dataset.value }); },
  setPayment(event: any) { this.setData({ 'entryForm.paymentMethod': event.currentTarget.dataset.value }); },
  onDate(event: any) { this.setData({ 'entryForm.businessDate': event.detail.value }); },
  onReason(event: any) { this.setData({ 'entryForm.reason': event.detail.value }); },
  onAmount(event: any) { this.setData({ 'entryForm.amount': event.detail.value }); },
  onProject(event: any) { const index = Number(event.detail.value); const project = index ? this.data.projects[index - 1] : null; this.setData({ 'entryForm.projectId': project?.id || null, selectedProjectName: this.data.projectOptions[index] }); },
  onReimbursement(event: any) { this.setData({ 'entryForm.reimbursementRequired': event.detail.value }); },
  onParentProject(event: any) { const index = Number(event.detail.value); const roots = this.data.projects.filter((project) => !project.parentId); this.setData({ projectParentIndex: index, selectedParentName: this.data.parentProjectOptions[index], 'projectForm.parentId': index ? roots[index - 1].id : null }); },
  onProjectInput(event: any) { this.setData({ [`projectForm.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onReimburseInput(event: any) { this.setData({ [`reimburseForm.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  onReimburseDate(event: any) { this.setData({ 'reimburseForm.applicationDate': event.detail.value }); },
  onReimburseEntries(event: any) { this.setData({ 'reimburseForm.entryIds': event.detail.value.map(Number) }); },

  async submitSheet() {
    if (this.data.sheet === 'entry') return this.saveEntry();
    if (this.data.sheet === 'project') return this.saveProject();
    if (this.data.sheet === 'reimburse') return this.saveReimbursement();
  },
  async saveEntry() {
    const form = this.data.entryForm;
    if (!form.reason.trim()) return wx.showToast({ icon: 'none', title: '请填写事由' });
    if (!Number(form.amount) || Number(form.amount) <= 0) return wx.showToast({ icon: 'none', title: '金额必须大于 0' });
    this.setData({ saving: true });
    try { await finance.createEntry(form as any); wx.showToast({ icon: 'success', title: '已记账' }); this.setData({ sheet: '', entryForm: { ...form, reason: '', amount: '', projectId: null }, selectedProjectName: '暂不选择' }); await this.load(); }
    catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '保存失败' }); }
    finally { this.setData({ saving: false }); }
  },
  async saveProject() {
    const form = this.data.projectForm;
    if (!form.name.trim()) return wx.showToast({ icon: 'none', title: '请填写项目名称' });
    this.setData({ saving: true });
    try { await finance.createProject(form as any); wx.showToast({ icon: 'success', title: '项目已创建' }); this.setData({ sheet: '' }); await this.load(); }
    catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '创建失败' }); }
    finally { this.setData({ saving: false }); }
  },
  async saveReimbursement() {
    const form = this.data.reimburseForm;
    const missing = !form.claimantName.trim() || !form.phone.trim() || !form.bankName.trim() || !form.bankAccount.trim() || !form.reason.trim();
    if (missing) return wx.showToast({ icon: 'none', title: '请完整填写报销信息' });
    if (!form.entryIds.length) return wx.showToast({ icon: 'none', title: '请选择待报销流水' });
    this.setData({ saving: true });
    try { await finance.createReimbursement(form as any); wx.showToast({ icon: 'success', title: '申请已提交' }); this.setData({ sheet: '' }); await this.load(); }
    catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '提交失败' }); }
    finally { this.setData({ saving: false }); }
  },

  async chooseInvoice() {
    if (this.data.uploading) return;
    try {
      const result = await wx.chooseMessageFile({ count: 1, type: 'file', extension: ['pdf'] });
      const file = result.tempFiles[0];
      if (!file || !/\.pdf$/i.test(file.name || '')) return wx.showToast({ icon: 'none', title: '请选择 PDF 发票' });
      this.setData({ uploading: true }); wx.showLoading({ title: '正在上传 PDF' });
      await finance.uploadInvoice(file.path); wx.hideLoading(); wx.showToast({ icon: 'success', title: '发票已导入' }); await this.load();
    } catch (error: any) {
      wx.hideLoading(); if (!/cancel/i.test(String(error?.errMsg || error?.message || ''))) wx.showToast({ icon: 'none', title: error?.message || '上传失败' });
    } finally { this.setData({ uploading: false }); }
  },
  async openInvoiceMatch(event: any) {
    const id = Number(event.currentTarget.dataset.id); const invoice = this.data.invoices.find((item) => item.id === id); if (!invoice) return;
    wx.showLoading({ title: '查找候选流水' });
    try { const candidates = await finance.invoiceCandidates(id); const names = new Map(this.data.projects.map((project) => [project.id, project.name])); this.setData({ matchingInvoice: invoice, candidates: candidates.map((entry) => this.entryView(entry, names)) }); this.openSheet('match', '人工匹配', '选择对应流水', ''); }
    catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '候选流水加载失败' }); }
    finally { wx.hideLoading(); }
  },
  async matchInvoice(event: any) { if (!this.data.matchingInvoice) return; try { await finance.matchInvoice(this.data.matchingInvoice.id, Number(event.currentTarget.dataset.id)); wx.showToast({ icon: 'success', title: '匹配成功' }); this.setData({ sheet: '' }); await this.load(); } catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '匹配失败' }); } },
  async discardInvoice(event: any) { const result = await wx.showModal({ title: '丢弃这张发票？', content: '只会移出待处理列表，不会删除 QQ 邮件，之后仍可恢复。', confirmText: '确认丢弃' }); if (!result.confirm) return; try { await finance.discardInvoice(Number(event.currentTarget.dataset.id)); await this.load(); } catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '操作失败' }); } },
  async restoreInvoice(event: any) { try { await finance.restoreInvoice(Number(event.currentTarget.dataset.id)); await this.load(); } catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '恢复失败' }); } },
  async markPaid(event: any) { const result = await wx.showModal({ title: '确认已完成报销？', content: '确认后，申请内的流水会一起标记为已报销。' }); if (!result.confirm) return; try { await finance.markReimbursementPaid(Number(event.currentTarget.dataset.id)); wx.showToast({ icon: 'success', title: '已完成报销' }); await this.load(); } catch (error: any) { wx.showToast({ icon: 'none', title: error?.message || '操作失败' }); } },
});
