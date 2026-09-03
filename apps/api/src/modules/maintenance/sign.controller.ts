import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SubmitSignatureDto } from './dto';
import { MaintenanceService } from './maintenance.service';

/**
 * 手机签名页用的两个接口 —— **不带登录态**。
 *
 * 场景：办公室在电脑上点「发到手机签」，屏幕上出一个二维码，师傅/业主用微信一扫，
 * 手机上先完整预览养护单，可放大核对，再进入签名板；签完落回预览，提交后页面关闭。
 * 手机上没有、也不该有后台账号。
 *
 * 凭据就是链接里那串 token：另一把密钥签的、30 分钟过期、只对一张单的一个签名位有效，
 * 且数据库会保证只能提交一次
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

  /** 电脑那头轮询：手机打开了没有、签完了没有（按 token 判，重签也认得出来） */
  @Get('status')
  status(@Query('token') token: string) {
    return this.service.getSignStatus(token || '');
  }

  @Post('submit')
  submit(@Body() dto: SubmitSignatureDto) {
    return this.service.submitSignature(dto.token, dto.image);
  }
}
