import type { ThemeConfig } from 'antd';

/**
 * PMS Admin 设计系统（design-system/pms-admin/MASTER.md）
 *
 * 2026-10 与新界面（apps/neighbor-web）统一：浅色侧栏 + 墨绿主色 + 大字版尺寸。
 * 字号/控件高度本来就已经按现场用户放大过（16px 基准、46px 控件），这里只调色板与导航。
 */
export const brand = {
  primary: '#0e6b5a',
  primaryHover: '#0a5547',
  accent: '#0b5a4b',
  ink: '#17201c',
  inkSecondary: '#55615b',
  bgLayout: '#f5f6f3',
  siderTop: '#ffffff',
  siderBottom: '#fbfcfa',
  siderText: 'rgba(23, 32, 28, 0.82)',
  siderTextMuted: 'rgba(23, 32, 28, 0.46)',
  gold: '#a45f00',
};

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: brand.primary,
    colorInfo: brand.accent,
    colorLink: brand.accent,
    colorTextBase: brand.ink,
    colorBgLayout: brand.bgLayout,
    colorBorder: '#e3e6e0',
    colorBorderSecondary: '#eef0eb',
    colorBgContainer: '#ffffff',
    colorFillAlter: '#f7f8f6',
    borderRadius: 12,
    borderRadiusSM: 9,
    fontSize: 16,
    controlHeight: 46,
    controlHeightLG: 50,
    padding: 18,
    paddingLG: 24,
    boxShadowTertiary:
      '0 1px 2px rgba(23, 32, 28, 0.04), 0 8px 24px rgba(23, 32, 28, 0.05)',
  },
  components: {
    Button: {
      controlHeight: 46,
      controlHeightLG: 52,
      fontWeight: 500,
      primaryShadow: '0 4px 14px rgba(14, 107, 90, 0.18)',
    },
    Card: {
      headerFontSize: 18,
      headerHeight: 62,
      boxShadowTertiary:
        '0 1px 2px rgba(23, 32, 28, 0.04), 0 8px 24px rgba(23, 32, 28, 0.05)',
    },
    Descriptions: { titleMarginBottom: 18 },
    Form: { labelFontSize: 16, verticalLabelPadding: '0 0 10px' },
    Input: { inputFontSize: 16, activeBorderColor: brand.primary },
    Menu: {
      itemHeight: 46,
      fontSize: 15.5,
      // 浅色侧栏：未选中用次要墨色，选中用墨绿浅底
      itemBg: 'transparent',
      itemColor: brand.siderText,
      itemHoverBg: '#f5f7f4',
      itemHoverColor: brand.ink,
      itemSelectedBg: '#e2f0eb',
      itemSelectedColor: '#0b5a4b',
      itemMarginInline: 8,
      itemBorderRadius: 9,
      groupTitleColor: '#8d978f',
      // 移动端抽屉仍可能用深色主题，保留一套 dark 值
      darkItemBg: 'transparent',
      darkSubMenuItemBg: 'transparent',
      darkItemColor: 'rgba(255,255,255,0.82)',
      darkItemHoverBg: 'rgba(255, 255, 255, 0.08)',
      darkItemSelectedBg: 'rgba(255, 255, 255, 0.14)',
      darkItemSelectedColor: '#ffffff',
    },
    Table: {
      cellFontSize: 15.5,
      headerBg: '#f7f8f6',
      headerColor: '#55615b',
      headerSplitColor: 'transparent',
      rowHoverBg: '#f6f9f6',
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
