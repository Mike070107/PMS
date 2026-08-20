import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import {
  AdminLoginDto,
  BootstrapAdminDto,
  OwnerMatchPhoneDto,
  OwnerOnboardDto,
  RefreshTokenDto,
  StaffLoginDto,
  WxLoginDto,
} from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
