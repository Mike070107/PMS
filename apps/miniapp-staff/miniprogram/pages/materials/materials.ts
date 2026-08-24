import { auth, inventory, upload } from '@pms/api-client';
import {
  MATERIAL_CATEGORIES,
  MATERIAL_UNITS,
  UserRole,
  type MaterialView,
} from '@pms/shared-types';

interface MaterialRow extends MaterialView {
  costText: string;
  aliasText: string;
  titleText: string;
}

/** 和后端 /materials 的权限保持一致：办公室只读，维修工无权 */
const VIEW_ROLES: string[] = [
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.PURCHASER,
  UserRole.OFFICE,
];
const EDIT_ROLES: string[] = [UserRole.ADMIN, UserRole.MANAGER, UserRole.PURCHASER];

const yuan = (cents: number) => (cents ? `¥${(cents / 100).toFixed(2)}` : '—');

function toRow(item: MaterialView): MaterialRow {
  return {
    ...item,
    costText: yuan(item.defaultCostCents),
    aliasText: (item.aliases || []).join('、'),
    titleText: item.spec ? `${item.name} · ${item.spec}` : item.name,
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
      const me = await auth.me();
      if (!VIEW_ROLES.includes(me.role)) {
        this.setData({
          canView: false,
          canEdit: false,
          roleHint: '维修工没有材料库权限。需要材料请在工单详情里提报缺料，由办公室汇总。',
          list: [],
        });
        return;
      }
      this.setData({ canView: true, canEdit: EDIT_ROLES.includes(me.role) });
      this.all = await inventory.listMaterials();
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
