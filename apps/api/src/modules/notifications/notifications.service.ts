import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { NotifyChannel, NotifyStatus } from '../../common/enums';
import { Notification, SubscriptionGrant, User } from '../../entities';
import { SettingsService } from '../settings/settings.service';
import { WxServiceAccountService } from './wx-service-account.service';
import { WechatService, type WxAppType, type WxTemplateField } from '../auth/wechat.service';
import type { SubscribeTemplateKey } from './dto';

/**
 * 一次授权最多累计几条额度。
 *
 * 微信的规则是「点一次同意 = 可推一条」，我们这边按同样的口径记账。
 * 原来封顶 5：业主一天报不了几次修，攒多了旧事件早过去了。
 * 但维修工不一样 —— 一天可能被派十几单，而且勾了「总是保持以上选择」之后
 * 端上会在他每次点开工单时静默补一条；封顶 5 会把后面的派单通知全挡在门外
 * （只剩站内信）。20 条足够覆盖一天的派单量。
 *
 * 提高上限不会造成「以为能推其实推不了」：这里只在用户**真的点了允许**时才 +1，
 * 和微信那边的累计是同一个口径，封得越低反而是我们自己丢额度。
 */
const MAX_GRANT_PER_TEMPLATE = 20;

/**
 * 可推的订阅消息模板。前两个发给业主（业主端小程序），后三个发给维修工（员工端）。
 * key 列表连同校验白名单都定义在 ./dto，这里只转出去给别的模块用。
 */
export type { SubscribeTemplateKey };

/** 站内信 payload 里指向单据的键 → 单据 id（可一组），markReadByRef 用 */
export type NotificationRef = Partial<
  Record<
    | 'workOrderId'
    | 'purchaseRequestId'
    | 'purchaseOrderId'
    | 'transferId'
    | 'maintenanceOrderId'
    | 'feedbackId'
    | 'alertId',
    number | number[]
  >
>;

/** 每个事件走哪个小程序发。模板 id 不能跨小程序用，token 也不能 —— 发错端一律 40037/43104 */
export const TEMPLATE_APP: Record<SubscribeTemplateKey, WxAppType> = {
  orderDispatched: 'owner',
  orderReview: 'owner',
  orderAssigned: 'staff',
  orderOverdue: 'staff',
  orderUrge: 'staff',
};

/**
 * 模板没单独配时退到哪一个。都是发给维修工的员工端模板，措辞糙一点也比不推强。
 * 催修 → 催接单 → 新工单。
 */
const TEMPLATE_FALLBACK: Partial<Record<SubscribeTemplateKey, SubscribeTemplateKey[]>> = {
  orderUrge: ['orderOverdue', 'orderAssigned'],
  orderOverdue: ['orderAssigned'],
};

/**
 * 事件提供的语义字段。具体填到模板的哪个 thing1 / time3，
 * 由 buildTemplateData 按模板在微信后台的真实字段决定 —— 调用方不用关心模板长什么样。
 */
export interface TemplateFields {
  orderNo: string;
  type: string;
  /** 状态，可以是一句话（「已派单给张师傅」），填 thing 类字段 */
  status: string;
  /** 状态词，≤5 个汉字（「已派单」）：phrase 类字段微信只收纯汉字，长句硬截会被拒 */
  statusShort?: string;
  content: string;
  assignee: string;
  address: string;
  /** 报修人（建单时落库的联系人）；模板里有「报修人 / 联系人」那一格时填它 */
  reporter: string;
  /** 发送这条提醒的时刻；模板里写「提醒时间」的格子填它 */
  time: string;
  /** 报修提交的时刻；模板里写「报修时间 / 提交时间」的格子填它 —— 和 time 不是一回事，
   *  催接单那条提醒里两者差着几十分钟 */
  reportedAt: string;
  /** 要求完成截止时间（工单上的 slaDueAt）；模板里写「截止时间 / 完成期限」的格子填它。
   *  没设截止的单退回填当前时刻 —— 微信的 time 类型不收空串，也不收「未设置」这种字 */
  dueAt: string;
}

/**
 * 关键词 → 语义字段。按管理员在公众平台里选的关键词名称匹配，
 * 「工单状态」「报单内容」「提醒时间」这类都能对上；对不上的再按字段类型兜底。
 */
const LABEL_RULES: { test: RegExp; field: keyof TemplateFields }[] = [
  { test: /状态|进度|结果/, field: 'status' },
  { test: /内容|描述|事项|问题|详情|说明/, field: 'content' },
  // 「报修时间」是提交时刻、「截止时间」是要求完成时刻、「提醒/催单时间」是发送时刻，
  // 一张模板里可能三格都有，所以具体的那两条必须排在通用「时间」前面
  { test: /报修时间|报单时间|提交时间|下单时间|受理时间/, field: 'reportedAt' },
  { test: /截止|到期|期限|最迟|要求完成/, field: 'dueAt' },
  { test: /时间|日期/, field: 'time' },
  { test: /编号|单号|工单号|订单号/, field: 'orderNo' },
  { test: /类型|类别|种类/, field: 'type' },
  // 报修人排在维修工前面：「报修人」是报单的那位，不是去修的那位
  { test: /报修人|报单人|联系人|申请人|来电人|业主姓名|住户姓名/, field: 'reporter' },
  { test: /维修工|师傅|人员|负责人|处理人|工程师/, field: 'assignee' },
  { test: /地址|位置|房号|地点/, field: 'address' },
];

/**
 * 按微信对每种参数类别的规则把值「整形」到能被接收的样子。
 *
 * 微信的校验是逐类别的，不只是长度（2026-08-26 发测试就撞上：phrase 字段填了
 * 「新工单待…」—— 5 个字没超长，但 phrase **只收汉字**，那个省略号就让整条 47003）。
 * 规则来自官方「参数类别」表：
 *   thing            20 个以内字符，汉字/数字/字母/符号都行
 *   phrase           5 个以内**纯汉字**
 *   name             10 个以内纯汉字，或 20 个以内纯字母/符号
 *   character_string 32 位以内数字/字母/符号（不能有汉字）
 *   letter           32 位以内纯字母
 *   symbol           5 位以内纯符号
 *   number           32 位以内数字，可带小数
 *   amount           1 个币种符号 + 10 位以内数字，结尾可带「元」
 *   phone_number     17 位以内数字/符号
 *   car_number       8 位以内
 *   time             24 小时制时间，可带年月日：「2026年8月26日 22:17」
 *   date             年月日，可带时间
 * 每种类别都保证给出一个合法的非空值 —— 微信不接受空串，一个字段不合法整条都不发。
 */
export function fitToType(raw: string, type: string): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const chars = (s: string) => Array.from(s);
  const hardCut = (s: string, max: number) => chars(s).slice(0, max).join('');
  // 超长的自由文本截断时留个省略号，让人知道后面还有；只用于允许符号的类别
  const softCut = (s: string, max: number) =>
    chars(s).length > max ? `${chars(s).slice(0, max - 1).join('')}…` : s;
  const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
  const onlyHan = (s: string) => (s.match(HAN) || []).join('');
  const noHan = (s: string) => s.replace(HAN, '').replace(/\s+/g, '');
  const now = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  };

  switch (type) {
    case 'thing':
      return softCut(text, 20) || '—';
    case 'short_thing':
      return hardCut(text, 5) || '—';
    case 'phrase':
      return hardCut(onlyHan(text), 5) || '待处理';
    case 'name': {
      const han = onlyHan(text);
      if (han) return hardCut(han, 10);
      // 没有汉字：只留字母和符号（数字、空格都不行）
      return hardCut(text.replace(/[0-9\s]/g, ''), 20) || '未指定';
    }
    case 'character_string':
      return hardCut(noHan(text), 32) || '-';
    case 'letter':
      return hardCut(text.replace(/[^A-Za-z]/g, ''), 32) || 'NA';
    case 'symbol':
      return hardCut(text.replace(/[\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9\s]/g, ''), 5) || '—';
    case 'number':
      return hardCut(text.replace(/[^\d.]/g, ''), 32) || '0';
    case 'amount': {
      if (/^[¥￥$]?\d+(\.\d+)?元?$/.test(text)) return text;
      const digits = text.replace(/[^\d.]/g, '');
      return `${hardCut(digits, 10) || '0'}元`;
    }
    case 'phone_number':
      return hardCut(text.replace(/[^\d+\-() ]/g, ''), 17) || '-';
    case 'car_number':
      return hardCut(text, 8) || '-';
    case 'time': {
      // 「22:17」或「2026年8月26日 22:17」都合法；别的一律换成当前时刻
      if (/^(\d{4}年\d{1,2}月\d{1,2}日 )?\d{1,2}:\d{2}(~(\d{4}年\d{1,2}月\d{1,2}日 )?\d{1,2}:\d{2})?$/.test(text)) return text;
      const n = now();
      return `${n.date} ${n.time}`;
    }
    case 'date': {
      if (/^\d{4}年\d{1,2}月\d{1,2}日( \d{1,2}:\d{2})?$/.test(text)) return text;
      return now().date;
    }
    default:
      // 没见过的类别按最宽松的 thing 处理，至少不发空串
      return softCut(text, 20) || '—';
  }
}

export interface TemplateMappingRow {
  key: string;
  label: string;
  from: keyof TemplateFields;
  value: string;
}

/**
 * 把语义字段填进模板的真实字段。
 *
 * 顺序：1) 按关键词名称匹配；2) 没匹配上的按类型兜底（time→时间、
 * character_string→编号、phrase→状态、thing→依次挑还没用过的内容/状态/类型/地址/维修工）。
 * 每个字段都保证有值（微信不接受空串），并按类别整形成微信认的样子（fitToType）。
 */
export function buildTemplateData(
  fields: TemplateFields,
  template: WxTemplateField[],
): { data: Record<string, { value: string }>; mapping: TemplateMappingRow[] } {
  const used = new Set<keyof TemplateFields>();
  const data: Record<string, { value: string }> = {};
  const mapping: TemplateMappingRow[] = [];
  const thingFallback: (keyof TemplateFields)[] = [
    'content', 'status', 'type', 'address', 'reporter', 'assignee', 'orderNo',
  ];

  for (const f of template) {
    let from = LABEL_RULES.find((r) => r.test.test(f.label))?.field;
    if (!from) {
      if (f.type === 'time' || f.type === 'date') from = 'time';
      else if (f.type === 'character_string' || f.type === 'letter') from = 'orderNo';
      else if (f.type === 'phrase' || f.type === 'short_thing') from = 'status';
      else if (f.type === 'name') from = 'assignee';
      else from = thingFallback.find((k) => !used.has(k) && fields[k]) ?? 'content';
    }
    used.add(from);
    let value = String(fields[from] ?? '').trim();
    /**
     * 内容那一格只放故障本身。
     *
     * 原来调用方往这里塞的是「类别 · 地址：内容」，而 thing 只收 20 字 ——
     * 「智能化相关 · 枫桦景苑二期/228弄2号…」一截，真正的故障描述一个字都没进去
     * （2026-08-28 那条测试就是这样）。类别和地址各自有自己的关键词，模板里加上就行；
     * 模板里没有、内容又是空的，才退回用它们凑一句，总比空着强。
     */
    if (from === 'content' && !value) {
      value = [fields.type, fields.address].filter(Boolean).join(' · ');
    }
    // 状态词（phrase）只收 5 个以内汉字：优先用事件给的短状态，别把长句硬截成「新工单待…」
    if ((f.type === 'phrase' || f.type === 'short_thing') && from === 'status') {
      value = String(fields.statusShort ?? '').trim() || value;
    }
    if (!value && from === 'time') value = fields.time;
    value = fitToType(value, f.type);
    data[f.key] = { value };
    mapping.push({ key: f.key, label: f.label, from, value });
  }
  return { data, mapping };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
    @InjectRepository(SubscriptionGrant)
    private readonly grantRepo: Repository<SubscriptionGrant>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly settings: SettingsService,
    private readonly serviceAccount: WxServiceAccountService,
    private readonly wechat: WechatService,
  ) {}

  /** 当前用户的站内信列表（最新在前，最多 100 条） */
  list(user: AuthUser, onlyUnread?: boolean) {
    const tenantId = this.requireTenant(user);
    return this.notificationRepo.find({
      where: {
        tenantId,
        receiverId: user.id,
        ...(onlyUnread ? { readAt: IsNull() } : {}),
      },
      order: { id: 'DESC' },
      take: 100,
    });
  }

  async unreadCount(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const count = await this.notificationRepo.count({
      where: { tenantId, receiverId: user.id, readAt: IsNull() },
    });
    return { count };
  }

  async markRead(id: number, user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const item = await this.notificationRepo.findOne({
      where: { id, tenantId, receiverId: user.id },
    });
    if (!item) throw new NotFoundException('notification not found');
    if (!item.readAt) {
      item.readAt = new Date();
      item.status = NotifyStatus.SENT;
      await this.notificationRepo.save(item);
    }
    return { ok: true };
  }

  /**
   * 把某张工单已经失效的待办通知标记掉（撤回后旧的派单/验收/采购待办不该还能点）。
   *
   * 不删记录：通知也是审计线索。只在 payload 上打 invalidated 标记并置为已读，
   * 让它从「待办角标」和可操作入口里消失，历史消息里仍能看到发生过什么。
   */
  async invalidateWorkOrderNotifications(
    tenantId: number,
    workOrderId: number,
    eventKeys: string[],
    reason: string,
  ): Promise<number> {
    return this.invalidateNotificationsByRef(tenantId, { workOrderId }, eventKeys, reason);
  }

  /**
   * 同上，但按任意单据 id 找：采购申请的「待经理审批」通知 payload 里只有 purchaseRequestId，
   * 工单撤回把申请整单驳回后，要按申请 id 才能把它们标掉（2026-09-06）。
   */
  async invalidateNotificationsByRef(
    tenantId: number,
    ref: NotificationRef,
    eventKeys: string[],
    reason: string,
  ): Promise<number> {
    if (!eventKeys.length) return 0;
    const wanted = Object.entries(ref).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value])
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0)
        .map((id) => [key, id] as const),
    );
    if (!wanted.length) return 0;
    const rows = await this.notificationRepo.find({
      where: { tenantId, eventKey: In(eventKeys), readAt: IsNull() },
      order: { id: 'DESC' },
      take: 500,
    });
    const targets = rows.filter((row) =>
      wanted.some(([key, id]) => Number((row.payload ?? {})[key]) === id),
    );
    if (!targets.length) return 0;
    for (const row of targets) {
      row.payload = { ...(row.payload ?? {}), invalidated: true, invalidReason: reason };
      row.readAt = new Date();
      await this.notificationRepo.save(row);
    }
    return targets.length;
  }

  async markAllRead(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    await this.notificationRepo.update(
      { tenantId, receiverId: user.id, readAt: IsNull() },
      { readAt: new Date() },
    );
    return { ok: true };
  }

  /**
   * 用户在别处已经看过 / 处理过这件事：把他名下指向同一张单据的未读站内信一并标已读。
   *
   * 2026-09-06 Mike：新工单提醒出了角标，但他已经在工单池点开过那张单，消息里还是未读 ——
   * 「说明我已经知道这条消息了，就不该还显示未读，其他同理」。
   * 调用点：工单详情（GET /work-orders/:id）、采购申请的查看 / 合并 / 提交 / 审批 / 驳回 / 改明细、
   * 采购单入库、调拨审批 / 收货、养护单详情。只标本人的、只标未读的；记录不删，历史消息里还能看到。
   * 失败不影响主流程（调用方 void 掉），所以这里不抛。
   */
  async markReadByRef(user: AuthUser, ref: NotificationRef): Promise<number> {
    const entries = Object.entries(ref).flatMap(([key, value]) => {
      const ids = (Array.isArray(value) ? value : [value])
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0);
      return ids.map((id) => [key, id] as const);
    });
    if (!entries.length || !user?.id) return 0;
    let tenantId: number;
    try {
      tenantId = this.requireTenant(user);
    } catch {
      return 0;
    }
    // payload 是 jsonb，按文本比对：{"workOrderId":19} 里的 19 存的是数字，->> 取出来是 '19'
    const params: unknown[] = [tenantId, user.id];
    const clauses = entries.map(([key, id]) => {
      params.push(String(id));
      return `payload->>'${key}' = $${params.length}`;
    });
    try {
      const result: unknown = await this.notificationRepo.query(
        `UPDATE notifications
            SET read_at = now(), status = '${NotifyStatus.SENT}'
          WHERE tenant_id = $1 AND receiver_id = $2 AND read_at IS NULL
            AND (${clauses.join(' OR ')})`,
        params,
      );
      // pg 驱动返回 [rows, affected]
      return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    } catch (error) {
      this.logger.warn(`markReadByRef failed: ${(error as Error).message}`);
      return 0;
    }
  }

  // ---------------- 微信订阅消息 ----------------

  /**
   * 业主在小程序里点了「允许」之后调这里记额度。
   *
   * 微信不提供「查询用户还剩几条额度」的接口，只能自己记：同意一次 +1，推一次 -1。
   * 因此这里只认前端上报，前端必须在 wx.requestSubscribeMessage 回调里
   * **只把结果为 accept 的模板** 传上来，不能把弹窗里所有模板都报一遍。
   */
  async grantSubscribe(user: AuthUser, templateIds: string[]) {
    const tenantId = this.requireTenant(user);
    const ids = Array.from(
      new Set(templateIds.map((id) => String(id || '').trim()).filter(Boolean)),
    ).slice(0, 10);
    if (!ids.length) return { ok: true, granted: 0 };

    const existing = await this.grantRepo.find({
      where: { tenantId, userId: user.id, templateId: In(ids) },
    });
    const byTemplate = new Map(existing.map((row) => [row.templateId, row]));

    const rows = ids.map((templateId) => {
      const hit = byTemplate.get(templateId);
      if (hit) {
        hit.remaining = Math.min(hit.remaining + 1, MAX_GRANT_PER_TEMPLATE);
        hit.updatedBy = user.id;
        return hit;
      }
      return this.grantRepo.create({
        tenantId,
        userId: user.id,
        templateId,
        remaining: 1,
        createdBy: user.id,
        updatedBy: user.id,
      });
    });
    await this.grantRepo.save(rows);
    return { ok: true, granted: ids.length };
  }

  /**
   * 给某个人发一条通知：站内信一定写，微信订阅消息尽力而为。
   *
   * 收件人不限于业主 —— 「有新工单派给你」是发给维修工的（员工端小程序），
   * 走的是同一套：同一张 notifications 表、同一套订阅额度。方法名原来叫
   * notifyOwner，第二个收件人一进来就名不副实了，所以改成 notifyUser。
   *
   * 顺序是先写库再推微信 —— 推送失败对方至少还能在消息列表里看到；
   * 反过来先推后写，推成功但入库失败就成了「收到提醒却查不到记录」。
   *
   * 整个方法不抛异常：通知是旁路，绝不能把派单、完工这些主流程带崩
   * （这也是全局约定里那条「通知失败只记日志，不阻塞主业务」）。
   */
  async notifyUser(input: {
    tenantId: number;
    receiverId: number;
    eventKey: string;
    title: string;
    payload?: Record<string, unknown>;
    /** 小程序落地页，点通知直接跳过去 */
    page?: string;
    /** 订阅消息模板选哪一个 */
    template?: SubscribeTemplateKey;
    /** 事件的语义字段；填到模板哪个位置由 buildTemplateData 按模板真实字段决定 */
    templateFields?: TemplateFields;
  }): Promise<void> {
    try {
      const saved = await this.notificationRepo.save(
        this.notificationRepo.create({
          tenantId: input.tenantId,
          receiverId: input.receiverId,
          channel: NotifyChannel.IN_APP,
          eventKey: input.eventKey,
          title: input.title,
          payload: { ...(input.payload ?? {}), page: input.page },
          status: NotifyStatus.SENT,
          readAt: null,
          createdBy: null,
          updatedBy: null,
        }),
      );

      if (!input.template || !input.templateFields) return;

      // 优先走服务号：只要人关注着就能一直推，不吃订阅额度，落在聊天列表里更显眼。
      // 推成功就到此为止 —— 两条都发的话，维修工同一件事会收到两遍。
      // 只有发给员工的事件走这条路：业主是散户，不会去关注物业的服务号。
      if (TEMPLATE_APP[input.template] === 'staff') {
        const viaMp = await this.trySendServiceAccount({
          tenantId: input.tenantId,
          receiverId: input.receiverId,
          fields: input.templateFields,
          page: input.page,
          notificationId: saved.id,
        });
        if (viaMp) return;
      }

      await this.trySendSubscribe({
        tenantId: input.tenantId,
        receiverId: input.receiverId,
        template: input.template,
        fields: input.templateFields,
        page: input.page,
        notificationId: saved.id,
      });
    } catch (err) {
      this.logger.error(`通知写入失败（${input.eventKey}）：${(err as Error).message}`);
    }
  }

  /**
   * 走服务号模板消息。发出去了返回 true，调用方就不再走订阅消息。
   *
   * 没配置、没开启、这个人没关注 —— 都安静地返回 false 退回订阅消息那条路，
   * 不算异常：服务号是加分项，不是前提。
   */
  private async trySendServiceAccount(input: {
    tenantId: number;
    receiverId: number;
    fields: TemplateFields;
    page?: string;
    notificationId: number;
  }): Promise<boolean> {
    if (!(await this.serviceAccount.isReady(input.tenantId))) return false;

    const receiver = await this.userRepo.findOne({
      where: { id: input.receiverId },
      select: ['id', 'wxMpOpenid'],
    });
    if (!receiver?.wxMpOpenid) return false;

    const res = await this.serviceAccount.sendTemplate({
      tenantId: input.tenantId,
      openid: receiver.wxMpOpenid,
      // 公众号模板的字段名由管理员选的行业模板决定，最常见的是 first/keyword1..n/remark。
      // 这里按这套通用命名发；对不上时微信回 41028，后台「发送测试」会把原话显示出来
      data: {
        first: { value: `${input.fields.status}` },
        keyword1: { value: input.fields.orderNo },
        keyword2: { value: input.fields.type },
        keyword3: { value: input.fields.address },
        keyword4: { value: input.fields.time },
        remark: { value: input.fields.content || '点开查看详情并接单' },
      },
      // 挂上小程序跳转：点消息直接落到那张工单，不用自己回小程序里翻。
      // 服务号消息只负责「叫人」，找单永远在小程序里
      miniprogramAppId: this.staffMiniAppId(),
      miniprogramPage: input.page,
    });

    if (!res.ok) {
      if (res.errcode || res.errmsg) {
        this.logger.warn(
          `服务号推送失败（用户 ${input.receiverId}）：${res.errmsg || res.errcode}`,
        );
      }
      return false;
    }
    await this.notificationRepo.update(
      { id: input.notificationId },
      { channel: NotifyChannel.WX_SERVICE, status: NotifyStatus.SENT },
    );
    return true;
  }

  /** 服务号消息里跳小程序要带员工端 appid；没配就只发纯文字消息 */
  private staffMiniAppId(): string | undefined {
    return process.env.WX_STAFF_APPID || undefined;
  }

  private async trySendSubscribe(input: {
    tenantId: number;
    receiverId: number;
    template: SubscribeTemplateKey;
    fields: TemplateFields;
    page?: string;
    notificationId: number;
  }) {
    const settings = await this.settings.getSettingsByTenant(input.tenantId);
    // 催办模板没单独配就退回用「新工单」那个模板：宁可措辞糙一点，也别不推
    const templateId =
      settings.wxSubscribeTemplates[input.template] ||
      (TEMPLATE_FALLBACK[input.template] ?? [])
        .map((key) => settings.wxSubscribeTemplates[key])
        .find(Boolean) ||
      '';
    // 物业还没在公众平台申请模板：只走站内信，不算异常
    if (!templateId) return;
    const appType = TEMPLATE_APP[input.template];

    const receiver = await this.userRepo.findOne({
      where: { id: input.receiverId },
      select: ['id', 'wxOpenid'],
    });
    if (!receiver?.wxOpenid) return;

    const grant = await this.grantRepo.findOne({
      where: { tenantId: input.tenantId, userId: input.receiverId, templateId },
    });
    // 没授权或额度用完：标成 fallback，后台能看出「这条没推出去，只落了站内信」
    if (!grant || grant.remaining <= 0) {
      await this.notificationRepo.update(
        { id: input.notificationId },
        { status: NotifyStatus.FALLBACK },
      );
      return;
    }

    // 模板真实字段拉不到（网络、模板被删）：不扣额度，标 fallback
    let templateFields: WxTemplateField[];
    try {
      templateFields = await this.wechat.getTemplateFields(templateId, appType);
    } catch (err) {
      this.logger.error(`拉取订阅模板字段失败（${templateId}）：${(err as Error).message}`);
      await this.notificationRepo.update(
        { id: input.notificationId },
        { status: NotifyStatus.FALLBACK },
      );
      return;
    }

    // 先扣额度再发：发送失败重试会重复扣，但「少发一条」远好过「同一条推两次」
    grant.remaining -= 1;
    await this.grantRepo.save(grant);

    const { data } = buildTemplateData(input.fields, templateFields);
    // 员工端的模板必须用员工端的 token 发 —— 这里原来没传 appType，
    // 「新工单派给维修工」一直在拿业主端的 token 发，从来没成功过
    const ok = await this.wechat.sendSubscribeMessage(
      { openid: receiver.wxOpenid, templateId, page: input.page, data },
      appType,
    );
    await this.notificationRepo.update(
      { id: input.notificationId },
      { channel: ok ? NotifyChannel.WX_SUBSCRIBE : NotifyChannel.IN_APP,
        status: ok ? NotifyStatus.SENT : NotifyStatus.FAILED },
    );
  }

  /** 校验/测试用的样例字段：让管理员一眼看出每个关键词会被填成什么 */
  private sampleFields(template: SubscribeTemplateKey): TemplateFields {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const base = {
      orderNo: 'WO20260826-0001',
      type: '水相关',
      content: '厨房水管漏水',
      assignee: '张师傅',
      address: '枫桦景苑 17号 201室',
      reporter: '王女士',
      time,
      reportedAt: time,
      dueAt: time,
    };
    if (template === 'orderReview') return { ...base, status: '已修好，待验收', statusShort: '待验收' };
    if (template === 'orderAssigned') {
      return { ...base, status: '新工单待接单', statusShort: '待接单', assignee: '' };
    }
    if (template === 'orderOverdue') {
      return { ...base, status: '派单 60 分钟还没接单', statusShort: '待接单', assignee: '' };
    }
    if (template === 'orderUrge') {
      return { ...base, status: '办公室催修', statusShort: '维修中' };
    }
    return { ...base, status: '已派单给张师傅', statusShort: '已派单' };
  }

  /**
   * 校验某个模板：从微信拉真实字段，回显「每个关键词会被填成什么」。
   * 拉不到就把微信的原话带回去（最常见：模板申请在了另一个小程序里）。
   */
  async checkTemplate(user: AuthUser, template: SubscribeTemplateKey, templateId?: string) {
    const tenantId = this.requireTenant(user);
    const settings = await this.settings.getSettingsByTenant(tenantId);
    const id = (templateId ?? settings.wxSubscribeTemplates[template] ?? '').trim();
    if (!id) return { ok: false, error: '这一项还没填模板 ID' };
    const appType = TEMPLATE_APP[template];
    try {
      const fields = await this.wechat.getTemplateFields(id, appType);
      const { mapping } = buildTemplateData(this.sampleFields(template), fields);
      return { ok: true, appType, fields: mapping };
    } catch (err) {
      return { ok: false, appType, error: (err as Error).message };
    }
  }

  /**
   * 给自己发一条测试：走和真实事件完全一样的链路（额度、字段映射、端的 token），
   * 把微信返回的原话带回来。收件人是当前登录的这个人 —— 他得先在对应小程序里
   * 登录过（有 openid）并点过一次「允许」（有额度），否则直接把这两条要求说清楚。
   */
  async sendTest(user: AuthUser, template: SubscribeTemplateKey) {
    const tenantId = this.requireTenant(user);
    const settings = await this.settings.getSettingsByTenant(tenantId);
    const templateId = (settings.wxSubscribeTemplates[template] ?? '').trim();
    if (!templateId) return { ok: false, error: '这一项还没填模板 ID，先保存再测' };

    const appType = TEMPLATE_APP[template];
    const appName = appType === 'owner' ? '业主端（邻修管家）' : '员工端（邻修管理）';

    const me = await this.userRepo.findOne({
      where: { id: user.id },
      select: ['id', 'wxOpenid'],
    });
    if (!me?.wxOpenid) {
      return {
        ok: false,
        error:
          `你这个账号没在${appName}小程序里登录过，没有 openid，微信无处可推。` +
          `用手机登录一次${appName}再来测。`,
      };
    }
    const grant = await this.grantRepo.findOne({
      where: { tenantId, userId: user.id, templateId },
    });
    if (!grant || grant.remaining <= 0) {
      return {
        ok: false,
        error:
          `你还没对这个模板点过「允许」（或额度用完了）。在${appName}小程序里` +
          `${appType === 'owner' ? '提交一次报修' : '打开「我的」页点「新工单提醒」'}，同意后再来测。`,
      };
    }

    let fields: WxTemplateField[];
    try {
      fields = await this.wechat.getTemplateFields(templateId, appType);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const { data, mapping } = buildTemplateData(this.sampleFields(template), fields);
    grant.remaining -= 1;
    await this.grantRepo.save(grant);
    const result = await this.wechat.sendSubscribeMessageDetailed(
      { openid: me.wxOpenid, templateId, page: 'pages/me/me', data },
      appType,
    );
    return result.ok
      ? { ok: true, fields: mapping, remaining: grant.remaining }
      : { ok: false, error: result.errmsg, errcode: result.errcode, fields: mapping };
  }

  // ---------------- 服务号：后台的两个动作 ----------------

  /**
   * 同步关注者：拉服务号粉丝，按 unionid 认领到员工账号上。
   *
   * 为什么要手动点而不是自动跑：新关注是低频动作（一个维修工一辈子关注一次），
   * 定时全量拉反而是白白消耗微信接口配额。管理员加完人点一下就行。
   *
   * 返回值要能回答管理员心里的三个问题：拉到几个粉丝、其中几个有 unionid、
   * 最终认领上了几个员工。任何一环是 0，页面上直接指出是哪一步没做。
   */
  async syncServiceAccountFollowers(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    if (!(await this.serviceAccount.isReady(tenantId))) {
      return {
        ok: false,
        message: '服务号还没配好（AppID / AppSecret / 模板 ID / 开关），先保存再同步',
      };
    }

    const res = await this.serviceAccount.fetchFollowers(tenantId);
    if (res.error) return { ok: false, message: res.error, followers: res.total };

    if (!res.total) {
      return { ok: false, followers: 0, message: '服务号一个关注者都没有，先让维修工关注它' };
    }
    if (!res.withUnionId) {
      return {
        ok: false,
        followers: res.total,
        message:
          `拉到 ${res.total} 个关注者，但一个都没有 unionid —— ` +
          '说明服务号和员工端小程序还没绑到同一个「微信开放平台」账号下。' +
          '绑定后维修工重新登录一次小程序，再来同步。',
      };
    }

    // 只认领本租户里有 unionid 的员工。unionid 是登录小程序时存下的，
    // 没登录过小程序的人对不上 —— 那也正确：他本来就收不到我们的消息
    const staff = await this.userRepo.find({
      where: { tenantId, wxUnionid: Not(IsNull()) },
      select: ['id', 'wxUnionid', 'wxMpOpenid'],
    });
    let matched = 0;
    let cleared = 0;
    for (const person of staff) {
      const openid = person.wxUnionid ? res.unionToOpenid.get(person.wxUnionid) : undefined;
      if (openid) {
        if (person.wxMpOpenid !== openid) {
          await this.userRepo.update({ id: person.id }, { wxMpOpenid: openid });
        }
        matched += 1;
      } else if (person.wxMpOpenid) {
        // 之前关注过、现在取关了：清掉，否则会一直往一个收不到的 openid 推
        await this.userRepo.update({ id: person.id }, { wxMpOpenid: null });
        cleared += 1;
      }
    }

    return {
      ok: matched > 0,
      followers: res.total,
      withUnionId: res.withUnionId,
      matched,
      cleared,
      message: matched
        ? `已认领 ${matched} 个员工${cleared ? `，另有 ${cleared} 个已取关，已停止推送` : ''}`
        : `${res.total} 个关注者里没有一个对得上本公司的员工账号 —— ` +
          '确认维修工用的是同一个微信号：既关注了服务号，也登录过员工端小程序。',
    };
  }

  /** 给当前操作人发一条服务号测试消息，微信的真实错误原样返回 */
  async sendServiceAccountTest(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const me = await this.userRepo.findOne({
      where: { id: user.id },
      select: ['id', 'name', 'wxMpOpenid'],
    });
    if (!me?.wxMpOpenid) {
      return {
        ok: false,
        message:
          '你自己还没和服务号对上：请先用微信关注这个服务号，再点上面的「同步关注者」，然后回来重试。',
      };
    }
    const res = await this.serviceAccount.sendTemplateDetailed({
      tenantId,
      openid: me.wxMpOpenid,
      data: {
        first: { value: '这是一条测试消息' },
        keyword1: { value: 'TEST-0001' },
        keyword2: { value: '水暖问题' },
        keyword3: { value: '测试地址 1 号楼 101' },
        keyword4: { value: this.now() },
        remark: { value: '收到这条就说明服务号通道已经打通，正式派单会用同一条路发出。' },
      },
    });
    if (res.skipped) return { ok: false, message: res.skipped };
    if (!res.ok) return { ok: false, message: res.errmsg || '发送失败' };
    return { ok: true, message: '已发出，去微信里看看这个服务号的会话' };
  }

  private now(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 每个模板还剩几条额度（没记录 = 0）。「我的」页用它区分「还能提醒几条」和「一直提醒」 */
  async subscribeState(user: AuthUser, templateIds: string[]): Promise<Record<string, number>> {
    const tenantId = this.requireTenant(user);
    const out: Record<string, number> = {};
    templateIds.forEach((id) => { out[id] = 0; });
    if (!templateIds.length) return out;
    const rows = await this.grantRepo.find({
      where: { tenantId, userId: user.id, templateId: In(templateIds) },
    });
    rows.forEach((row) => { out[row.templateId] = Math.max(0, row.remaining); });
    return out;
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }
}
