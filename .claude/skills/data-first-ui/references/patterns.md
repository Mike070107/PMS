# 可直接抄的实现

所有值都基于 `packages/miniapp-ui/tokens.wxss` 已有的 token。
**新增的 token 写进那个文件，不要在页面里写死 rpx。**

## 需要往 tokens.wxss 补的几个

现有 token 只到 `--font-3xl: 38rpx`，撑不起锚点档。补：

```css
/* 锚点字号：只给「每块唯一的那个数值」用，别拿来做标题 */
--font-stat: 44rpx;      /* 网格里的数值 */
--font-stat-lg: 56rpx;   /* 页头里的统计数字 */

/* 卡片描边：比阴影更干净，深色页头上也不会糊 */
--color-hairline: #eaecf0;

/* 悬浮层阴影，只此一档 */
--shadow-float: 0 8rpx 32rpx rgba(31, 45, 74, 0.12);
```

## 1. 数据网格 stat-grid

```html
<view class="stat-grid">
  <view class="stat">
    <view class="stat__label">工单状态</view>
    <view class="stat__value">进行中</view>
    <view class="stat__hint">张师傅 已接</view>
  </view>
  <!-- 重复 3–7 个 -->
</view>
```

```css
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2rpx;                         /* 缝隙即分隔线，不另画 border */
  background: var(--color-hairline);
  border-radius: var(--radius-md);
  overflow: hidden;                  /* 让子格的直角被圆角裁掉 */
}
/* 3 个一行时改 repeat(3,1fr)，2 个时 repeat(2,1fr) —— 别让最后一格空着 */
.stat-grid--3 { grid-template-columns: repeat(3, 1fr); }
.stat-grid--2 { grid-template-columns: repeat(2, 1fr); }

.stat {
  background: var(--color-card-bg);
  padding: var(--space-md) var(--space-sm);
  text-align: center;
  min-height: 168rpx;                /* 三层内容 + 呼吸，低于这个数会挤 */
  box-sizing: border-box;
}
.stat__label {
  font-size: var(--font-xs);          /* 26rpx */
  color: var(--color-text-tertiary);
  line-height: 1.5;
}
.stat__value {
  margin-top: var(--space-xs);
  font-size: var(--font-stat);        /* 44rpx —— 锚点 */
  font-weight: 600;
  line-height: 1.2;
  color: var(--color-brand);
  font-variant-numeric: tabular-nums; /* 数字等宽，多格并排时不会左右跳 */
}
/* 值是中文词（「进行中」「国内出口」）时降一档，否则 4 个汉字撑破格子 */
.stat__value--text { font-size: var(--font-2xl); }
.stat__hint {
  margin-top: var(--space-xs);
  font-size: 24rpx;
  color: var(--color-text-tertiary);
  line-height: 1.5;
}
/* 语义色只改颜色，不改字号 */
.stat__value--danger { color: var(--color-danger); }
.stat__value--warn { color: #ad6800; }
.stat__value--success { color: var(--color-success); }
```

**坑**：`overflow: hidden` 必须写在 `.stat-grid` 上。写在 `.stat` 上圆角不生效，
四角会露出直角白块。

## 2. 深色页头 hero

```html
<view class="hero">
  <view class="hero__title">工单池</view>
  <view class="hero__stats">
    <view class="hero__stat">
      <view class="hero__num">12</view>
      <view class="hero__cap">待接单</view>
    </view>
    <view class="hero__stat">
      <view class="hero__num">3</view>
      <view class="hero__cap">已超时</view>
    </view>
  </view>
</view>
<view class="sheet"><!-- 内容区 --></view>
```

```css
.hero {
  background: var(--color-brand-dark);
  padding: var(--space-lg) var(--space-lg) calc(var(--space-xl) + var(--radius-lg));
  color: #fff;
}
.hero__title { font-size: var(--font-3xl); font-weight: 600; line-height: 1.4; }
.hero__stats { display: flex; gap: var(--space-xl); margin-top: var(--space-md); }
.hero__num {
  font-size: var(--font-stat-lg);     /* 56rpx */
  font-weight: 600;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.hero__cap {
  font-size: var(--font-sm);
  color: rgba(255, 255, 255, 0.72);   /* 不用纯灰，深底上会脏 */
  margin-top: 4rpx;
}

/* 内容区上翻，压住页头底部那一截 padding */
.sheet {
  position: relative;
  margin-top: calc(-1 * var(--radius-lg));
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  background: var(--color-page-bg);
  padding: var(--space-lg) var(--space-lg) var(--space-2xl);
  min-height: 60vh;
}
```

**坑**：`.hero` 的 padding-bottom 必须**多留出 `--radius-lg`**，
否则 `.sheet` 上翻后会盖住统计数字。

## 3. 状态胶囊 pill

```css
.pill {
  display: inline-flex;
  align-items: center;
  height: 44rpx;
  padding: 0 var(--space-sm);
  border-radius: 999rpx;
  font-size: var(--font-xs);
  line-height: 1;
  background: transparent;
  border: 2rpx solid currentColor;    /* 边框跟着文字色走，只需改一处 */
}
.pill--pending { color: #1677ff; }
.pill--doing { color: var(--color-brand); }
.pill--done { color: var(--color-success); }
.pill--overdue { color: var(--color-danger); }
```

现有 `pms-tag` 组件已经在做类似的事——**优先改那个组件，不要新起一套**。

## 4. 悬浮底栏 floating tabbar

```css
.tabbar-float {
  position: fixed;
  left: var(--space-lg);
  right: var(--space-lg);
  bottom: calc(var(--space-md) + env(safe-area-inset-bottom));
  z-index: 10;
  display: flex;
  height: 112rpx;
  border-radius: 999rpx;
  background: var(--color-card-bg);
  box-shadow: var(--shadow-float);
}
.tabbar-float__item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4rpx;
  font-size: 24rpx;
  color: var(--color-text-tertiary);
}
.tabbar-float__item--on { color: var(--color-brand); font-weight: 500; }
.tabbar-float__icon { width: 40rpx; height: 40rpx; }
```

内容区要留出高度：`padding-bottom: calc(200rpx + env(safe-area-inset-bottom))`。

**员工端已有自定义 tabBar**（`custom-tab-bar/`，`app.json` 里 `"custom": true`），
改这一套要动那个组件，不是加新的。图标一律 SVG，禁止 emoji。

## 5. 卡片 card

```css
.card {
  background: var(--color-card-bg);
  border-radius: var(--radius-lg);
  border: 2rpx solid var(--color-hairline);   /* 描边代替阴影 */
  padding: var(--space-lg);
  margin-bottom: var(--space-md);
}
```

页面底色 `--color-page-bg: #e6eaf1` 已经和白卡拉开了差距，
**不要再叠阴影**——阴影 + 描边 + 深底一起上，卡片会显脏。

## 把 .kv 列表改成网格的判断

不是所有 `.kv` 都该变网格。逐行问：

| 这一行 | 去处 |
|---|---|
| 值 ≤ 4 字/纯数字，且是决策依据（状态、时长、房号、数量） | 进 stat-grid |
| 值是整句话（故障描述、备注、地址全称） | 留 `.kv`，放网格下面 |
| 值只在详情页有意义（创建人、单号） | 从列表卡里删掉，只留详情页 |

一张列表卡的目标：**网格 2–4 格 + 正文 1–2 行 + 一个操作**。超过就是没删干净。
