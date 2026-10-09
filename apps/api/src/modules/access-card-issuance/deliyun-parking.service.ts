import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const MINIAPP_API = 'https://apis-pmas.deliyun.cn/apis/app/pmas';
const PARKING_H5_API = 'https://wpma.deliyun.cn/apis/park';
const MINIAPP_VERSION = '3.0';

export type DeliyunParkingStatus = {
  configured: boolean;
  connected: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  message: string;
  checkedAt: string | null;
};

export type DeliyunVehicle = {
  id: string;
  plate: string;
  cardNo: string | null;
  carType: string | null;
  cardType: string | null;
  beginDate: string | null;
  endDate: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  address: string | null;
  cardPoolId: string | null;
  cardPoolName: string | null;
  poolPeriods: Array<{ name: string | null; beginDate: string | null; endDate: string | null }>;
};

type DeliyunResponse<T = unknown> = { ecode?: number | string; msg?: string; data?: T };
type DeliyunPark = { unitKey?: string; unitName?: string; deviceNum?: number; deviceOnlineNum?: number };
type MiniappSession = {
  token: string;
  expiresAt: number;
  park: Required<Pick<DeliyunPark, 'unitKey' | 'unitName'>> & DeliyunPark;
};

export type DeliyunRenewalResult = {
  vehicleId: string;
  plate: string;
  previousEndDate: string;
  endDate: string;
  verified: true;
};

/** 德立云只读适配器。密码、协议密钥和会话仅来自进程内存，不写数据库、日志或前端。 */
@Injectable()
export class DeliyunParkingService {
  private cached: { expiresAt: number; value: DeliyunParkingStatus } | null = null;
  private session: MiniappSession | null = null;

  constructor(private readonly config: ConfigService) {}

  async status(force = false): Promise<DeliyunParkingStatus> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    let value: DeliyunParkingStatus;
    if (this.hasMiniappAccount()) {
      const missing = this.missingMiniappProtocolConfig();
      value = missing.length
        ? this.result(true, false, `专用账号已配置，还缺少${missing.join('、')}`)
        : await this.probeMiniapp();
    } else {
      value = await this.legacyAccessKeyStatus();
    }
    this.cached = { expiresAt: Date.now() + 30_000, value };
    return value;
  }

  async findVehiclesByPlate(plate: string): Promise<{ project: string; rows: DeliyunVehicle[] }> {
    const normalized = normalizePlate(plate);
    if (!isFullPlate(normalized)) throw new BadRequestException('请输入完整车牌后再查询德立云');
    if (!this.hasMiniappAccount() || this.missingMiniappProtocolConfig().length) {
      throw new ServiceUnavailableException('德立云专用账号连接尚未配置完整');
    }
    try {
      const session = await this.ensureMiniappSession();
      const response = await this.h5Get<Array<Record<string, unknown>>>('/pma/card/findParkCards', {
        unitKey: session.park.unitKey,
        pageNum: '1',
        pageSize: '50',
        plateNum: normalized,
      }, session.token);
      this.assertSuccess(response, '德立云车辆查询失败');
      const rows = Array.isArray(response.data) ? response.data : [];
      const matched = rows.map(mapDeliyunVehicle).filter((row) => normalizePlate(row.plate) === normalized);
      const enriched = await Promise.all(matched.map((row) => this.enrichPoolPeriods(row, session)));
      return {
        project: session.park.unitName,
        rows: enriched,
      };
    } catch (error) {
      this.invalidateSessionOnAuthFailure(error);
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('德立云车辆查询暂时不可用，请稍后重试');
    }
  }

  async renewVehicle(input: { vehicleId: string; plate: string; previousEndDate: string; endDate: string }): Promise<DeliyunRenewalResult> {
    if (!this.writeEnabled()) throw new ServiceUnavailableException('德立云有效期写入尚未启用');
    const vehicleId = input.vehicleId.trim();
    const plate = normalizePlate(input.plate);
    if (!vehicleId || !isFullPlate(plate) || !isDateOnly(input.previousEndDate) || !isDateOnly(input.endDate))
      throw new BadRequestException('德立云续期参数不完整');
    if (input.endDate <= input.previousEndDate) throw new BadRequestException('续期后的有效期必须晚于当前到期日');
    const session = await this.ensureMiniappSession();
    const detailResponse = await this.h5Post<Record<string, unknown>>('/pma/card/findCard', {
      unitKey: session.park.unitKey, id: vehicleId,
    }, session.token);
    this.assertSuccess(detailResponse, '德立云车辆详情读取失败');
    const detail = detailResponse.data ?? {};
    if (stringValue(detail.id) !== vehicleId || normalizePlate(stringValue(detail.plateNum)) !== plate)
      throw new BadRequestException('德立云车辆已变化，请刷新后重新操作');
    const currentEndDate = dateOnlyFromValue(detail.endDate) || dateOnlyFromEpoch(detail.endTime);
    if (currentEndDate !== input.previousEndDate)
      throw new BadRequestException(`德立云当前到期日已变为 ${currentEndDate || '未记录'}，请刷新后重新操作`);
    if (stringValue(detail.cardPoolId) || numberValue(detail.cardTypeId) === 7)
      throw new BadRequestException('车位池车辆的有效期属于关联车位，暂不允许从车辆续期入口修改');

    const payload = buildDeliyunRenewalPayload(detail, session.park.unitKey, vehicleId, input.endDate);
    const updateResponse = await this.h5Post('/pma/card/updateCard', payload, session.token);
    this.assertSuccess(updateResponse, '德立云有效期更新失败');

    // 写接口成功只说明上游接受；必须重新读取同一车辆确认最终日期。
    const refreshed = await this.findVehiclesByPlate(plate);
    const verified = refreshed.rows.find((row) => row.id === vehicleId);
    if (!verified || verified.endDate !== input.endDate)
      throw new ServiceUnavailableException('德立云已接受更新，但回读到期日不一致；请刷新核对，暂勿重复提交');
    return { vehicleId, plate, previousEndDate: input.previousEndDate, endDate: input.endDate, verified: true };
  }

  private async enrichPoolPeriods(row: DeliyunVehicle, session: MiniappSession): Promise<DeliyunVehicle> {
    if (row.beginDate || row.endDate || !row.cardPoolId) return row;
    const response = await this.h5Get<Array<Record<string, unknown>>>('/pma/card/findCardPoolParks', {
      unitKey: session.park.unitKey,
      cardPoolId: row.cardPoolId,
    }, session.token);
    this.assertSuccess(response, '德立云车位池有效期读取失败');
    const periods = (Array.isArray(response.data) ? response.data : []).map((item) => ({
      name: nullableString(item.parkName ?? item.spaceName ?? item.name ?? item.parkNo),
      beginDate: nullableString(item.beginDate),
      endDate: nullableString(item.endDate),
    }));
    return { ...row, beginDate: periods[0]?.beginDate ?? null, endDate: periods[0]?.endDate ?? null, poolPeriods: periods };
  }

  private async probeMiniapp(): Promise<DeliyunParkingStatus> {
    try {
      const session = await this.ensureMiniappSession();
      const counts = await this.appPost<Record<string, unknown>>('/punit/findParkCount', { unitKey: session.park.unitKey }, session.token);
      this.assertSuccess(counts, '德立云项目统计读取失败');
      const sample = await this.h5Get<Array<Record<string, unknown>>>('/pma/card/findParkCards', {
        unitKey: session.park.unitKey,
        pageNum: '1',
        pageSize: '1',
      }, session.token);
      this.assertSuccess(sample, '德立云车辆读取失败');
      const data = counts.data ?? {};
      const cardsNum = numberValue(data.cardsNum);
      const deviceNum = numberValue(data.deviceNum ?? session.park.deviceNum);
      const onlineNum = numberValue(data.deviceOnlineNum ?? session.park.deviceOnlineNum);
      const countsText = [cardsNum === null ? '' : `登记 ${cardsNum} 辆`, deviceNum === null ? '' : `设备 ${onlineNum ?? 0}/${deviceNum} 在线`]
        .filter(Boolean).join('，');
      const capability = this.writeEnabled() ? '车辆查询和有效期续期已连接' : '车辆只读查询已连接';
      return this.result(true, true, `德立云${session.park.unitName}${capability}${countsText ? `（${countsText}）` : ''}`);
    } catch (error) {
      this.invalidateSessionOnAuthFailure(error);
      return this.result(true, false, miniappErrorMessage(error));
    }
  }

  private async ensureMiniappSession(): Promise<MiniappSession> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session;
    const login = await this.appPost<Record<string, unknown>>('/user/login', {
      username: this.value('DELIYUN_MINIAPP_USERNAME'),
      password: this.value('DELIYUN_MINIAPP_PASSWORD'),
      vcode: '',
      vcodeid: randomRequestId(),
    }, '');
    this.assertSuccess(login, '德立云账号登录失败');
    const token = stringValue(login.data?.token);
    if (!token) throw new Error('DELIYUN_LOGIN_NO_TOKEN');
    const projectName = this.value('DELIYUN_PROJECT_NAME') || '枫桦景苑';
    const parks = await this.appPost<DeliyunPark[]>('/punit/parkList', { pageNum: 1, name: projectName }, token);
    this.assertSuccess(parks, '德立云项目列表读取失败');
    const park = Array.isArray(parks.data) ? parks.data.find((item) => item.unitName === projectName) : undefined;
    const unitKey = stringValue(park?.unitKey);
    const unitName = stringValue(park?.unitName);
    if (!park || !unitKey || !unitName) throw new Error('DELIYUN_PROJECT_NOT_FOUND');
    this.session = { token, expiresAt: Date.now() + 10 * 60_000, park: { ...park, unitKey, unitName } };
    return this.session;
  }

  private async appPost<T>(path: '/user/login' | '/punit/parkList' | '/punit/findParkCount', payload: Record<string, unknown>, token: string) {
    const data = encryptMiniappData(payload, this.value('DELIYUN_MINIAPP_AES_KEY'), this.value('DELIYUN_MINIAPP_AES_IV'));
    const times = String(Math.floor(Date.now() / 1000));
    const reqid = randomRequestId();
    const sign = miniappSign({ ver: MINIAPP_VERSION, times, reqid, token, data }, this.value('DELIYUN_MINIAPP_SIGN_SECRET'));
    const response = await axios.post<DeliyunResponse<T>>(`${MINIAPP_API}${path}`, new URLSearchParams({ data }), {
      headers: { 'content-type': 'application/x-www-form-urlencoded', ver: MINIAPP_VERSION, times, reqid, token, sign },
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`DELIYUN_HTTP_${response.status}`);
    return response.data;
  }

  private async h5Get<T>(path: '/pma/card/findParkCards' | '/pma/card/findCardPoolParks', params: Record<string, string>, token: string) {
    const response = await axios.get<DeliyunResponse<T>>(`${PARKING_H5_API}${path}`, {
      params,
      headers: { Cookie: `pmatoken=${token}` },
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`DELIYUN_HTTP_${response.status}`);
    return response.data;
  }

  private async h5Post<T = unknown>(path: '/pma/card/findCard' | '/pma/card/updateCard', payload: Record<string, unknown>, token: string) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload))
      if (value !== undefined && value !== null) body.set(key, String(value));
    const response = await axios.post<DeliyunResponse<T>>(`${PARKING_H5_API}${path}`, body, {
      headers: { Cookie: `pmatoken=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`DELIYUN_HTTP_${response.status}`);
    return response.data;
  }

  private assertSuccess(response: DeliyunResponse, prefix: string): void {
    if (String(response?.ecode) === '0') return;
    const code = response?.ecode === undefined ? '' : `_${String(response.ecode)}`;
    const auth = ['2', '3'].includes(String(response?.ecode));
    throw new Error(`${auth ? 'DELIYUN_AUTH' : 'DELIYUN_API'}${code}:${prefix}`);
  }

  private invalidateSessionOnAuthFailure(error: unknown) {
    if (error instanceof Error && error.message.startsWith('DELIYUN_AUTH')) this.session = null;
  }

  private hasMiniappAccount() {
    return !!(this.value('DELIYUN_MINIAPP_USERNAME') && this.value('DELIYUN_MINIAPP_PASSWORD'));
  }

  private missingMiniappProtocolConfig() {
    return [
      this.validAesValue('DELIYUN_MINIAPP_AES_KEY') ? '' : '小程序 AES Key',
      this.validAesValue('DELIYUN_MINIAPP_AES_IV') ? '' : '小程序 AES IV',
      this.value('DELIYUN_MINIAPP_SIGN_SECRET') ? '' : '小程序签名密钥',
    ].filter(Boolean);
  }

  private validAesValue(name: string) { return Buffer.byteLength(this.value(name), 'utf8') === 16; }

  private async legacyAccessKeyStatus(): Promise<DeliyunParkingStatus> {
    const accessKeyId = this.value('DELIYUN_ACCESS_KEY_ID');
    const accessKeySecret = this.value('DELIYUN_ACCESS_KEY_SECRET');
    const version = this.value('DELIYUN_API_VERSION');
    const commKey = this.value('DELIYUN_COMM_KEY');
    if (!accessKeyId || !accessKeySecret) return this.result(false, false, '尚未配置德立云专用账号');
    if (!version || !commKey) {
      const missing = [!version ? '停车 API 版本号' : '', !commKey ? '停车场 commKey' : ''].filter(Boolean).join('、');
      return this.result(true, false, `AccessKey 已保存，还缺少${missing}`);
    }
    return this.probeLegacyAccessKey(accessKeyId, accessKeySecret, version, commKey);
  }

  private async probeLegacyAccessKey(accessKeyId: string, secret: string, version: string, commKey: string) {
    const unsigned = { accessKeyID: accessKeyId, commKey, data: '{}', timestamp: String(Date.now()), version };
    const body = new URLSearchParams({ ...unsigned, sign: legacyDeliyunSign(unsigned, secret) });
    const baseUrl = this.value('DELIYUN_API_BASE_URL') || 'https://openapi.deliyun.cn';
    try {
      const response = await axios.post<DeliyunResponse>(`${baseUrl.replace(/\/$/, '')}/parking/findPunitInfo`, body, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 8_000, validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300 && String(response.data?.ecode ?? '0') === '0') {
        return this.result(true, true, '德立云人防车库只读查询已连接');
      }
      return this.result(true, false, deliyunErrorMessage(response.status, response.data));
    } catch (error) {
      return this.result(true, false, axios.isAxiosError(error) && error.code === 'ECONNABORTED'
        ? '德立云连接超时，请检查服务器网络或接口白名单'
        : '德立云接口无法访问，请检查服务器网络或接口地址');
    }
  }

  private value(name: string) { return this.config.get<string>(name, '').trim(); }

  private writeEnabled() { return this.value('DELIYUN_WRITE_ENABLED').toLowerCase() === 'true'; }

  private result(configured: boolean, connected: boolean, message: string): DeliyunParkingStatus {
    return { configured, connected, readEnabled: connected, writeEnabled: connected && this.writeEnabled(), message, checkedAt: configured ? new Date().toISOString() : null };
  }
}

export function buildDeliyunRenewalPayload(detail: Record<string, unknown>, unitKey: string, vehicleId: string, endDate: string) {
  if (!isDateOnly(endDate)) throw new Error('DELIYUN_INVALID_END_DATE');
  return {
    unitKey,
    id: vehicleId,
    plateNum: detail.plateNum,
    cardNo: detail.cardNo,
    pgIds: detail.pgIds,
    cardTypeId: detail.cardTypeId,
    carTypeId: detail.carTypeId,
    peopleId: detail.peopleId,
    cprtId: detail.cprtId,
    poolId: detail.poolId,
    money: detail.money,
    beginTime: detail.beginTime,
    endTime: endOfDayEpoch(endDate),
    remark: detail.remark,
  };
}

export function endOfDayEpoch(date: string) {
  if (!isDateOnly(date)) throw new Error('DELIYUN_INVALID_DATE');
  return Math.floor(new Date(`${date}T23:59:59+08:00`).getTime() / 1000);
}

export function encryptMiniappData(payload: Record<string, unknown>, key: string, iv: string) {
  if (Buffer.byteLength(key, 'utf8') !== 16 || Buffer.byteLength(iv, 'utf8') !== 16) throw new Error('DELIYUN_CRYPTO_CONFIG');
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
}

export function miniappSign(params: { ver: string; times: string; reqid: string; token: string; data: string }, secret: string) {
  const canonical = `ver=${params.ver}&times=${params.times}&reqid=${params.reqid}&token=${params.token}&data=${params.data}&secret=${secret}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function mapDeliyunVehicle(value: Record<string, unknown>): DeliyunVehicle {
  return {
    id: stringValue(value.id), plate: stringValue(value.plateNum), cardNo: nullableString(value.cardNo),
    carType: nullableString(value.carType), cardType: nullableString(value.cardType),
    beginDate: nullableString(value.beginDate), endDate: nullableString(value.endDate),
    ownerName: nullableString(value.pname), ownerPhone: nullableString(value.pmobile), address: nullableString(value.addr),
    cardPoolId: nullableString(value.cardPoolId), cardPoolName: nullableString(value.cardPoolName),
    poolPeriods: [],
  };
}

export function legacyDeliyunSign(params: Record<string, string>, secret: string) {
  const canonical = Object.entries(params).filter(([, value]) => value !== '').sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, value]) => `${key}=${value}`).join('&');
  return createHash('md5').update(`${canonical}&accessKeySecret=${secret}`, 'utf8').digest('hex');
}

function randomRequestId() { return randomBytes(24).toString('base64url').slice(0, 32); }
function normalizePlate(value: string) { return value.replace(/[\s·]/g, '').toUpperCase(); }
function isFullPlate(value: string) { return /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}$/.test(value); }
function stringValue(value: unknown) { return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value); }
function nullableString(value: unknown) { const text = stringValue(value); return text || null; }
function numberValue(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00+08:00`);
  return !Number.isNaN(parsed.getTime()) && parsed.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === value;
}
function dateOnlyFromValue(value: unknown) {
  const text = stringValue(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
}
function dateOnlyFromEpoch(value: unknown) {
  const epoch = Number(value);
  if (!Number.isFinite(epoch) || epoch <= 0) return '';
  return new Date(epoch * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function miniappErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('DELIYUN_AUTH')) return '德立云专用账号登录已失效或无权限，请核对账号状态';
  if (message === 'DELIYUN_LOGIN_NO_TOKEN') return '德立云专用账号登录未返回有效会话';
  if (message === 'DELIYUN_PROJECT_NOT_FOUND') return '德立云账号下未找到指定项目，请核对项目名称与账号权限';
  if (message === 'DELIYUN_CRYPTO_CONFIG') return '德立云小程序协议配置不完整';
  if (/ECONNABORTED|ETIMEDOUT/.test(message)) return '德立云连接超时，请检查服务器网络';
  return '德立云专用账号连接失败，请核对账号、协议配置或服务状态';
}

function deliyunErrorMessage(status: number, payload: DeliyunResponse | undefined) {
  const code = payload?.ecode === undefined ? '' : `（代码 ${String(payload.ecode)}）`;
  const detail = typeof payload?.msg === 'string' && payload.msg.trim() ? payload.msg.trim() : `HTTP ${status}`;
  if (detail.includes('版本号')) return `停车 API 版本号不正确${code}，请从德立云“接口授权”详情复制当前版本号`;
  if (/commKey|项目|车场/i.test(detail)) return `停车场 commKey 不正确或无权限${code}`;
  if (/sign|签名|AccessKey|密钥/i.test(detail)) return `AccessKey 签名未通过${code}，请核对接口授权与当前签名规则`;
  return `德立云连接验证失败${code}：${detail}`;
}
