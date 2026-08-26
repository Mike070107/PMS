import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { NotifyChannel, NotifyStatus } from '../../common/enums';
import { Notification, SubscriptionGrant, User } from '../../entities';
import { SettingsService } from '../settings/settings.service';
import { WechatService } from '../auth/wechat.service';

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
type SubscribeTemplateKey = 'orderDispatched' | 'orderReview' | 'orderAssigned';

/** 订阅消息模板字段有长度限制，超了微信直接报错，这里统一截断 */
function clip(value: string, max = 20): string {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
    /** 模板字段，按微信后台配的顺序 thing1/thing2/time3... */
    templateData?: Record<string, string>;
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

      if (!input.template || !input.templateData) return;
      await this.trySendSubscribe({
        tenantId: input.tenantId,
        receiverId: input.receiverId,
        template: input.template,
        data: input.templateData,
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
    data: Record<string, string>;
    page?: string;
    notificationId: number;
  }) {
    const settings = await this.settings.getSettingsByTenant(input.tenantId);
    const templateId = settings.wxSubscribeTemplates[input.template];
    // 物业还没在公众平台申请模板：只走站内信，不算异常
    if (!templateId) return;

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

    // 先扣额度再发：发送失败重试会重复扣，但「少发一条」远好过「同一条推两次」
    grant.remaining -= 1;
    await this.grantRepo.save(grant);

    const ok = await this.wechat.sendSubscribeMessage({
      openid: receiver.wxOpenid,
      templateId,
      page: input.page,
      data: Object.fromEntries(
        Object.entries(input.data).map(([key, value]) => [key, { value: clip(value) }]),
      ),
    });
    await this.notificationRepo.update(
      { id: input.notificationId },
      { channel: ok ? NotifyChannel.WX_SUBSCRIBE : NotifyChannel.IN_APP,
        status: ok ? NotifyStatus.SENT : NotifyStatus.FAILED },
    );
  }

  private requireTenant(user: AuthUser): number {
    if (!user.tenantId) throw new ForbiddenException('tenant scope is required');
    return user.tenantId;
  }
}
