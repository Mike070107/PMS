import {
  ConflictException,
  ForbiddenException,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import http from 'node:http';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import {
  ExternalAccessApp,
  ExternalAccountBinding,
} from '../../entities';
import { ExternalAccountBindingStatus } from '../../entities/external-account-binding.entity';
import { decryptExternalCredential, encryptExternalCredential } from './external-account-credential';

type RemoteLogin = {
  token: string;
  expiresAt: number;
  remoteUserId: string;
  remoteUsername: string;
  remoteDisplayName: string | null;
  browserProfile: Record<string, string | number>;
};

/** 无源码内网系统的账密校验、加密绑定和短时 Bearer 代登。 */
@Injectable()
export class ExternalAccountBindingService implements OnModuleInit {
  private readonly tokens = new Map<number, {
    token: string;
    expiresAt: number;
    browserProfile: Record<string, string | number>;
  }>();

  constructor(
    @InjectRepository(ExternalAccountBinding)
    private readonly bindingRepo: Repository<ExternalAccountBinding>,
    @InjectRepository(ExternalAccessApp)
    private readonly appRepo: Repository<ExternalAccessApp>,
    private readonly config: ConfigService,
  ) {}

  /** 生产当前仍使用 schema synchronize；首次加列后幂等启用已验证的首个适配对象。 */
  async onModuleInit() {
    await this.appRepo.update(
      {
        publicHostname: 'wyglxt.prsznh.cn',
        loginAdapter: 'none',
        loginPath: IsNull(),
      },
      { loginAdapter: 'bearer_json', loginPath: '/api/login' },
    );
  }

  requiresBinding(app: ExternalAccessApp) {
    return app.loginAdapter === 'bearer_json';
  }

  async bindingState(app: ExternalAccessApp, userId: number) {
    if (!this.requiresBinding(app)) return { required: false, bound: true, username: null };
    const binding = await this.bindingRepo.findOne({
      where: { appId: app.id, userId, status: ExternalAccountBindingStatus.ACTIVE },
    });
    return {
      required: true,
      bound: !!binding,
      username: binding?.remoteUsername ?? null,
    };
  }

  async bind(
    app: ExternalAccessApp,
    user: { id: number; tenantId: number },
    usernameValue: string,
    password: string,
  ) {
    if (!this.requiresBinding(app)) throw new ForbiddenException('这个内网应用不需要绑定账号');
    const username = String(usernameValue || '').trim();
    if (!username || username.length > 120 || !password || password.length > 200) {
      throw new UnauthorizedException('请填写正确的内网用户名和密码');
    }
    const remote = await this.authenticate(app, username, password);
    const duplicate = await this.bindingRepo.findOne({
      where: {
        appId: app.id,
        remoteUserId: remote.remoteUserId,
        status: ExternalAccountBindingStatus.ACTIVE,
      },
    });
    if (duplicate && duplicate.userId !== user.id) {
      throw new ConflictException('这个内网账号已绑定其他微信用户，请联系管理员先解绑');
    }

    const existing = await this.bindingRepo.findOne({ where: { appId: app.id, userId: user.id } });
    const scope = { tenantId: user.tenantId, appId: app.id, userId: user.id };
    const binding = this.bindingRepo.create({
      ...(existing ?? {}),
      tenantId: user.tenantId,
      appId: app.id,
      userId: user.id,
      remoteUserId: remote.remoteUserId,
      remoteUsername: remote.remoteUsername,
      remoteDisplayName: remote.remoteDisplayName,
      credentialPayload: encryptExternalCredential(password, this.credentialKey(), scope),
      status: ExternalAccountBindingStatus.ACTIVE,
      verifiedAt: new Date(),
      lastError: null,
      createdBy: existing?.createdBy ?? user.id,
      updatedBy: user.id,
    });
    let saved: ExternalAccountBinding;
    try {
      saved = await this.bindingRepo.save(binding);
    } catch (error) {
      if (error instanceof QueryFailedError && (error as any).driverError?.code === '23505') {
        throw new ConflictException('这个内网账号已绑定其他微信用户，请联系管理员先解绑');
      }
      throw error;
    }
    this.tokens.set(saved.id, {
      token: remote.token,
      expiresAt: remote.expiresAt,
      browserProfile: remote.browserProfile,
    });
    return {
      username: saved.remoteUsername,
      displayName: saved.remoteDisplayName,
    };
  }

  async gatewayAuthorization(app: ExternalAccessApp, userId: number) {
    if (!this.requiresBinding(app)) return { headers: {}, browserSession: null };
    const binding = await this.bindingRepo.findOne({
      where: { appId: app.id, userId, status: ExternalAccountBindingStatus.ACTIVE },
    });
    if (!binding) throw new ForbiddenException('请先在微信中绑定这个内网应用的账号');

    const cached = this.tokens.get(binding.id);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) {
      return this.authorizationResult(cached);
    }
    const password = decryptExternalCredential(
      binding.credentialPayload,
      this.credentialKey(),
      { tenantId: binding.tenantId, appId: binding.appId, userId: binding.userId },
    );
    try {
      const remote = await this.authenticate(app, binding.remoteUsername, password);
      if (remote.remoteUserId !== binding.remoteUserId) {
        binding.status = ExternalAccountBindingStatus.INVALID;
        binding.lastError = '内网账号身份已变化，需要重新绑定';
        await this.bindingRepo.save(binding);
        throw new UnauthorizedException('内网账号身份已变化，请重新绑定');
      }
      binding.remoteUserId = remote.remoteUserId;
      binding.remoteDisplayName = remote.remoteDisplayName;
      binding.verifiedAt = new Date();
      binding.lastError = null;
      await this.bindingRepo.save(binding);
      const tokenState = {
        token: remote.token,
        expiresAt: remote.expiresAt,
        browserProfile: remote.browserProfile,
      };
      this.tokens.set(binding.id, tokenState);
      return this.authorizationResult(tokenState);
    } catch (error) {
      if (error instanceof UnauthorizedException && binding.status === ExternalAccountBindingStatus.ACTIVE) {
        binding.status = ExternalAccountBindingStatus.INVALID;
        binding.lastError = '内网账号密码已失效，需要重新绑定';
        await this.bindingRepo.save(binding);
      }
      if (error instanceof UnauthorizedException) this.tokens.delete(binding.id);
      throw error;
    }
  }

  private authenticate(app: ExternalAccessApp, username: string, password: string): Promise<RemoteLogin> {
    if (!app.gatewayPort || !Number.isInteger(app.gatewayPort)) {
      throw new ServiceUnavailableException('内网应用通道尚未就绪');
    }
    const path = String(app.loginPath || '');
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes('..')) {
      throw new ServiceUnavailableException('内网应用登录适配配置无效');
    }
    const payload = Buffer.from(JSON.stringify({ username, password }), 'utf8');
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: app.gatewayPort!,
        path,
        method: 'POST',
        headers: {
          host: app.publicHostname,
          'content-type': 'application/json',
          'content-length': payload.length,
          'x-forwarded-host': app.publicHostname,
          'x-forwarded-proto': 'https',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1024 * 1024) chunks.push(chunk);
          else request.destroy(new Error('内网登录响应过大'));
        });
        response.on('end', () => {
          let body: any = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 统一转换为可恢复错误 */ }
          if ((response.statusCode || 500) >= 500) {
            reject(new ServiceUnavailableException('内网应用登录服务暂时不可用'));
            return;
          }
          if ((response.statusCode || 500) >= 400 || body?.status !== 'success' || typeof body?.token !== 'string') {
            reject(new UnauthorizedException('内网用户名或密码错误'));
            return;
          }
          const user = body.user || {};
          const remoteUserId = String(user.id ?? '').trim();
          if (!remoteUserId) {
            reject(new ServiceUnavailableException('内网应用登录响应缺少用户标识'));
            return;
          }
          resolve({
            token: body.token,
            expiresAt: this.tokenExpiry(body.token),
            remoteUserId,
            remoteUsername: String(user.username || username).slice(0, 120),
            remoteDisplayName: user.real_name ? String(user.real_name).slice(0, 120) : null,
            browserProfile: this.browserProfile(user, username),
          });
        });
      });
      request.setTimeout(8_000, () => request.destroy(new Error('内网应用登录超时')));
      request.on('error', (error) => {
        if (error instanceof UnauthorizedException || error instanceof ServiceUnavailableException) reject(error);
        else reject(new ServiceUnavailableException(`无法连接内网应用登录服务：${error.message}`));
      });
      request.end(payload);
    });
  }

  private tokenExpiry(token: string) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (Number.isFinite(payload.exp)) return Number(payload.exp) * 1000;
    } catch { /* 缺少 exp 时只做短缓存 */ }
    return Date.now() + 10 * 60_000;
  }

  private authorizationResult(state: {
    token: string;
    expiresAt: number;
    browserProfile: Record<string, string | number>;
  }) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(state.expiresAt / 1000) })).toString('base64url');
    return {
      headers: { authorization: `Bearer ${state.token}` },
      browserSession: {
        token: `${header}.${payload}.pms-gateway`,
        user: state.browserProfile,
      },
    };
  }

  private browserProfile(user: any, fallbackUsername: string) {
    const result: Record<string, string | number> = {};
    for (const key of ['id', 'username', 'real_name', 'community', 'role']) {
      const value = user?.[key];
      if (typeof value === 'string') result[key] = value.slice(0, 200);
      else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    if (!result.username) result.username = fallbackUsername.slice(0, 120);
    return result;
  }

  private credentialKey() {
    const encoded = this.config.get<string>('EXTERNAL_ACCOUNT_CREDENTIAL_KEY_B64', '').trim();
    let key: Buffer;
    try { key = Buffer.from(encoded, 'base64'); } catch { key = Buffer.alloc(0); }
    if (key.length !== 32) {
      throw new ServiceUnavailableException('内网账号保险箱尚未配置 32 字节加密密钥');
    }
    return key;
  }
}
