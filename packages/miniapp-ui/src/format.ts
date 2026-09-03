/** 小程序端通用格式化工具（两个小程序共用，避免各页面各写一份） */
import {
  formatDateShortCn,
  formatDateTimeCn,
  formatDuration,
  REPAIR_TYPE_LABELS,
  stayDays,
  stayTone,
  workOrderStatusText,
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
    submittedByName?: string | null;
    status?: string;
    candidateIds?: number[];
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
    /** created 要按是否已进入维修工池区分“待接单 / 待派单” */
    statusText: string;

    /* ---- 下面四个只给卡片上的数据网格用（data-first-ui，工单池 / 在手工单共用） ----
       网格是「标签 / 值 / 说明」三层，值那一层是全卡唯一的视觉锚点，
       要的是「8天」这种能放大的短值，不是「已等 8 天」这种整句。
       stayBadge / reporterText 那两个整句仍留着给详情页等别的地方用。 */
    /** 网格第一格的标签：还没完结说「已等」，完结了说「用时」—— 同一个数，两种意思。
     *  少了这一条，派单台按「已完成」筛出来的单会写成「已等 3 天」，像是还堆在那儿没人管 */
    statStayLabel: string;
    /** 「8天」/「今天」/「当天」—— 网格里放大到 44rpx 的那个数 */
    statStay: string;
    /** 「王女士」—— 报修人姓名，不带身份后缀 */
    statReporter: string;
    /** 「由张三（提交人）在员工小程序提交」—— 压在报修联系人下面 */
    statReporterHint: string;
  }
> {
  return list.map((item) => {
    const end = item.completedAt ? new Date(item.completedAt) : new Date();
    const days = stayDays(item.createdAt, isNaN(end.getTime()) ? new Date() : end);
    const reporterText = reporterTextOf(item);
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
      reporterText,
      statusText: workOrderStatusText(item.status || '', item.candidateIds),
      statStayLabel: item.completedAt ? '用时' : '已等',
      // 当天的写「今天 / 当天」而不是「0天」——「0」放大到 44rpx 看着像出错了
      statStay: days >= 1 ? `${days}天` : item.completedAt ? '当天' : '今天',
      ...splitReporter(reporterText),
      // 主值仍是报修联系人；下面的小字专门交代“谁通过哪个入口提交”，
      // 两个人不是同一概念，不能再只写一个模糊的“员工小程序提交”。
      statReporterHint: submitterHintOf(item) || splitReporter(reporterText).statReporterHint,
    };
  });
}

/**
 * 「王保安（保安代报）」→ 姓名 + 身份两截。
 *
 * 网格的值那一层要放大，只放得下姓名；身份降到下面 24rpx 的说明位。
 * 括号按全角匹配 —— 上面 reporterTextOf 拼的就是全角，别写成半角。
 * 拆不出来（只有姓名、或格式变了）就整串当姓名用，不要吞掉信息。
 */
function splitReporter(text: string): { statReporter: string; statReporterHint: string } {
  const matched = /^(.+?)（(.+)）$/.exec(text || '');
  if (matched) return { statReporter: matched[1], statReporterHint: matched[2] };
  return { statReporter: text || '未填', statReporterHint: '' };
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
  if (!name) return '未填';
  if (item.source === 'staff_miniapp') return `${name}（员工小程序提交）`;
  if (item.reporterRoleLabel) return `${name}（${item.reporterRoleLabel}代报）`;
  return name;
}

function submitterHintOf(item: {
  submittedByName?: string | null;
  source?: string | null;
}): string {
  const channel =
    item.source === 'staff_miniapp'
      ? '员工小程序'
      : item.source === 'owner_miniapp'
        ? '业主小程序'
        : item.source === 'office_web'
          ? '网页平台'
          : '';
  if (!channel) return '';
  const submitter = (item.submittedByName || '').trim() || '未记录姓名';
  return `由 ${submitter}（提交人）在${channel}提交`;
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
  attachments: string[];
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
  logs: Array<{ id: number; toStatus: string; action?: string; note?: string | null; attachments?: string[]; createdAt: string }>,
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
        label:
          log.action === 'progress'
            ? '维修进度更新'
            : log.action === 'transfer_request'
              ? '申请转给其他人维修'
              : labels[log.toStatus] || log.toStatus,
        note: log.note || '',
        at: formatDateTimeCn(log.createdAt),
        stay: stay ? `停留 ${stay}` : '',
        attachments: log.attachments || [],
      };
    })
    .reverse();
}
