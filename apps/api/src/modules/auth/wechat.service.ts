import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type WxAppType = 'owner' | 'staff';

export interface WxSession {
  openid: string;
  unionid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
}

interface WxTokenResp {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface WxPhoneResp {
  errcode?: number;
  errmsg?: string;
  phone_info?: {
    phoneNumber: string;
    purePhoneNumber: string;
    countryCode: string;
  };
}

/** 小程序码版本：正式版 / 体验版 / 开发版 */
export type WxEnvVersion = 'release' | 'trial' | 'develop';

/** 订阅消息模板里的一个占位字段：`工单状态:{{thing1.DATA}}` → { key:'thing1', type:'thing', label:'工单状态' } */
export interface WxTemplateField {
  key: string;
  /** thing / character_string / time / phrase / number / name / … —— 决定长度限制和格式 */
  type: string;
  label: string;
}

export interface WxSubscribeSendResult {
  ok: boolean;
  errcode?: number;
  errmsg?: string;
}

export interface WxaCodeOptions {
  /** 最长 32 个可见字符，允许 数字/英文/!#$&'()*+,/:;=?@-._~ */
  scene: string;
  /** 落地页路径，不带参数、不带前导斜杠，如 pages/repair-create/repair-create */
  page: string;
  /** 二维码边长（px），280–1280 */
  width?: number;
  envVersion?: WxEnvVersion;
  /** true = 透明底，印刷时更好排版 */
  isHyaline?: boolean;
  /**
   * 是否让微信校验 page 存在。默认跟着 envVersion 走：
   * release 才校验，trial/develop 一律不校验。
   *
   * 微信的规则是「check_path 为 true 时，page 必须是**已发布正式版**里存在的页面」——
   * 小程序还没发布时，哪怕开发版里明明有这个页面，也照样回 41030。
   * 硬编码成 true 会让未发布的小程序完全出不了码。
   */
  checkPath?: boolean;
}

const API_BASE = 'https://api.weixin.qq.com';

interface WxTemplateListResp {
  errcode?: number;
  errmsg?: string;
  data?: { priTmplId: string; title: string; content: string; type: number }[];
}

/**
 * 模板 content 长这样（一行一个字段）：
 *   工单状态:{{thing1.DATA}}
 *   报单内容:{{thing2.DATA}}
 *   提醒时间:{{time3.DATA}}
 * 拆成 [{ key, type, label }]，顺序保持微信后台的顺序。
 */
export function parseTemplateContent(content: string): WxTemplateField[] {
  const fields: WxTemplateField[] = [];
  const re = /([^\n{}]*?)[:：]?\s*\{\{([a-zA-Z_]+?)(\d*)\.DATA\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content || '')) !== null) {
    fields.push({ key: `${m[2]}${m[3]}`, type: m[2], label: m[1].trim() });
  }
  return fields;
}

/** 把微信的错误码翻成管理员看得懂的话；原始 errmsg 一并带着 */
function explainSubscribeError(resp: { errcode?: number; errmsg?: string }): string {
  const raw = resp.errmsg || '';
  switch (resp.errcode) {
    case 43101:
      return `对方没有授权或授权额度已用完（43101）。让他在小程序里再点一次「允许」；勾了「总是保持以上选择」之后不用再点。${raw}`;
    case 47003:
      return `模板字段对不上（47003）：某个字段的内容不符合微信对该类型的限制（thing≤20字、character_string≤32字、time 要是日期时间）。${raw}`;
    case 40037:
      return `模板 ID 不存在（40037）：确认它是在**这个**小程序里申请的，模板不能跨小程序用。${raw}`;
    case 41028:
    case 41029:
      return `落地页路径不合法（${resp.errcode}）：page 要是已发布版本里存在的页面。${raw}`;
    case 43104:
      return `模板与小程序不匹配（43104）：这条模板不属于当前 appid。${raw}`;
    default:
      return raw || `errcode ${resp.errcode}`;
  }
}

/** 微信 errcode → 人话（原始 errmsg 仍会拼在后面，不做吞错） */
const WXACODE_ERROR_HINTS: Record<number, string> = {
  40001: 'access_token 无效，检查 WX_OWNER_APPID / WX_OWNER_SECRET 是否填对',
  41030:
    '落地页在该版本的小程序里不存在。正式版（release）要求小程序已发布上线；' +
    '还没提审发布时，把对应的 *_QR_ENV_VERSION 改成 trial（体验版）或 develop（开发版）—— ' +
    '非 release 会自动关掉 check_path，未发布的小程序才出得了码',
  45009: '调用超出微信频率限制，稍后再试（getUnlimited 默认 10 万次/天）',
  40097: '参数错误：scene 超长或含非法字符，page 不能带参数、不能有前导斜杠',
  40169: 'scene 为空或不合法',
  85079: '小程序未发布，正式版小程序码无法生成',
};

/**
 * 微信开放接口封装（两套小程序凭据按 appType 区分）。
 * - jscode2session：wx.login 的 code 换 openid
 * - getPhoneNumber：wx.getPhoneNumber 的 code 换手机号
 * access_token 走进程内缓存（单实例部署），过期或 40001 时自动重取。
 */
@Injectable()
export class WechatService {
  private readonly logger = new Logger(WechatService.name);
  private readonly tokenCache = new Map<WxAppType, { token: string; expiresAt: number }>();
  private readonly templateCache = new Map<string, { fields: WxTemplateField[]; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {}

  /** 该端小程序凭据是否已配置 */
  isConfigured(appType: WxAppType): boolean {
    const { appid, secret } = this.rawCredentials(appType);
    return !!appid && !!secret;
  }

  async jscode2session(code: string, appType: WxAppType): Promise<WxSession> {
    const { appid, secret } = this.credentials(appType);
    const data = await this.get<WxSession>('/sns/jscode2session', {
      appid,
      secret,
      js_code: code,
      grant_type: 'authorization_code',
    });
    if (data.errcode || !data.openid) {
      throw new UnauthorizedException(
        `微信登录失败：${data.errmsg || data.errcode || '未返回 openid'}`,
      );
    }
    return data;
  }

  /** wx.getPhoneNumber 的 code 换纯手机号（不含区号） */
  async getPhoneNumber(code: string, appType: WxAppType): Promise<string> {
    let token = await this.accessToken(appType);
    let data = await this.postPhone(token, code);
    // 40001/42001：token 失效，清缓存重试一次
    if (data.errcode === 40001 || data.errcode === 42001) {
      this.tokenCache.delete(appType);
      token = await this.accessToken(appType);
      data = await this.postPhone(token, code);
    }
    const phone = data.phone_info?.purePhoneNumber;
    if (data.errcode || !phone) {
      throw new UnauthorizedException(
        `获取微信手机号失败：${data.errmsg || data.errcode || '未返回手机号'}`,
      );
    }
    return phone;
  }

  /**
   * 生成永久有效的小程序码（wxacode.getUnlimited）。
   * 微信成功时直接返回图片二进制，失败时返回 JSON —— 这里按 content-type 判别，
   * 失败会把微信原始 errcode/errmsg 一起抛出来，后台要能看到真实原因。
   */
  async getUnlimitedWxaCode(
    options: WxaCodeOptions,
    appType: WxAppType = 'owner',
  ): Promise<Buffer> {
    const body = {
      scene: options.scene,
      page: options.page,
      width: options.width ?? 430,
      env_version: options.envVersion ?? 'release',
      is_hyaline: options.isHyaline ?? false,
      auto_color: false,
      check_path: options.checkPath ?? (options.envVersion ?? 'release') === 'release',
    };

    let token = await this.accessToken(appType);
    let resp = await this.postWxaCode(token, body);
    // 40001/42001：token 失效，清缓存重试一次
    const firstError = this.parseWxaCodeError(resp);
    if (firstError?.errcode === 40001 || firstError?.errcode === 42001) {
      this.tokenCache.delete(appType);
      token = await this.accessToken(appType);
      resp = await this.postWxaCode(token, body);
    }

    const error = this.parseWxaCodeError(resp);
    if (error) {
      const hint = WXACODE_ERROR_HINTS[error.errcode ?? -1];
      const raw = `errcode ${error.errcode ?? '-'}: ${error.errmsg || '未知错误'}`;
      throw new ServiceUnavailableException(
        hint ? `生成小程序码失败（${raw}）——${hint}` : `生成小程序码失败（${raw}）`,
      );
    }
    return Buffer.from(resp.data);
  }

  private async postWxaCode(
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<{ data: ArrayBuffer; contentType: string }> {
    const url = `${API_BASE}/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`;
    try {
      const resp = await axios.post<ArrayBuffer>(url, body, {
        responseType: 'arraybuffer',
        timeout: 15000,
      });
      return {
        data: resp.data,
        contentType: String(resp.headers['content-type'] || ''),
      };
    } catch (err) {
      this.logger.error(`微信接口 getwxacodeunlimit 请求失败: ${(err as Error).message}`);
      throw new ServiceUnavailableException('微信服务暂时不可用，请稍后重试');
    }
  }

  /** 微信出错时返回的是 JSON 而不是图片，按 content-type + 内容双重判别 */
  private parseWxaCodeError(resp: {
    data: ArrayBuffer;
    contentType: string;
  }): { errcode?: number; errmsg?: string } | null {
    const looksJson =
      resp.contentType.includes('application/json') ||
      resp.contentType.includes('text/plain') ||
      resp.data.byteLength < 512;
    if (!looksJson) return null;
    const text = Buffer.from(resp.data).toString('utf8').trim();
    if (!text.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(text) as { errcode?: number; errmsg?: string };
      if (parsed.errcode === 0) return null;
      return parsed;
    } catch {
      return { errmsg: text.slice(0, 200) };
    }
  }

  /**
   * 发送订阅消息（subscribeMessage.send）。
   *
   * 订阅消息是「一次授权一条额度」：用户在小程序里点一次同意，微信只允许推一条，
   * 推完额度就没了。所以调用方必须先扣 subscription_grants 的余量再调这里，
   * 不能反过来 —— 否则失败重试会把额度多扣一次。
   *
   * 失败一律**不抛异常**：通知发不出去是次要的，绝不能因此把业务流程（派单、完工）
   * 一起挂掉。返回 false 让调用方降级成站内信。
   */
  async sendSubscribeMessage(
    input: {
      openid: string;
      templateId: string;
      /** 落地页，如 pages/order-detail/order-detail?id=12 */
      page?: string;
      /** 模板字段，形如 { thing1: { value: '水管漏水' } } */
      data: Record<string, { value: string }>;
    },
    appType: WxAppType = 'owner',
  ): Promise<boolean> {
    return (await this.sendSubscribeMessageDetailed(input, appType)).ok;
  }

  /**
   * 同上，但把微信返回的 errcode / errmsg 原样带回来 ——
   * 后台「发一条测试」要把真实原因给管理员看，一句「失败」谁也排查不了。
   */
  async sendSubscribeMessageDetailed(
    input: {
      openid: string;
      templateId: string;
      page?: string;
      data: Record<string, { value: string }>;
    },
    appType: WxAppType = 'owner',
  ): Promise<WxSubscribeSendResult> {
    if (!this.isConfigured(appType)) {
      return {
        ok: false,
        errmsg: `${appType === 'owner' ? '业主端' : '员工端'}小程序的 appid/secret 没配，服务器环境变量里补上`,
      };
    }
    const body = {
      touser: input.openid,
      template_id: input.templateId,
      page: input.page,
      data: input.data,
      miniprogram_state: this.config.get<string>('WX_SUBSCRIBE_STATE', 'formal'),
      lang: 'zh_CN',
    };

    try {
      let token = await this.accessToken(appType);
      let resp = await this.postSubscribe(token, body);
      if (resp.errcode === 40001 || resp.errcode === 42001) {
        this.tokenCache.delete(appType);
        token = await this.accessToken(appType);
        resp = await this.postSubscribe(token, body);
      }
      if (resp.errcode) {
        // 43101 = 用户拒收 / 额度已用完，属于正常情况，用 warn 不用 error
        const level = resp.errcode === 43101 ? 'warn' : 'error';
        this.logger[level](
          `订阅消息发送失败 errcode ${resp.errcode}: ${resp.errmsg || ''}` +
            `（template ${input.templateId}）`,
        );
        return { ok: false, errcode: resp.errcode, errmsg: explainSubscribeError(resp) };
      }
      return { ok: true };
    } catch (err) {
      this.logger.error(`订阅消息发送异常: ${(err as Error).message}`);
      return { ok: false, errmsg: (err as Error).message };
    }
  }

  /**
   * 拉某个模板在微信后台的真实字段（wxaapi/newtmpl/gettemplate）。
   *
   * 为什么要拉：字段 key（thing1 / time3…）是微信按模板生成的，每个模板都不一样。
   * 写死在代码里就得反过来要求管理员「按代码的顺序去申请模板」，申请错一个
   * 整条消息被拒收（47003），而且后台看不到任何提示。拉回来按关键词语义填，
   * 管理员随便选什么模板都能用。
   *
   * 结果按 (appType, templateId) 缓存一小时：模板改动极少，每条通知都拉一次纯属浪费。
   * 拉不到（网络、模板不存在）抛错，交给调用方决定降级还是回显。
   */
  async getTemplateFields(templateId: string, appType: WxAppType): Promise<WxTemplateField[]> {
    const cacheKey = `${appType}:${templateId}`;
    const cached = this.templateCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.fields;

    let token = await this.accessToken(appType);
    let resp = await this.get<WxTemplateListResp>('/wxaapi/newtmpl/gettemplate', {
      access_token: token,
    });
    if (resp.errcode === 40001 || resp.errcode === 42001) {
      this.tokenCache.delete(appType);
      token = await this.accessToken(appType);
      resp = await this.get<WxTemplateListResp>('/wxaapi/newtmpl/gettemplate', {
        access_token: token,
      });
    }
    if (resp.errcode) {
      throw new ServiceUnavailableException(
        `微信拉取模板列表失败 ${resp.errcode}：${resp.errmsg || ''}`,
      );
    }
    const hit = (resp.data ?? []).find((t) => t.priTmplId === templateId);
    if (!hit) {
      throw new ServiceUnavailableException(
        `${appType === 'owner' ? '业主端' : '员工端'}小程序里没有这个模板 ID —— ` +
          '模板不能跨小程序用，确认它是在哪个小程序的公众平台里申请的',
      );
    }
    const fields = parseTemplateContent(hit.content);
    this.templateCache.set(cacheKey, { fields, expiresAt: Date.now() + 60 * 60 * 1000 });
    return fields;
  }

  private postSubscribe(
    accessToken: string,
    body: Record<string, unknown>,
  ): Promise<{ errcode?: number; errmsg?: string }> {
    return this.post(
      `/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`,
      body,
    );
  }

  private postPhone(accessToken: string, code: string): Promise<WxPhoneResp> {
    return this.post<WxPhoneResp>(
      `/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`,
      { code },
    );
  }

  private async accessToken(appType: WxAppType): Promise<string> {
    const cached = this.tokenCache.get(appType);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const { appid, secret } = this.credentials(appType);
    const data = await this.get<WxTokenResp>('/cgi-bin/token', {
      grant_type: 'client_credential',
      appid,
      secret,
    });
    if (data.errcode || !data.access_token) {
      throw new ServiceUnavailableException(
        `获取微信 access_token 失败：${data.errmsg || data.errcode || '未返回 token'}`,
      );
    }
    // 微信默认 7200s，提前 5 分钟过期
    const ttlMs = Math.max((data.expires_in ?? 7200) - 300, 60) * 1000;
    this.tokenCache.set(appType, {
      token: data.access_token,
      expiresAt: Date.now() + ttlMs,
    });
    return data.access_token;
  }

  private credentials(appType: WxAppType): { appid: string; secret: string } {
    const { appid, secret } = this.rawCredentials(appType);
    if (!appid || !secret) {
      throw new ServiceUnavailableException(
        `${appType === 'owner' ? '业主端' : '员工端'}小程序凭据未配置，请联系管理员`,
      );
    }
    return { appid, secret };
  }

  private rawCredentials(appType: WxAppType) {
    return {
      appid: this.config.get<string>(
        appType === 'owner' ? 'WX_OWNER_APPID' : 'WX_STAFF_APPID',
        '',
      ),
      secret: this.config.get<string>(
        appType === 'owner' ? 'WX_OWNER_SECRET' : 'WX_STAFF_SECRET',
        '',
      ),
    };
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    try {
      const { data } = await axios.get<T>(`${API_BASE}${path}`, { params, timeout: 8000 });
      return data;
    } catch (err) {
      this.logger.error(`微信接口 ${path} 请求失败: ${(err as Error).message}`);
      throw new ServiceUnavailableException('微信服务暂时不可用，请稍后重试');
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    try {
      const { data } = await axios.post<T>(`${API_BASE}${path}`, body, { timeout: 8000 });
      return data;
    } catch (err) {
      this.logger.error(`微信接口 ${path} 请求失败: ${(err as Error).message}`);
      throw new ServiceUnavailableException('微信服务暂时不可用，请稍后重试');
    }
  }
}
