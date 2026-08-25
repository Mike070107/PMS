import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import { QrLoginService } from './qr-login.service';
import {
  AdminLoginDto,
  BootstrapAdminDto,
  OwnerMatchPhoneDto,
  OwnerOnboardDto,
  QrLoginTicketDto,
  RefreshTokenDto,
  StaffLoginDto,
  WxLoginDto,
} from './dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly qrLoginService: QrLoginService,
  ) {}

  // ---------------- 微信扫码登录后台 ----------------

  /**
   * 出一张小程序码。匿名接口：还没登录的人才需要它。
   * 客户端 IP / UA 原样带给手机确认页展示，是本人判断该不该确认的依据。
   */
  @Post('qr-login/ticket')
  createQrTicket(@Req() req: Request) {
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.ip;
    return this.qrLoginService.createTicket(ip, req.headers['user-agent']);
  }

  /** 网页轮询。确认过就连 token 一起返回，票据随即作废 */
  @Get('qr-login/status')
  qrLoginStatus(@Query('ticket') ticket: string) {
    return this.qrLoginService.pollStatus(ticket);
  }

  /** 小程序扫开后调：告诉本人「谁在哪台机器上要登录」，不发令牌 */
  @Post('qr-login/scan')
  @UseGuards(JwtAuthGuard)
  qrLoginScan(@Body() dto: QrLoginTicketDto, @CurrentUser() user: AuthUser) {
    return this.qrLoginService.markScanned(dto.ticket, user);
  }

  @Post('qr-login/confirm')
  @UseGuards(JwtAuthGuard)
  qrLoginConfirm(@Body() dto: QrLoginTicketDto, @CurrentUser() user: AuthUser) {
    return this.qrLoginService.confirm(dto.ticket, user);
  }

  @Post('qr-login/cancel')
  @UseGuards(JwtAuthGuard)
  qrLoginCancel(@Body() dto: QrLoginTicketDto, @CurrentUser() user: AuthUser) {
    return this.qrLoginService.cancel(dto.ticket, user);
  }

  @Post('admin-login')
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Post('wx-login')
  wxLogin(@Body() dto: WxLoginDto) {
    return this.authService.wxLogin(dto);
  }

  @Post('staff-login')
  staffLogin(@Body() dto: StaffLoginDto) {
    return this.authService.staffLogin(dto);
  }

  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto);
  }

  @Post('owner-onboard')
  @UseGuards(JwtAuthGuard)
  ownerOnboard(@Body() dto: OwnerOnboardDto, @CurrentUser() user: AuthUser) {
    return this.authService.ownerOnboard(dto, user);
  }

  /** 微信手机号匹配名下房产：只读，不建立绑定 */
  @Post('owner-match-phone')
  @UseGuards(JwtAuthGuard)
  ownerMatchPhone(
    @Body() dto: OwnerMatchPhoneDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.authService.ownerMatchPhone(dto, user);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user);
  }

  @Post('bootstrap-admin')
  bootstrapAdmin(@Body() dto: BootstrapAdminDto) {
    return this.authService.bootstrapAdmin(dto);
  }
}
