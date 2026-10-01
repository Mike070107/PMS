import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { IsNull, Repository } from 'typeorm';
import { OidcAuthorizationCode } from '../../entities';
import { OidcLoginRequest } from '../../entities/web-login-ticket.entity';
import { AuthService } from './auth.service';

const CODE_TTL_MS = 2 * 60 * 1000;
const TOKEN_TTL_SEC = 5 * 60;
// Cloudflare Access uses an opaque, signed state value that is commonly well
// above 500 characters. Keep a bounded limit without rejecting valid IdP flows.
const MAX_OIDC_STATE_LENGTH = 4096;

type AuthorizeQuery = Record<string, string | string[] | undefined>;

const asText = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] ?? '' : value ?? '';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class OidcService {
  constructor(
    @InjectRepository(OidcAuthorizationCode)
    private readonly codeRepo: Repository<OidcAuthorizationCode>,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  issuer(): string {
    return this.config
      .get<string>('EXTERNAL_OIDC_ISSUER', '')
      .trim()
      .replace(/\/$/, '');
  }

  metadata() {
    const issuer = this.requireEnabled().issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: [
        'sub',
        'email',
        'email_verified',
        'name',
        'external_apps',
      ],
    };
  }

  jwks() {
    const { privateKey, keyId } = this.requireEnabled();
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    return { keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: keyId }] };
  }

  validateAuthorizeQuery(query: AuthorizeQuery): OidcLoginRequest {
    const cfg = this.requireEnabled();
    const responseType = asText(query.response_type);
    const clientId = asText(query.client_id);
    const redirectUri = asText(query.redirect_uri);
    const scope = asText(query.scope).split(/\s+/).filter(Boolean);
    const state = asText(query.state);
    const nonce = asText(query.nonce) || undefined;
    const codeChallenge = asText(query.code_challenge) || undefined;
    const codeChallengeMethod = asText(query.code_challenge_method) || undefined;

    if (responseType !== 'code') throw new BadRequestException('只支持 authorization code');
    if (clientId !== cfg.clientId) throw new UnauthorizedException('OIDC client_id 无效');
    if (!cfg.redirectUris.has(redirectUri)) {
      throw new BadRequestException('OIDC redirect_uri 未登记');
    }
    if (!scope.includes('openid')) throw new BadRequestException('scope 必须包含 openid');
    if (!state || state.length > MAX_OIDC_STATE_LENGTH) {
      throw new BadRequestException('state 无效');
    }
    if (nonce && nonce.length > 200) throw new BadRequestException('nonce 过长');
    if (codeChallenge && codeChallengeMethod !== 'S256') {
      throw new BadRequestException('PKCE 只支持 S256');
    }
    if (codeChallenge && !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
      throw new BadRequestException('code_challenge 无效');
    }
    return {
      clientId,
      redirectUri,
      state,
      nonce,
      codeChallenge,
      codeChallengeMethod: codeChallenge ? 'S256' : undefined,
    };
  }

  async createAuthorizationCode(userId: number, request: OidcLoginRequest) {
    // 再验一次，避免数据库中的旧/伪造请求绕过当前回调白名单。
    const cfg = this.requireEnabled();
    if (request.clientId !== cfg.clientId || !cfg.redirectUris.has(request.redirectUri)) {
      throw new BadRequestException('OIDC 请求已失效，请重新打开目标系统');
    }
    if (!request.requiredAppId || !request.requiredAppSlug) {
      throw new BadRequestException('OIDC 请求没有绑定目标应用，请重新打开目标系统');
    }
    await this.authService.requireExternalAccessUser(userId, {
      appId: request.requiredAppId,
      appSlug: request.requiredAppName || request.requiredAppSlug,
    });
    const code = randomBytes(32).toString('base64url');
    await this.codeRepo.save(
      this.codeRepo.create({
        codeHash: sha256(code),
        userId,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        nonce: request.nonce ?? null,
        codeChallenge: request.codeChallenge ?? null,
        requiredAppId: request.requiredAppId,
        requiredAppSlug: request.requiredAppSlug,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
        consumedAt: null,
        createdBy: userId,
        updatedBy: userId,
      }),
    );
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', request.state);
    return redirect.toString();
  }

  async exchangeToken(
    body: Record<string, string | undefined>,
    authorizationHeader?: string,
  ) {
    const cfg = this.requireEnabled();
    const basic = this.readBasicAuth(authorizationHeader);
    const clientId = basic?.clientId ?? body.client_id ?? '';
    const clientSecret = basic?.clientSecret ?? body.client_secret ?? '';
    if (clientId !== cfg.clientId || !this.safeEqual(clientSecret, cfg.clientSecret)) {
      throw new UnauthorizedException('OIDC client authentication failed');
    }
    if (body.grant_type !== 'authorization_code') {
      throw new BadRequestException('unsupported grant_type');
    }
    const code = String(body.code || '');
    const row = code
      ? await this.codeRepo.findOne({ where: { codeHash: sha256(code) } })
      : null;
    if (
      !row ||
      row.consumedAt ||
      row.expiresAt.getTime() < Date.now() ||
      row.clientId !== clientId ||
      row.redirectUri !== body.redirect_uri
    ) {
      throw new BadRequestException('authorization code 无效或已使用');
    }
    if (row.codeChallenge) {
      const verifier = String(body.code_verifier || '');
      const actual = createHash('sha256').update(verifier).digest('base64url');
      if (!this.safeEqual(actual, row.codeChallenge)) {
        throw new BadRequestException('PKCE 校验失败');
      }
    }

    const claimed = await this.codeRepo.update(
      { id: row.id, consumedAt: IsNull() },
      { consumedAt: new Date(), updatedBy: row.userId },
    );
    if (!claimed.affected) throw new BadRequestException('authorization code 已使用');

    if (!row.requiredAppId || !row.requiredAppSlug) {
      throw new BadRequestException('authorization code 未绑定目标应用');
    }
    const { user, appSlugs } = await this.authService.requireExternalAccessUser(row.userId, {
      appId: row.requiredAppId,
      appSlug: row.requiredAppSlug,
    });
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: cfg.issuer,
      aud: cfg.clientId,
      sub: `pms:user:${user.id}`,
      email: `pms-u${user.id}@auth.prsznh.cn`,
      email_verified: true,
      name: user.name || `PMS 用户 ${user.id}`,
      external_apps: appSlugs,
      tenant_id: user.tenantId,
      iat: now,
      exp: now + TOKEN_TTL_SEC,
      ...(row.nonce ? { nonce: row.nonce } : {}),
    };
    const idToken = this.signJwt(claims, cfg.privateKey, cfg.keyId);
    return {
      access_token: idToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SEC,
      id_token: idToken,
      scope: 'openid email profile',
    };
  }

  userinfo(authorizationHeader?: string) {
    if (!authorizationHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer access token required');
    }
    const cfg = this.requireEnabled();
    const token = authorizationHeader.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('access token 无效');

    try {
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
        alg?: string;
        kid?: string;
      };
      const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
        iss?: string;
        aud?: string | string[];
        sub?: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        external_apps?: string[];
        tenant_id?: number;
        exp?: number;
      };
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const validSignature = verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey(cfg.privateKey),
        Buffer.from(encodedSignature, 'base64url'),
      );
      if (
        header.alg !== 'RS256' ||
        header.kid !== cfg.keyId ||
        !validSignature ||
        claims.iss !== cfg.issuer ||
        !audience.includes(cfg.clientId) ||
        !claims.sub ||
        !claims.email ||
        typeof claims.exp !== 'number' ||
        claims.exp <= Math.floor(Date.now() / 1000)
      ) {
        throw new Error('invalid claims');
      }
      return {
        sub: claims.sub,
        email: claims.email,
        email_verified: claims.email_verified === true,
        name: claims.name || claims.email,
        external_apps: Array.isArray(claims.external_apps) ? claims.external_apps : [],
        tenant_id: claims.tenant_id,
      };
    } catch {
      throw new UnauthorizedException('access token 无效或已过期');
    }
  }

  private signJwt(payload: object, privateKey: ReturnType<typeof createPrivateKey>, keyId: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyId })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const input = `${header}.${body}`;
    const signature = sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
    return `${input}.${signature}`;
  }

  private requireEnabled() {
    const issuer = this.issuer();
    const clientId = this.config.get<string>('EXTERNAL_OIDC_CLIENT_ID', '').trim();
    const clientSecret = this.config.get<string>('EXTERNAL_OIDC_CLIENT_SECRET', '').trim();
    const redirectUris = new Set(
      this.config
        .get<string>('EXTERNAL_OIDC_REDIRECT_URIS', '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const privateKeyB64 = this.config.get<string>('EXTERNAL_OIDC_PRIVATE_KEY_B64', '').trim();
    if (!issuer || !clientId || !clientSecret || !redirectUris.size || !privateKeyB64) {
      throw new ServiceUnavailableException('内网应用 OIDC 尚未完成服务器配置');
    }
    let privateKey: ReturnType<typeof createPrivateKey>;
    try {
      privateKey = createPrivateKey(Buffer.from(privateKeyB64, 'base64').toString('utf8'));
    } catch {
      throw new ServiceUnavailableException('内网应用 OIDC 签名密钥配置无效');
    }
    const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const keyId = createHash('sha256').update(publicDer).digest('hex').slice(0, 16);
    return { issuer, clientId, clientSecret, redirectUris, privateKey, keyId };
  }

  private safeEqual(left: string, right: string) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private readBasicAuth(value?: string) {
    if (!value?.startsWith('Basic ')) return null;
    try {
      const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
      const split = decoded.indexOf(':');
      if (split < 0) return null;
      return {
        clientId: decodeURIComponent(decoded.slice(0, split)),
        clientSecret: decodeURIComponent(decoded.slice(split + 1)),
      };
    } catch {
      return null;
    }
  }
}
