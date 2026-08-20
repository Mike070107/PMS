import { IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class WxLoginDto {
  @IsString()
  @MaxLength(120)
  code: string;

  @IsIn(['owner', 'staff'])
  appType: 'owner' | 'staff';
}

export class StaffLoginDto {
  // wx.login() 的 code，用于取 openid
  @IsString()
  @MaxLength(120)
  code: string;

  // wx.getPhoneNumber() 的 code（首次绑定二选一）
  @IsOptional()
  @IsString()
  @MaxLength(200)
  phoneCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  account?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(64)
  password?: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}

export class OwnerOnboardDto {
  @Type(() => Number)
  @IsInt()
  communityId: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  buildingId?: number;

  /**
   * 扫码带出的弄/号，业主可手动改（扫错码、贴错码的情况）。
   * 传了就以它为准去小区里找楼栋，找不到直接报错，不会静默丢掉。
   */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  lane?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  buildingNo?: string;

  @IsString()
  @MaxLength(30)
  roomNo: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  realName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  // wx.getPhoneNumber() 返回的 code（可选，走微信手机号快速填充）
  @IsOptional()
  @IsString()
  @MaxLength(200)
  phoneCode?: string;
}

export class AdminLoginDto {
  @IsString()
  @MaxLength(60)
  account: string;

  @IsString()
  @MinLength(6)
  password: string;
}

export class BootstrapAdminDto {
  @IsString()
  token: string;

  @IsString()
  @MaxLength(120)
  tenantName: string;

  @IsString()
  @MaxLength(60)
  account: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

/** 用微信手机号匹配名下房产（不产生绑定，只把地址带出来） */
export class OwnerMatchPhoneDto {
  @IsString()
  phoneCode: string;

  /** 扫码进来时带上，把匹配范围收窄到该小区所属租户 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;
}
