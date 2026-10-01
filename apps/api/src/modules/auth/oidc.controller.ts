import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { WebLoginTicketPurpose } from '../../entities/web-login-ticket.entity';
import { OidcService } from './oidc.service';
import { QrLoginService } from './qr-login.service';

@Controller('auth/oidc')
export class OidcController {
  constructor(
    private readonly oidc: OidcService,
    private readonly qrLogin: QrLoginService,
  ) {}

  @Get('.well-known/openid-configuration')
  discovery() {
    return this.oidc.metadata();
  }

  @Get('jwks')
  jwks() {
    return this.oidc.jwks();
  }

  @Get('authorize')
  async authorize(
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const oidcRequest = this.oidc.validateAuthorizeQuery(query);
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.ip;
    const ticket = await this.qrLogin.createTicket(ip, req.headers['user-agent'], {
      purpose: WebLoginTicketPurpose.EXTERNAL_ACCESS_OIDC,
      oidcRequest,
    });
    const nonce = randomBytes(16).toString('base64url');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
    res.type('html').send(this.renderLoginPage(ticket.ticket, ticket.qrImage, nonce));
  }

  @Get('status')
  status(@Query('ticket') ticket: string) {
    return this.qrLogin.pollExternalOidcStatus(ticket);
  }

  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  token(
    @Body() body: Record<string, string | undefined>,
    @Headers('authorization') authorization?: string,
  ) {
    return this.oidc.exchangeToken(body, authorization);
  }

  @Get('userinfo')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  userinfo(@Headers('authorization') authorization?: string) {
    return this.oidc.userinfo(authorization);
  }

  @Post('userinfo')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  userinfoPost(@Headers('authorization') authorization?: string) {
    return this.oidc.userinfo(authorization);
  }

  private renderLoginPage(ticket: string, qrImage: string, nonce: string) {
    const ticketJson = JSON.stringify(ticket).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>内网应用安全登录</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(440px,100%);background:#fff;border:1px solid #e4e8ef;border-radius:18px;padding:32px;box-shadow:0 16px 45px rgba(21,35,62,.10);text-align:center}h1{font-size:24px;margin:0 0 8px}.sub{color:#5f6b7a;line-height:1.7;margin:0 0 20px}.qr{display:block;width:260px;height:260px;max-width:100%;margin:0 auto;border-radius:12px}.status{min-height:28px;margin-top:16px;color:#1769aa;font-weight:600}.tip{margin-top:20px;padding-top:18px;border-top:1px solid #edf0f4;color:#667085;font-size:14px;line-height:1.7}.error{color:#b42318}.ok{color:#067647}@media(max-width:480px){.card{padding:24px 18px}.qr{width:230px;height:230px}}
</style></head><body><main class="card"><h1>内网应用安全登录</h1><p class="sub">请用微信扫一扫，在「邻修管理」小程序中确认登录</p><img class="qr" src="${qrImage}" alt="登录二维码"><div id="status" class="status">等待扫码确认…</div><div class="tip">只有管理员已授权的手机号才能进入对应内网应用。二维码两分钟内有效，且只能使用一次。</div></main>
<script nonce="${nonce}">(()=>{const ticket=${ticketJson};const el=document.getElementById('status');let stopped=false;async function poll(){if(stopped)return;try{const r=await fetch('/api/v1/auth/oidc/status?ticket='+encodeURIComponent(ticket),{cache:'no-store'});const d=await r.json();if(!r.ok){stopped=true;el.className='status error';el.textContent=d.message||'授权失败，请重新打开目标系统';return}if(d.status==='confirmed'&&d.redirectTo){stopped=true;el.className='status ok';el.textContent='授权成功，正在进入目标系统…';location.replace(d.redirectTo);return}if(d.status==='scanned'){el.textContent='已扫码，请在手机上确认'}else if(d.status==='cancelled'){stopped=true;el.className='status error';el.textContent='你已取消本次登录，请重新打开目标系统'}else if(d.status==='expired'){stopped=true;el.className='status error';el.textContent='二维码已过期，请刷新页面重试'}}catch(e){el.textContent='网络暂时不可用，正在重试…'}if(!stopped)setTimeout(poll,2000)}poll()})();</script></body></html>`;
  }
}
