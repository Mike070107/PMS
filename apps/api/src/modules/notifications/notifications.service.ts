import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { NotifyChannel, NotifyStatus } from '../../common/enums';
import { Notification, SubscriptionGrant, User } from '../../entities';
import { SettingsService } from '../settings/settings.service';
import { WechatService, type WxAppType, type WxTemplateField } from '../auth/wechat.service';

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

/** 可推的订阅消息模板。前两个发给业主（业主端小程序），最后一个发给维修工（员工端） */
export type SubscribeTemplateKey = 'orderDispatched' | 'orderReview' | 'orderAssigned';

/** 每个事件走哪个小程序发。模板 id 不能跨小程序用，token 也不能 —— 发错端一律 40037/43104 */
export const TEMPLATE_APP: Record<SubscribeTemplateKey, WxAppType> = {
  orderDispatched: 'owner',
  orderReview: 'owner',
  orderAssigned: 'staff',
};

/**
 * 事件提供的语义字段。具体填到模板的哪个 thing1 / time3，
 * 由 buildTemplateData 按模板在微信后台的真实字段决定 —— 调用方不用关心模板长什么样。
 */
export interface TemplateFields {
  orderNo: string;
  type: string;
  status: string;
  content: string;
  assignee: string;
  address: string;
  time: string;
}

/**
 * 关键词 → 语义字段。按管理员在公众平台里选的关键词名称匹配，
 * 「工单状态」「报单内容」「提醒时间」这类都能对上；对不上的再按字段类型兜底。
 */
const LABEL_RULES: { test: RegExp; field: keyof TemplateFields }[] = [
  { test: /状态|进度|结果/, field: 'status' },
  { test: /内容|描述|事项|问题|详情|说明/, field: 'content' },
  { test: /时间|日期/, field: 'time' },
  { test: /编号|单号|工单号|订单号/, field: 'orderNo' },
  { test: /类型|类别|种类/, field: 'type' },
  { test: /维修工|师傅|人员|负责人|处理人|工程师/, field: 'assignee' },
  { test: /地址|位置|房号|地点/, field: 'address' },
];

/** 微信对各字段类型的限制：超长直接拒收（47003），所以按类型截断 */
const TYPE_LIMIT: Record<string, number> = {
  thing: 20,
  character_string: 32,
  phrase: 5,
  name: 10,
  short_thing: 5,
  letter: 32,
  symbol: 5,
};

function clip(value: string, max = 20): string {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
 * 每个字段都保证有值（微信不接受空串），并按类型截断。
 */
export function buildTemplateData(
  fields: TemplateFields,
  template: WxTemplateField[],
): { data: Record<string, { value: string }>; mapping: TemplateMappingRow[] } {
  const used = new Set<keyof TemplateFields>();
  const data: Record<string, { value: string }> = {};
  const mapping: TemplateMappingRow[] = [];
  const thingFallback: (keyof TemplateFields)[] = [
    'content', 'status', 'type', 'address', 'assignee', 'orderNo',
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
    if (!value) value = from === 'time' ? fields.time : '—';
    if (f.type === 'number') value = value.replace(/\D/g, '') || '0';
    const limit = TYPE_LIMIT[f.type];
    if (limit) value = clip(value, limit);
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

  async markAllRead(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    await this.notificationRepo.update(
      { tenantId, receiverId: user.id, readAt: IsNull() },
      { readAt: new Date() },
    );
    return { ok: true };
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

  private async trySendSubscribe(input: {
    tenantId: number;
    receiverId: number;
    template: SubscribeTemplateKey;
    fields: TemplateFields;
    page?: string;
    notificationId: number;
  }) {
    const settings = await this.settings.getSettingsByTenant(input.tenantId);
    const templateId = settings.wxSubscribeTemplates[input.template];
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
      content: '水相关：厨房水管漏水',
      assignee: '张师傅',
      address: '枫桦景苑 17号 201室',
      time,
    };
    if (template === 'orderReview') return { ...base, status: '已修好，待验收' };
    if (template === 'orderAssigned') {
      return {
        ...base,
        status: '新工单待处理',
        content: '水相关 · 枫桦景苑 17号 201室：厨房水管漏水',
        assignee: '',
      };
    }
    return { ...base, status: '已派单给张师傅' };
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

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }
}
