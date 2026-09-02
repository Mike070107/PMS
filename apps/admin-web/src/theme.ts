import type { ThemeConfig } from 'antd';

/**
 * PMS Admin 设计系统（design-system/pms-admin/MASTER.md）
 * 简洁运营后台配色：中性灰白承载内容，海军蓝用于导航与信息强调。
 */
export const brand = {
  primary: '#31558a',
  primaryHover: '#254675',
  accent: '#4f7fb3',
  ink: '#1f334a',
  inkSecondary: '#5f7287',
  bgLayout: '#eef3f8',
  siderTop: '#31558a',
  siderBottom: '#243f69',
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
    colorBorder: '#d6e1ec',
    colorBorderSecondary: '#e4ebf2',
    colorBgContainer: '#ffffff',
    colorFillAlter: '#f5f8fb',
    borderRadius: 12,
    borderRadiusSM: 9,
    fontSize: 16,
    controlHeight: 46,
    controlHeightLG: 50,
    padding: 18,
    paddingLG: 24,
    boxShadowTertiary:
      '0 1px 2px rgba(31, 41, 55, 0.04), 0 8px 24px rgba(31, 41, 55, 0.05)',
  },
  components: {
    Button: {
      controlHeight: 46,
      controlHeightLG: 52,
      fontWeight: 500,
      primaryShadow: '0 4px 14px rgba(49, 85, 138, 0.18)',
    },
    Card: {
      headerFontSize: 18,
      headerHeight: 62,
      boxShadowTertiary:
        '0 1px 2px rgba(31, 41, 55, 0.04), 0 8px 24px rgba(31, 41, 55, 0.05)',
    },
    Descriptions: { titleMarginBottom: 18 },
    Form: { labelFontSize: 16, verticalLabelPadding: '0 0 10px' },
    Input: { inputFontSize: 16, activeBorderColor: brand.primary },
    Menu: {
      itemHeight: 48,
      fontSize: 15,
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemColor: brand.siderText,
      darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
      darkItemSelectedBg: 'rgba(255, 255, 255, 0.14)',
      darkItemSelectedColor: '#ffffff',
      itemMarginInline: 8,
      itemBorderRadius: 9,
    },
    Table: {
      cellFontSize: 15,
      headerBg: '#f4f8fc',
      headerColor: '#465d75',
      headerSplitColor: 'transparent',
      rowHoverBg: '#edf4fa',
    },
    Modal: { titleFontSize: 20 },
    Select: { optionFontSize: 16, controlHeight: 46 },
    Tabs: { titleFontSize: 16, horizontalItemPadding: '14px 4px' },
    Statistic: { contentFontSize: 30 },
    Tag: { borderRadiusSM: 6 },
    // 全局 borderRadiusSM=9 用在 16px 的复选框上几乎就是个圆点，看着像单选 ——
    // 一屏多选框的页面（角色权限矩阵）会被整片误读成「只能选一个」。
    // Radio 该圆的仍然圆，这里只收回 Checkbox。
    Checkbox: { borderRadiusSM: 4 },
  },
};
