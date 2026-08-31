import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SubmitSignatureDto } from './dto';
import { MaintenanceService } from './maintenance.service';

/**
 * 手机签名页用的两个接口 —— **不带登录态**。
 *
 * 场景：办公室在电脑上点「发到手机签」，屏幕上出一个二维码，师傅/业主用微信一扫，
 * 手机上直接是签名板，签完页面自己关掉。手机上没有、也不该有后台账号。
 *
 * 凭据就是链接里那串 token：另一把密钥签的、5 分钟过期、只对一张单的一个签名位有效
 * （见 MaintenanceService.createSignToken）。所以这里不挂 JwtAuthGuard，
 * 但**每个接口都必须自己验 token**，别图省事直接读参数。
 */
@Controller('sign')
export class SignController {
  constructor(private readonly service: MaintenanceService) {}

  /** 手机打开页面时问一句：这是给哪张单、哪个位置签的 */
  @Get('session')
  session(@Query('token') token: string) {
    return this.service.getSignSession(token || '');
  }

  @Post('submit')
  submit(@Body() dto: SubmitSignatureDto) {
    return this.service.submitSignature(dto.token, dto.image);
  }
}
