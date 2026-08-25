import { inventory, upload } from '@pms/api-client';
import { MATERIAL_CATEGORIES, MATERIAL_UNITS, type MaterialView } from '@pms/shared-types';
import { getSession } from '../../utils/session';
import { setTabBadge, syncTabBar } from '../../utils/tabbar';

/**
 * 材料 SKU 库。办公室一侧的常驻一屏（tabBar 第二格「材料与库存」）。
 *
 * 谁能改不再按业务身份写死：后端是按 materials:edit 放行的，端上照抄同一套
 * （见 utils/session.ts）。原来这里把办公室钉成只读，可后端一直允许他们改 ——
 * 结果「维修工现场手填了一个名字、办公室回来把它建成正经 SKU」这条主线，
 * 在小程序里根本点不动。
 */

interface MaterialRow extends MaterialView {
  costText: string;
  aliasText: string;
  titleText: string;
  /** 缺哪些信息，直接写成「照片、类别」贴在卡片上 */
  missingText: string;
  incomplete: boolean;
}

const yuan = (cents: number) => (cents ? `¥${(cents / 100).toFixed(2)}` : '—');

/**
 * 「没填完整」的判定只在这里写一次。
 *
 * 挑这三样是因为它们决定这条 SKU 在别处还能不能用：
 * 没照片 → 维修工在库存里认不出 DN50 和 DN75；
 * 没类别 → 编码前缀、类别筛选都对不上；
 * 没默认成本 → 采购申请估不出金额。
 * 型号、别名、参数属于锦上添花，缺了不算残缺，不然整库都是红标，等于没标。
 */
function missingFields(item: MaterialView): string[] {
  const missing: string[] = [];
  if (!item.photoUrl) missing.push('照片');
  if (!item.category) missing.push('类别');
  if (!item.defaultCostCents) missing.push('成本');
  return missing;
}

function toRow(item: MaterialView): MaterialRow {
  const missing = missingFields(item);
  return {
    ...item,
    costText: yuan(item.defaultCostCents),
    aliasText: (item.aliases || []).join('、'),
    titleText: item.spec ? `${item.name} · ${item.spec}` : item.name,
    missingText: missing.join('、'),
    incomplete: missing.length > 0,
  };
}

interface FormState {
  id: number | null;
  name: string;
  spec: string;
  category: string;
  unit: string;
  costYuan: string;
  aliases: string;
  params: string;
  photoUrl: string;
  enabled: boolean;
}

const emptyForm = (): FormState => ({
  id: null,
  name: '',
  spec: '',
  category: '',
  unit: '个',
  costYuan: '',
  aliases: '',
  params: '',
  photoUrl: '',
  enabled: true,
});

Page({
  data: {
    canView: true,
    canEdit: false,
    roleHint: '',
    loading: true,
    keyword: '',
    /** 只看没填完整的那些：办公室补 SKU 时先把这一堆清掉 */
    onlyIncomplete: false,
    incompleteCount: 0,
    categoryIndex: -1,
    categories: MATERIAL_CATEGORIES,
    units: MATERIAL_UNITS,
    list: [] as MaterialRow[],
    editorOpen: false,
    saving: false,
    uploading: false,
    form: emptyForm(),
    unitIndex: 0,
    formCategoryIndex: -1,
    errors: { name: '', unit: '' },
  },

  /** 全量材料放实例上，筛选在本地做，避免每次输入都请求 */
  all: [] as MaterialView[],

  onShow() {
    syncTabBar(this, 'materials');
    this.load();
  },

  /** 给弹层遮罩的 catchtouchmove 用：吞掉滑动，别让底下的列表跟着滚 */
  noop() {},

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const session = await getSession(this);
      if (!session.canViewMaterials) {
        this.setData({
          canView: false,
          canEdit: false,
          roleHint: '你的账号没有材料库权限。需要材料请在工单详情里提报缺料，由办公室汇总。',
          list: [],
        });
        return;
      }
      this.setData({ canView: true, canEdit: session.canEditMaterials });
      this.all = await inventory.listMaterials();
      const incompleteCount = this.all.filter((item) => missingFields(item).length > 0).length;
      this.setData({ incompleteCount });
      // 角标 = 还有几条要补：办公室不用点进来才知道有没有活
      setTabBadge(this, 'materials', session.canEditMaterials ? incompleteCount : 0);
      this.applyFilter();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyFilter() {
    const kw = this.data.keyword.trim().toLowerCase();
    const category =
      this.data.categoryIndex >= 0 ? MATERIAL_CATEGORIES[this.data.categoryIndex] : '';
    const list = this.all
      .filter((item) => {
        if (category && item.category !== category) return false;
        if (this.data.onlyIncomplete && missingFields(item).length === 0) return false;
        if (!kw) return true;
        return [item.name, item.spec, item.code, item.category, ...(item.aliases || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(kw);
      })
      .map(toRow);
    this.setData({ list });
  },

  onKeyword(e: WechatMiniprogram.Input) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter());
  },

  onPickCategory(e: WechatMiniprogram.BaseEvent) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ categoryIndex: this.data.categoryIndex === index ? -1 : index }, () =>
      this.applyFilter(),
    );
  },

  onToggleIncomplete() {
    this.setData({ onlyIncomplete: !this.data.onlyIncomplete }, () => this.applyFilter());
  },

  // ---------------- 新增 / 编辑 ----------------

  onCreate() {
    this.setData({
      editorOpen: true,
      form: emptyForm(),
      unitIndex: Math.max(0, MATERIAL_UNITS.indexOf('个')),
      formCategoryIndex: -1,
      errors: { name: '', unit: '' },
    });
  },

  onEdit(e: WechatMiniprogram.BaseEvent) {
    const row = this.data.list[Number(e.currentTarget.dataset.index)];
    if (!row) return;
    // 办公室只读：点开看详情，不给编辑面板
    if (!this.data.canEdit) {
      const lines = [
        `编码：${row.code}`,
        `类别：${row.category || '未分类'} · 单位：${row.unit}`,
        `默认成本：${row.costText}`,
        row.aliasText ? `别名：${row.aliasText}` : '',
        row.params ? `参数：${row.params}` : '',
        row.missingText ? `待补充：${row.missingText}（照片/类别/默认成本）` : '',
        row.enabled ? '' : '状态：已停用',
      ].filter(Boolean);
      wx.showModal({
        title: row.titleText,
        content: lines.join('\n'),
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    this.setData({
      editorOpen: true,
      form: {
        id: row.id,
        name: row.name,
        spec: row.spec || '',
        category: row.category || '',
        unit: row.unit,
        costYuan: row.defaultCostCents ? String(row.defaultCostCents / 100) : '',
        aliases: (row.aliases || []).join('、'),
        params: row.params || '',
        photoUrl: row.photoUrl || '',
        enabled: row.enabled,
      },
      // 历史上手填过的单位不在常用表里时，选择器停在第一项，保存时仍按表单里的值走
      unitIndex: Math.max(0, MATERIAL_UNITS.indexOf(row.unit)),
      formCategoryIndex: row.category ? MATERIAL_CATEGORIES.indexOf(row.category) : -1,
      errors: { name: '', unit: '' },
    });
  },

  onCloseEditor() {
    this.setData({ editorOpen: false });
  },

  onFormInput(e: WechatMiniprogram.Input) {
    const field = e.currentTarget.dataset.field as keyof FormState;
    this.setData({ [`form.${field}`]: e.detail.value, [`errors.${field}`]: '' });
  },

  onFormUnit(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({ unitIndex: index, 'form.unit': MATERIAL_UNITS[index], 'errors.unit': '' });
  },

  onFormCategory(e: WechatMiniprogram.PickerChange) {
    const index = Number(e.detail.value);
    this.setData({ formCategoryIndex: index, 'form.category': MATERIAL_CATEGORIES[index] });
  },

  onToggleEnabled(e: WechatMiniprogram.SwitchChange) {
    this.setData({ 'form.enabled': e.detail.value });
  },

  /** 现场拍一张实物照，比在电脑上传方便得多 */
  async onChoosePhoto() {
    if (this.data.uploading) return;
    const res = await wx
      .chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['camera', 'album'] })
      .catch(() => null);
    if (!res?.tempFiles?.length) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中…', mask: true });
    try {
      const [uploaded] = await upload.uploadTempFiles([res.tempFiles[0].tempFilePath]);
      this.setData({ 'form.photoUrl': uploaded.publicUrl });
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '上传失败' });
    } finally {
      wx.hideLoading();
      this.setData({ uploading: false });
    }
  },

  onRemovePhoto() {
    this.setData({ 'form.photoUrl': '' });
  },

  async onSave() {
    const form = this.data.form;
    const errors = {
      name: form.name.trim() ? '' : '请填写材料名称',
      unit: form.unit.trim() ? '' : '请选择单位',
    };
    this.setData({ errors });
    if (errors.name || errors.unit) return;

    const cost = Number(form.costYuan);
    if (form.costYuan && (!Number.isFinite(cost) || cost < 0)) {
      return wx.showToast({ icon: 'none', title: '默认成本填写不正确' });
    }

    const payload = {
      name: form.name.trim(),
      spec: form.spec.trim() || undefined,
      category: form.category || undefined,
      unit: form.unit.trim(),
      defaultCostCents: form.costYuan ? Math.round(cost * 100) : undefined,
      photoUrl: form.photoUrl || undefined,
      aliases: form.aliases
        .split(/[、,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      params: form.params.trim() || undefined,
      enabled: form.enabled,
    };

    this.setData({ saving: true });
    try {
      if (form.id) {
        await inventory.updateMaterial(form.id, payload);
        wx.showToast({ title: '已保存' });
      } else {
        await inventory.createMaterial(payload);
        wx.showToast({ title: '材料已新增' });
      }
      this.setData({ editorOpen: false });
      await this.load();
    } catch (e: any) {
      wx.showToast({ icon: 'none', title: e?.message || '保存失败' });
    } finally {
      this.setData({ saving: false });
    }
  },

  onOpenInventory() {
    wx.navigateTo({ url: '/pages/inventory/inventory' });
  },
});
