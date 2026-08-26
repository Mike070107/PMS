import type { ThemeConfig } from 'antd';

/**
 * PMS Admin 设计系统（design-system/pms-admin/MASTER.md）
 * 简洁运营后台配色：中性灰白承载内容，海军蓝用于导航与信息强调。
 */
export const brand = {
  primary: '#31558a',
  primaryHover: '#254675',
  accent: '#4f6fae',
  ink: '#202635',
  inkSecondary: '#6b7280',
  bgLayout: '#f5f6f8',
  siderTop: '#1f2937',
  siderBottom: '#111827',
  siderText: 'rgba(241, 245, 249, 0.82)',
  siderTextMuted: 'rgba(241, 245, 249, 0.46)',
  gold: '#f59e0b',
};

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: brand.primary,
    colorInfo: brand.accent,
    colorLink: brand.accent,
    colorTextBase: brand.ink,
    colorBgLayout: brand.bgLayout,
    colorBorder: '#e2e5ea',
    colorBorderSecondary: '#eceef2',
    borderRadius: 12,
    borderRadiusSM: 9,
    fontSize: 14,
    controlHeight: 40,
    controlHeightLG: 44,
    padding: 18,
    paddingLG: 24,
    boxShadowTertiary:
      '0 1px 2px rgba(31, 41, 55, 0.04), 0 8px 24px rgba(31, 41, 55, 0.05)',
  },
  components: {
    Button: {
      controlHeight: 40,
      controlHeightLG: 46,
      fontWeight: 600,
      primaryShadow: '0 4px 14px rgba(49, 85, 138, 0.18)',
    },
    Card: {
      headerFontSize: 16,
      headerHeight: 58,
      boxShadowTertiary:
        '0 1px 2px rgba(31, 41, 55, 0.04), 0 8px 24px rgba(31, 41, 55, 0.05)',
    },
    Descriptions: { titleMarginBottom: 18 },
    Form: { labelFontSize: 15 },
    Input: { inputFontSize: 15 },
    Menu: {
      itemHeight: 40,
      fontSize: 13.5,
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemColor: brand.siderText,
      darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
      darkItemSelectedBg: 'rgba(255, 255, 255, 0.14)',
      darkItemSelectedColor: '#ffffff',
      itemMarginInline: 8,
      itemBorderRadius: 9,
    },
    Select: { optionFontSize: 15 },
    Table: {
      cellFontSize: 14.5,
      headerBg: '#f6f7f9',
      headerColor: '#596171',
      headerSplitColor: 'transparent',
      rowHoverBg: '#f5f7fb',
    },
    Tabs: { titleFontSize: 15 },
    Statistic: { contentFontSize: 30 },
    Tag: { borderRadiusSM: 6 },
    // 全局 borderRadiusSM=9 用在 16px 的复选框上几乎就是个圆点，看着像单选 ——
    // 一屏多选框的页面（角色权限矩阵）会被整片误读成「只能选一个」。
    // Radio 该圆的仍然圆，这里只收回 Checkbox。
    Checkbox: { borderRadiusSM: 4 },
  },
};
