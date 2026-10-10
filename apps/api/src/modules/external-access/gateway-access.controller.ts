import { Controller, Get, Header, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebLoginTicketPurpose } from '../../entities/web-login-ticket.entity';
import { QrLoginService } from '../auth/qr-login.service';
import { clearQrBrowserCookie, readQrBrowserSecret, setQrBrowserCookie } from '../auth/qr-login-security';
import { ExternalAccessService } from './external-access.service';

const SESSION_COOKIE = '__Secure-pms_gateway';

@Controller('gateway-access')
export class GatewayAccessController {
  constructor(
    private readonly externalAccess: ExternalAccessService,
    private readonly qrLogin: QrLoginService,
  ) {}

  @Get('start')
  async start(
    @Query('hostname') hostname: string,
    @Query('returnTo') returnTo: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const app = await this.externalAccess.resolveGatewayApplication(hostname);
    const safeReturnTo = this.safeReturnTo(app.publicHostname, returnTo);
    const ticket = await this.qrLogin.createTicket(req.ip, req.headers['user-agent'], {
      purpose: WebLoginTicketPurpose.EXTERNAL_GATEWAY,
      requiredApp: app,
    });
    setQrBrowserCookie(req, res, ticket.ticket, ticket.browserSecret, ticket.expiresIn);
    const nonce = randomBytes(16).toString('base64url');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Security-Policy', `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.type('html').send(this.renderLogin(ticket.ticket, ticket.qrImage, ticket.launchScheme, app.name, app.publicHostname, safeReturnTo, nonce));
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(
    @Query('ticket') ticket: string,
    @Query('hostname') hostname: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.qrLogin.pollExternalGatewayStatus(ticket, readQrBrowserSecret(req, ticket), req.ip);
    if (result.status !== 'confirmed') {
      if (['cancelled', 'expired'].includes(result.status)) clearQrBrowserCookie(req, res, ticket);
      return result;
    }
    const app = await this.externalAccess.resolveGatewayApplication(hostname);
    if (app.id !== result.appId) return { status: 'expired' as const };
    const session = this.externalAccess.createGatewaySession(app, result.userId);
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: `.${this.zoneName()}`,
      path: '/',
      maxAge: session.maxAge * 1000,
    });
    clearQrBrowserCookie(req, res, ticket);
    return { status: 'confirmed' as const };
  }

  @Get('verify')
  @Header('Cache-Control', 'no-store')
  verify(@Query('hostname') hostname: string, @Req() req: Request) {
    this.assertRouter(req.headers['x-pms-gateway-router-secret']);
    return this.externalAccess.verifyGatewaySession(hostname, readCookie(req.headers.cookie, SESSION_COOKIE));
  }

  private assertRouter(value: string | string[] | undefined) {
    const expected = process.env.LAN_GATEWAY_ROUTER_SECRET || '';
    const actual = Array.isArray(value) ? value[0] : value || '';
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    if (!expected || left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException('内网网关调用身份无效');
    }
  }

  private safeReturnTo(hostname: string, value: string) {
    try {
      const url = new URL(value || `https://${hostname}/`);
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== hostname.toLowerCase()) throw new Error('host');
      return url.toString();
    } catch {
      return `https://${hostname}/`;
    }
  }

  private zoneName() {
    return process.env.CLOUDFLARE_ZONE_NAME?.trim().toLowerCase() || 'prsznh.cn';
  }

  private renderLogin(ticket: string, qrImage: string, launchScheme: string | null, name: string, hostname: string, returnTo: string, nonce: string) {
    const data = JSON.stringify({ ticket, hostname, returnTo }).replace(/</g, '\\u003c');
    const launchAction = launchScheme
      ? `<a class="launch" href="${escapeHtml(launchScheme)}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M8.2 4.8a7.2 7.2 0 0 1 8.9 10.9l1.7 2.9-3.4-1a7.2 7.2 0 0 1-10.5-4.4 6.2 6.2 0 0 1 3.3-8.4Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 10.2h.01M13.4 10.2h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><span>打开微信授权登录</span></a><p class="launch-tip">手机和电脑都可以使用；若未能唤起微信，请使用下方二维码。</p>`
      : '';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)} · 安全登录</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f3f7f8;color:#17353a;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}.card{width:min(440px,100%);padding:30px;background:#fff;border:1px solid #dce9e8;border-radius:20px;box-shadow:0 18px 55px rgba(20,78,74,.12);text-align:center}.mark{width:48px;height:48px;margin:auto;display:grid;place-items:center;border-radius:15px;background:#e1f5f0;color:#0f766e}.mark svg{width:25px;height:25px}h1{margin:14px 0 4px;font-size:23px}.host{margin:0 0 18px;color:#60777a}.launch{min-height:52px;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 18px;border-radius:12px;background:#0f766e;color:#fff;text-decoration:none;font-size:17px;font-weight:700;box-shadow:0 8px 20px rgba(15,118,110,.2);transition:background .2s ease,box-shadow .2s ease}.launch:hover{background:#0b625c;box-shadow:0 10px 24px rgba(15,118,110,.25)}.launch:active{background:#09534e}.launch:focus-visible{outline:3px solid rgba(3,105,161,.35);outline-offset:3px}.launch svg{width:23px;height:23px;flex:0 0 auto}.launch-tip{margin:9px 0 17px;color:#60777a;font-size:13px;line-height:1.6}.divider{display:flex;align-items:center;gap:12px;margin:2px 0 13px;color:#74878a;font-size:13px}.divider::before,.divider::after{content:"";height:1px;flex:1;background:#e1e9e9}.qr{width:248px;height:248px;max-width:100%;border-radius:12px}.status{min-height:26px;margin-top:15px;color:#0f766e;font-weight:650}.tip{margin-top:18px;padding-top:16px;border-top:1px solid #e8eeee;color:#637477;font-size:13px;line-height:1.7}.error{color:#b42318}.ok{color:#067647}@media(max-width:480px){body{padding:16px}.card{padding:24px 20px;border-radius:18px}.qr{width:210px;height:210px}}@media(prefers-reduced-motion:reduce){.launch{transition:none}}</style></head><body><main class="card"><div class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h1>${escapeHtml(name)}</h1><p class="host">${escapeHtml(hostname)}</p>${launchAction}${launchScheme ? '<div class="divider"><span>或使用另一台设备扫码</span></div>' : ''}<img class="qr" src="${qrImage}" alt="微信小程序登录二维码"><div id="status" class="status" role="status" aria-live="polite">等待授权确认…</div><div class="tip">请在微信中核对应用和域名；确认后将直接进入内网应用。</div></main><script nonce="${nonce}">(()=>{const d=${data},el=document.getElementById('status');let stop=false;async function poll(){if(stop)return;try{const u='/api/v1/gateway-access/status?ticket='+encodeURIComponent(d.ticket)+'&hostname='+encodeURIComponent(d.hostname),r=await fetch(u,{cache:'no-store'}),j=await r.json();if(!r.ok){throw new Error(j.message||'授权失败')}if(j.status==='confirmed'){stop=true;el.className='status ok';el.textContent='授权成功，正在进入…';location.replace(d.returnTo);return}if(j.status==='scanned')el.textContent='已打开微信，请确认授权';else if(j.status==='cancelled'||j.status==='expired'){stop=true;el.className='status error';el.textContent=j.status==='cancelled'?'已取消本次登录':'授权已过期，请刷新页面'}}catch(e){el.className='status error';el.textContent=e.message||'网络暂时不可用'}if(!stop)setTimeout(poll,2000)}poll()})();</script></body></html>`;
  }
}

function readCookie(header: string | undefined, name: string) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function escapeHtml(value: string) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}
