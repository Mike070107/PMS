import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { SettingsService } from '../settings/settings.service';

/**
 * 微信服务号（公众号）模板消息。
 *
 * 和小程序订阅消息的关键差别，也是我们要接它的理由：
 *   订阅消息 = 用户同意一次才能推一条，额度用完就哑火，落在「服务通知」文件夹里；
 *   模板消息 = 只要人还关注着就能一直推，落在聊天列表的独立会话里，
 *              手机提醒和收到微信消息一样。派单这种「必须叫到人」的场景只能靠它。
 *
 * 凭据按租户存在 tenant_configs 里（每家物业自己的服务号），
 * **不走环境变量** —— 换一家客户不该重新部署一次。
 *
 * 这里所有方法都不抛异常给业务层：通知是旁路，服务号挂了也不能把派单带崩。
 * 只有「后台点测试」那条路要看到真实错误，所以单独给了 sendTemplateDetailed。
 */

const API_BASE = 'https://api.weixin.qq.com';

interface WxTokenResp {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface WxCommonResp {
  errcode?: number;
  errmsg?: string;
}

interface WxUserListResp extends WxCommonResp {
  total?: number;
  count?: number;
  data?: { openid: string[] };
  next_openid?: string;
}

interface WxUserInfoBatchResp extends WxCommonResp {
  user_info_list?: Array<{
    openid: string;
    unionid?: string;
    nickname?: string;
    subscribe?: number;
  }>;
}

export interface WxTemplateSendResult {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
  /** 没配置 / 没开启 / 收件人没关注 —— 不是错误，只是这条路走不通 */
  skipped?: string;
}

/** 模板消息的一个字段 */
export type WxTemplateData = Record<string, { value: string; color?: string }>;

@Injectable()
export class WxServiceAccountService {
  private readonly logger = new Logger(WxServiceAccountService.name);

  /** access_token 按租户缓存。微信给 7200s，这里提前 5 分钟过期 */
  private readonly tokenCache = new Map<number, { token: string; expiresAt: number }>();

  constructor(private readonly settings: SettingsService) {}

  /** 这家物业有没有把服务号配全（appId + secret + 模板 + 开关） */
  async isReady(tenantId: number): Promise<boolean> {
    const conf = await this.settings.getServiceAccountRaw(tenantId);
    return !!(conf.enabled && conf.appId && conf.appSecret && conf.templateOrderAssigned);
  }

  /**
   * 发一条模板消息。
   *
   * miniprogramPage 传了就把消息挂上小程序跳转 —— 这一条很重要：
   * 维修工点开消息直接落到那张工单，不用自己回小程序里翻。
   * 服务号消息本身只是「叫人」，找单永远在小程序里。
   */
  async sendTemplate(input: {
    tenantId: number;
    openid: string;
    data: WxTemplateData;
    miniprogramAppId?: string;
    miniprogramPage?: string;
  }): Promise<WxTemplateSendResult> {
    try {
      return await this.sendTemplateDetailed(input);
    } catch (err) {
      this.logger.warn(`服务号模板消息发送异常：${(err as Error).message}`);
      return { ok: false, errmsg: (err as Error).message };
    }
  }

  /** 后台「发送测试」用：错误原样返回，让人看得到微信到底说了什么 */
  async sendTemplateDetailed(input: {
    tenantId: number;
    openid: string;
    data: WxTemplateData;
    templateId?: string;
    miniprogramAppId?: string;
    miniprogramPage?: string;
  }): Promise<WxTemplateSendResult> {
    const conf = await this.settings.getServiceAccountRaw(input.tenantId);
    if (!conf.enabled) return { ok: false, skipped: '服务号通知没有开启' };
    if (!conf.appId || !conf.appSecret) return { ok: false, skipped: '服务号 AppID / AppSecret 没填' };
    const templateId = input.templateId || conf.templateOrderAssigned;
    if (!templateId) return { ok: false, skipped: '没填模板 ID' };
    if (!input.openid) return { ok: false, skipped: '这个人还没关注服务号' };

    const send = async (token: string) =>
      this.post<WxCommonResp>('/cgi-bin/message/template/send', token, {
        touser: input.openid,
        template_id: templateId,
        ...(input.miniprogramAppId && input.miniprogramPage
          ? { miniprogram: { appid: input.miniprogramAppId, pagepath: input.miniprogramPage } }
          : {}),
        data: input.data,
      });

    let token = await this.accessToken(input.tenantId);
    let res = await send(token);
    // 40001/42001：token 失效或过期。清缓存重取一次再发，不要让用户看到一条
    // 「invalid credential」就以为配错了
    if (res.errcode === 40001 || res.errcode === 42001) {
      this.tokenCache.delete(input.tenantId);
      token = await this.accessToken(input.tenantId);
      res = await send(token);
    }
    if (res.errcode && res.errcode !== 0) {
      return { ok: false, errcode: res.errcode, errmsg: this.explain(res) };
    }
    return { ok: true };
  }

  /**
   * 拉服务号的全部关注者，返回 openid → unionid。
   *
   * 为什么要 unionid：小程序和服务号里同一个人的 openid 是**不一样**的，
   * 只有把两者绑到同一个微信开放平台账号，才会有一个共同的 unionid。
   * 我们靠它把「小程序里的这个维修工」和「服务号的这个粉丝」对上。
   * 没绑开放平台的话这里拿到的 unionid 全是空的，同步会一个都匹配不上 ——
   * 所以返回值里带上 withUnionId 计数，后台能直接告诉管理员是哪一步没做。
   */
  async fetchFollowers(tenantId: number): Promise<{
    total: number;
    withUnionId: number;
    unionToOpenid: Map<string, string>;
    error?: string;
  }> {
    const unionToOpenid = new Map<string, string>();
    let total = 0;
    let withUnionId = 0;
    try {
      const token = await this.accessToken(tenantId);
      let nextOpenid = '';
      // 微信一页最多 10000 个；拉满 5 页封顶，物业的维修工不会有五万人
      for (let page = 0; page < 5; page += 1) {
        const list = await this.get<WxUserListResp>('/cgi-bin/user/get', token, {
          ...(nextOpenid ? { next_openid: nextOpenid } : {}),
        });
        if (list.errcode) return { total, withUnionId, unionToOpenid, error: this.explain(list) };
        const openids = list.data?.openid ?? [];
        if (!openids.length) break;
        total += openids.length;

        // batchget 一次最多 100 个
        for (let i = 0; i < openids.length; i += 100) {
          const chunk = openids.slice(i, i + 100);
          const info = await this.post<WxUserInfoBatchResp>(
            '/cgi-bin/user/info/batchget',
            token,
            { user_list: chunk.map((openid) => ({ openid, lang: 'zh_CN' })) },
          );
          if (info.errcode) {
            return { total, withUnionId, unionToOpenid, error: this.explain(info) };
          }
          for (const item of info.user_info_list ?? []) {
            if (item.unionid) {
              withUnionId += 1;
              unionToOpenid.set(item.unionid, item.openid);
            }
          }
        }

        nextOpenid = list.next_openid || '';
        if (!nextOpenid || openids.length < 10000) break;
      }
      return { total, withUnionId, unionToOpenid };
    } catch (err) {
      return { total, withUnionId, unionToOpenid, error: (err as Error).message };
    }
  }

  /** 配置改了就把 token 缓存丢掉，否则换了 secret 还在用旧 token */
  invalidate(tenantId: number) {
    this.tokenCache.delete(tenantId);
  }

  private async accessToken(tenantId: number): Promise<string> {
    const cached = this.tokenCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const conf = await this.settings.getServiceAccountRaw(tenantId);
    const { data } = await axios.get<WxTokenResp>(`${API_BASE}/cgi-bin/token`, {
      params: { grant_type: 'client_credential', appid: conf.appId, secret: conf.appSecret },
      timeout: 8000,
    });
    if (data.errcode || !data.access_token) {
      throw new Error(this.explain(data));
    }
    const ttlMs = Math.max((data.expires_in ?? 7200) - 300, 60) * 1000;
    this.tokenCache.set(tenantId, {
      token: data.access_token,
      expiresAt: Date.now() + ttlMs,
    });
    return data.access_token;
  }

  /**
   * 把微信的错误码翻成人话。
   * 直接把 "errcode 40013" 摆到管理员面前，他只能去搜；这里对最常撞上的几个给出下一步动作。
   */
  private explain(res: WxCommonResp): string {
    const raw = `${res.errcode ?? ''} ${res.errmsg ?? ''}`.trim();
    const tips: Record<number, string> = {
      40001: 'AppSecret 不对（invalid credential）。到服务号后台「基本配置」里核对，注意别填成小程序的 secret',
      40013: 'AppID 不对（invalid appid）。要填服务号的 AppID，不是小程序的',
      40003: '收件人 openid 无效，通常是这个人取消关注了',
      40037: '模板 ID 不对，到服务号后台「模板消息」里重新复制一次',
      41028: '模板字段填得不对：模板里要求的 keyword 和我们发的对不上',
      43004: '这个人没有关注服务号，先让他关注',
      45009: '接口调用超过当日上限',
      48001: '服务号没有模板消息权限：未认证的订阅号发不了，必须是已认证的服务号',
      61023: 'access_token 失效，稍后自动重试',
    };
    const tip = res.errcode ? tips[res.errcode] : '';
    return tip ? `${tip}（微信返回 ${raw}）` : `微信返回 ${raw || '未知错误'}`;
  }

  private async get<T>(path: string, token: string, params: Record<string, string>): Promise<T> {
    const { data } = await axios.get<T>(`${API_BASE}${path}`, {
      params: { access_token: token, ...params },
      timeout: 8000,
    });
    return data;
  }

  private async post<T>(path: string, token: string, body: unknown): Promise<T> {
    const { data } = await axios.post<T>(
      `${API_BASE}${path}?access_token=${encodeURIComponent(token)}`,
      body,
      { timeout: 8000 },
    );
    return data;
  }
}
