/** 小程序端通用格式化工具（两个小程序共用，避免各页面各写一份） */
import {
  formatDateShortCn,
  formatDateTimeCn,
  formatDuration,
  REPAIR_TYPE_LABELS,
  stayDays,
  stayTone,
} from '@pms/shared-types';

/**
 * 时间只有一种写法：`2026/8/9 20:43 周日`（见 shared-types 的 formatDateTimeCn）。
 *
 * 以前这里另有一个 `formatDateTime` 输出「08-09 20:43」、今年以前才带年份 ——
 * 结果同一个页面上，列表是「08-09 20:43」、进度是「2026/8/9 20:43 周日」，
 * 而且不带年份的那种在跨年后完全分不清是哪一年的单。整站统一到带年份带星期的这一种，
 * 别再各页面各写各的。
 */
export { formatDateTimeCn, formatDateTimeCn as formatDateTime } from '@pms/shared-types';

/** 缺料清单 → 「PVC 管 DN50 ×2 米、生料带 ×1 卷」 */
export function missingMaterialsText(
  rows?: Array<{ name: string; qty: number; unit?: string }> | null,
): string {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows.map((item) => `${item.name} ×${item.qty}${item.unit || ''}`).join('、');
}

/**
 * 列表项补上可直接渲染的中文标签（wxml 不能调函数）。
 * 停留天数一并算好：从业主提交那一刻起，按自然日跨天数，当天算 0 天。
 * 已完结的单算到完成时刻，否则一直涨到今天，看着像还堆在那儿没人管。
 */
export function withOrderLabels<
  T extends {
    repairType?: string | null;
    repairTypeLabel?: string | null;
    createdAt: string;
    completedAt?: string | null;
    missingMaterials?: Array<{ name: string; qty: number; unit?: string }> | null;
    contactName?: string | null;
    reporterRoleLabel?: string | null;
    source?: string | null;
    sourceLabel?: string | null;
    /** 报修时就标了紧急（描述里说了「急修」），由后端给 */
    urgent?: boolean;
  },
>(
  list: T[],
): Array<
  T & {
    typeLabel: string;
    createdAtText: string;
    stayDays: number;
    stayText: string;
    stayTone: string;
    /** 卡片「报修时间」那一行的短日期：08/24 22:44 */
    timeText: string;
    /** 跟在短日期后面的一枚小标：「已等 3 天」，按 stayTone 上色 */
    stayBadge: string;
    /** 报修时说了「急修」，或者压了 7 天以上 —— 两种都挂「紧急」标 */
    urgent: boolean;
    missingText: string;
    /** 卡片「报修人」：「张阿姨」「王保安（保安代报）」「叶双（员工小程序提交）」，没留名字是「未填」 */
    reporterText: string;
  }
> {
  return list.map((item) => {
    const end = item.completedAt ? new Date(item.completedAt) : new Date();
    const days = stayDays(item.createdAt, isNaN(end.getTime()) ? new Date() : end);
    return {
      ...item,
      // 租户自建的类型只有后端知道中文名（端上的 REPAIR_TYPE_LABELS 只有内置那 8 个），
      // 所以后端给了就用后端的，别再自己猜 —— 猜不到就会把 menjing 这种编码直接显示出来
      typeLabel:
        item.repairTypeLabel ||
        REPAIR_TYPE_LABELS[item.repairType || ''] ||
        item.repairType ||
        '其它',
      // 列表和进度用同一个格式：2026/8/9 17:07 周日
      createdAtText: formatDateTimeCn(item.createdAt),
      stayDays: days,
      stayText: `已停留 ${days} 天`,
      stayTone: stayTone(days),
      // 时间和「等了多久」放同一行，但拆成两个值：
      // 拼成一整串会超过一行宽度折行，而且整串跟着 stayTone 变红太吵 ——
      // 日期永远是黑的，只有「已等 N 天」那一小截上色
      timeText: formatDateShortCn(item.createdAt),
      stayBadge: `已等 ${days} 天`,
      // 报单时说的「急修」和「压了 7 天」都是「这单得先处理」，共用同一枚红标：
      // 分成两种标只会让卡片上多一个要认的东西，而处理动作是一样的
      urgent: !!item.urgent || stayTone(days) === 'danger',
      missingText: missingMaterialsText(item.missingMaterials),
      reporterText: reporterTextOf(item),
    };
  });
}

/**
 * 「报修人」一行的文案：名字 + 身份。工单池、在手工单两张卡共用，别各写一套。
 * 员工在小程序里提交的，reporterRole 也是「员工」，得先按来源判，否则会写成「员工代报」。
 */
function reporterTextOf(item: {
  contactName?: string | null;
  reporterRoleLabel?: string | null;
  source?: string | null;
  sourceLabel?: string | null;
}): string {
  const name = (item.contactName || '').trim();
  if (!name) return item.source === 'staff_miniapp' && item.sourceLabel ? item.sourceLabel : '未填';
  if (item.source === 'staff_miniapp') return `${name}（员工小程序提交）`;
  if (item.reporterRoleLabel) return `${name}（${item.reporterRoleLabel}代报）`;
  return name;
}

/** 手机号脱敏：138****8000 */
export function maskPhone(phone?: string | null): string {
  if (!phone) return '';
  return phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}

export interface TimelineRow {
  id: number;
  label: string;
  note: string;
  at: string;
  /** 这个节点停留了多久（到下一个节点；最后一个节点算到现在） */
  stay: string;
}

/**
 * 进度时间轴：两个小程序渲染的是同一份数据，别各写一套。
 *
 * **倒序返回：最新的动作在第 0 位。** 后端给的 logs 是按 id 升序的流水，
 * 直接铺出来最新一条沉在最底下 —— 打开详情最想知道的是「现在到哪一步了」，
 * 却要先划过「已提交、已派单、已接单…」。所以在这里翻一次，两个端都不用各自 reverse
 * （谁忘了翻，谁那一屏就是老的在上面，两端还对不上）。
 * 折叠展示时取第 0 条，不要再写 length - 1。
 *
 * 每个节点带上「停了多久」——办公室和维修工要的是「卡在哪一步、卡了多久」，
 * 只给绝对时间还得自己心算。停留时长仍按时间正序算（本节点 → 下一个节点），
 * 最新的那个节点在工单没完结时算到此刻，完结了就不显示
 * （已经结束的单再说「已停留」是误导）。
 */
export function buildTimeline(
  logs: Array<{ id: number; toStatus: string; note?: string | null; createdAt: string }>,
  labels: Record<string, string>,
  opts: { finished?: boolean } = {},
): TimelineRow[] {
  return logs
    .map((log, index) => {
      const next = logs[index + 1];
      const isLast = index === logs.length - 1;
      const stay =
        next != null
          ? formatDuration(log.createdAt, next.createdAt)
          : isLast && !opts.finished
            ? formatDuration(log.createdAt, null)
            : '';
      return {
        id: log.id,
        label: labels[log.toStatus] || log.toStatus,
        note: log.note || '',
        at: formatDateTimeCn(log.createdAt),
        stay: stay ? `停留 ${stay}` : '',
      };
    })
    .reverse();
}
