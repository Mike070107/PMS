import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'node:crypto';

export type DeliyunParkingStatus = {
  configured: boolean;
  connected: boolean;
  readEnabled: boolean;
  writeEnabled: false;
  message: string;
  checkedAt: string | null;
};

type DeliyunResponse = { ecode?: number | string; msg?: string; data?: unknown };

/** 德立云只读适配器。Secret 仅来自进程环境变量，绝不写数据库、日志或返回前端。 */
@Injectable()
export class DeliyunParkingService {
  private cached: { expiresAt: number; value: DeliyunParkingStatus } | null = null;

  constructor(private readonly config: ConfigService) {}

  async status(force = false): Promise<DeliyunParkingStatus> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    const accessKeyId = this.value('DELIYUN_ACCESS_KEY_ID');
    const accessKeySecret = this.value('DELIYUN_ACCESS_KEY_SECRET');
    const version = this.value('DELIYUN_API_VERSION');
    const commKey = this.value('DELIYUN_COMM_KEY');
    let value: DeliyunParkingStatus;

    if (!accessKeyId || !accessKeySecret) {
      value = this.result(false, false, '尚未配置德立云 AccessKey');
    } else if (!version || !commKey) {
      const missing = [!version ? '停车 API 版本号' : '', !commKey ? '停车场 commKey' : ''].filter(Boolean).join('、');
      value = this.result(true, false, `AccessKey 已保存，还缺少${missing}`);
    } else {
      value = await this.probe(accessKeyId, accessKeySecret, version, commKey);
    }
    this.cached = { expiresAt: Date.now() + 30_000, value };
    return value;
  }

  private async probe(accessKeyId: string, secret: string, version: string, commKey: string) {
    const unsigned = { accessKeyID: accessKeyId, commKey, data: '{}', timestamp: String(Date.now()), version };
    const body = new URLSearchParams({ ...unsigned, sign: legacyDeliyunSign(unsigned, secret) });
    const baseUrl = this.value('DELIYUN_API_BASE_URL') || 'https://openapi.deliyun.cn';
    try {
      const response = await axios.post<DeliyunResponse>(`${baseUrl.replace(/\/$/, '')}/parking/findPunitInfo`, body, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        timeout: 8_000,
        validateStatus: () => true,
      });
      const payload = response.data;
      if (response.status >= 200 && response.status < 300 && String(payload?.ecode ?? '0') === '0') {
        return this.result(true, true, '德立云人防车库只读查询已连接');
      }
      return this.result(true, false, deliyunErrorMessage(response.status, payload));
    } catch (error) {
      return this.result(true, false, axios.isAxiosError(error) && error.code === 'ECONNABORTED'
        ? '德立云连接超时，请检查服务器网络或接口白名单'
        : '德立云接口无法访问，请检查服务器网络或接口地址');
    }
  }

  private value(name: string) { return this.config.get<string>(name, '').trim(); }

  private result(configured: boolean, connected: boolean, message: string): DeliyunParkingStatus {
    return { configured, connected, readEnabled: connected, writeEnabled: false, message, checkedAt: configured ? new Date().toISOString() : null };
  }
}

export function legacyDeliyunSign(params: Record<string, string>, secret: string) {
  const canonical = Object.entries(params)
    .filter(([, value]) => value !== '')
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return createHash('md5').update(`${canonical}&accessKeySecret=${secret}`, 'utf8').digest('hex');
}

function deliyunErrorMessage(status: number, payload: DeliyunResponse | undefined) {
  const code = payload?.ecode === undefined ? '' : `（代码 ${String(payload.ecode)}）`;
  const detail = typeof payload?.msg === 'string' && payload.msg.trim() ? payload.msg.trim() : `HTTP ${status}`;
  if (detail.includes('版本号')) return `停车 API 版本号不正确${code}，请从德立云“接口授权”详情复制当前版本号`;
  if (/commKey|项目|车场/i.test(detail)) return `停车场 commKey 不正确或无权限${code}`;
  if (/sign|签名|AccessKey|密钥/i.test(detail)) return `AccessKey 签名未通过${code}，请核对接口授权与当前签名规则`;
  return `德立云连接验证失败${code}：${detail}`;
}
