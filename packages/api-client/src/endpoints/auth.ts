import type {
  LoginByCodeReq,
  LoginResp,
  MeResp,
  OwnerOnboardReq,
  StaffLoginReq,
  UserRole,
} from '@pms/shared-types';
import { request } from '../request';

export const loginByCode = (data: LoginByCodeReq) =>
  request<LoginResp>({ method: 'POST', url: '/auth/wx-login', data, anonymous: true });

/** 员工端登录：已绑定微信只传 code；首次绑定另传 phoneCode 或 account+password */
export const staffLogin = (data: StaffLoginReq) =>
  request<LoginResp>({ method: 'POST', url: '/auth/staff-login', data, anonymous: true });

export const refreshToken = (refreshToken: string) =>
  request<LoginResp>({ method: 'POST', url: '/auth/refresh', data: { refreshToken }, anonymous: true });

export const ownerOnboard = (data: OwnerOnboardReq) =>
  request<{ auditStatus: string }>({ method: 'POST', url: '/auth/owner-onboard', data });

export const me = () => request<MeResp>({ url: '/auth/me' });

export interface AdminLoginReq {
  account: string;
  password: string;
}

export interface AdminLoginResp {
  accessToken: string;
  tokenType: 'Bearer';
  user: {
    id: string;
    tenantId: string;
    role: UserRole;
    name?: string;
    loginAccount: string;
  };
}

export const adminLogin = (data: AdminLoginReq) =>
  request<AdminLoginResp>({ method: 'POST', url: '/auth/admin-login', data, anonymous: true });

export interface MatchedPlace {
  communityId: number | null;
  communityName: string;
  buildingId: number | null;
  buildingText: string;
  houseId: number;
  roomNo: string;
  addressText: string;
}

export interface OwnerMatchPhoneResp {
  /** 物业是否开启了手机号快速识别 */
  enabled: boolean;
  matched: boolean;
  /** 脱敏后的手机号，用于提示 */
  phone?: string;
  /** 没匹配上的原因，直接展示给业主 */
  reason?: string;
  place?: MatchedPlace;
}

/** 用微信手机号匹配名下房产；只带出地址，不建立绑定 */
export const matchPhone = (data: { phoneCode: string; communityId?: number }) =>
  request<OwnerMatchPhoneResp>({ method: 'POST', url: '/auth/owner-match-phone', data });

// ---------------- 后台网页扫码登录 ----------------

/** 网页出码。qrImage 是 data:image/png;base64,... 可直接塞进 <img src> */
export interface QrLoginTicketResp {
  ticket: string;
  qrImage: string;
  expiresIn: number;
}

/** 网页轮询的结果。confirmed 时带上 token，且这张票据当场作废 */
export interface QrLoginStatusResp {
  status: 'pending' | 'scanned' | 'confirmed' | 'cancelled' | 'expired';
  accessToken?: string;
  tokenType?: string;
  /** 和账号密码登录同一个形状，网页两条路共用一套 setSession */
  user?: AdminLoginResp['user'];
}

export const qrLoginTicket = () =>
  request<QrLoginTicketResp>({
    method: 'POST',
    url: '/auth/qr-login/ticket',
    anonymous: true,
  });

export const qrLoginStatus = (ticket: string) =>
  request<QrLoginStatusResp>({
    url: '/auth/qr-login/status',
    query: { ticket },
    anonymous: true,
  });

/** 扫开小程序码后，告诉本人「谁在哪台机器上要登录」 */
export interface QrLoginScanInfo {
  ticket: string;
  status: string;
  /** 出码那台机器的 IP 和浏览器，本人据此判断是不是自己 */
  clientIp: string | null;
  userAgent: string | null;
  requestedAt: string;
  expiresAt: string;
  me: { name: string | null; roleLabel: string | null };
}

export const qrLoginScan = (ticket: string) =>
  request<QrLoginScanInfo>({ method: 'POST', url: '/auth/qr-login/scan', data: { ticket } });

export const qrLoginConfirm = (ticket: string) =>
  request<{ ok: true }>({ method: 'POST', url: '/auth/qr-login/confirm', data: { ticket } });

export const qrLoginCancel = (ticket: string) =>
  request<{ ok: true }>({ method: 'POST', url: '/auth/qr-login/cancel', data: { ticket } });
