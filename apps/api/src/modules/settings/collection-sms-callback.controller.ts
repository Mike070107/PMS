import { BadRequestException, Body, Controller, ForbiddenException, Headers, Post } from '@nestjs/common';
import { CollectionSmsLogService } from './collection-sms-log.service';

/**
 * 催缴短信运营商回执。
 *
 * 通道侧没有登录态，所以不挂 JwtAuthGuard；配置 SMS_CALLBACK_TOKEN 后
 * 要求请求头 x-sms-token 一致，没配则不校验（只建议测试环境）。
 */
@Controller('fees/mis/sms')
export class CollectionSmsCallbackController {
  constructor(private readonly log: CollectionSmsLogService) {}

  @Post('callback')
  callback(
    @Body() body: { bizId?: string; status?: string; error?: string },
    @Headers('x-sms-token') token?: string,
  ) {
    const expected = process.env.SMS_CALLBACK_TOKEN;
    if (expected && token !== expected) throw new ForbiddenException('invalid sms callback token');
    if (!body?.bizId) throw new BadRequestException('缺少 bizId');
    const status =
      body.status === 'delivered' ? 'delivered' : body.status === 'failed' || body.status === 'undelivered' ? 'failed' : null;
    if (!status) throw new BadRequestException('未知回执状态');
    return this.log.handleReceipt({ bizId: body.bizId, status, error: body.error });
  }
}
