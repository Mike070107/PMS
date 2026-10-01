import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalAccessApp } from '../../entities';
import { ExternalIngressRule, mergeIngressRules } from './external-access.util';

type CfResponse<T> = { success: boolean; errors?: Array<{ message?: string }>; result: T };
@Injectable()
export class CloudflareGatewayService {
  constructor(private readonly config: ConfigService) {}

  async syncApp(app: ExternalAccessApp, allApps: ExternalAccessApp[], oldHostname?: string) {
    const cfg = this.requireConfig();
    const access = await this.syncAccess(app, cfg);
    app.cloudflareAppId = access.appId;
    app.cloudflarePolicyId = access.policyId;

    // Access 保护先创建成功，再开放 DNS 与 Tunnel 路由，避免任何短暂裸露窗口。
    app.cloudflareDnsRecordId = await this.syncDns(app, cfg);
    await this.syncIngress(allApps, cfg, oldHostname);
  }

  private async syncAccess(app: ExternalAccessApp, cfg: ReturnType<typeof this.requireConfig>) {
    let existingAppId = app.cloudflareAppId;
    if (!existingAppId) {
      const existingApps = await this.cf<
        Array<{
          id: string;
          domain?: string;
          destinations?: Array<{ type?: string; uri?: string }>;
        }>
      >(
        `accounts/${cfg.accountId}/access/apps?per_page=100`,
        'GET',
        undefined,
        cfg.token,
      );
      existingAppId = existingApps.find(
        (item) =>
          item.domain === app.publicHostname ||
          item.destinations?.some(
            (destination) =>
              destination.type === 'public' && destination.uri === app.publicHostname,
          ),
      )?.id ?? null;
    }
    const appBody = {
      name: app.name,
      type: 'self_hosted',
      destinations: [{ type: 'public', uri: app.publicHostname }],
      session_duration: app.sessionDuration,
      allowed_idps: [cfg.idpId],
      auto_redirect_to_identity: true,
      app_launcher_visible: false,
    };
    const appResult = existingAppId
      ? await this.cf<any>(
          `accounts/${cfg.accountId}/access/apps/${existingAppId}`,
          'PUT',
          appBody,
          cfg.token,
        )
      : await this.cf<any>(
          `accounts/${cfg.accountId}/access/apps`,
          'POST',
          appBody,
          cfg.token,
        );
    const appId = String(appResult.id || existingAppId || '');
    let existingPolicyId = app.cloudflarePolicyId;
    const policyName = `PMS 内网授权：${app.slug}`;
    if (!existingPolicyId) {
      const policies = await this.cf<Array<{ id: string; name?: string }>>(
        `accounts/${cfg.accountId}/access/apps/${appId}/policies?per_page=100`,
        'GET',
        undefined,
        cfg.token,
      );
      existingPolicyId = policies.find((item) => item.name === policyName)?.id ?? null;
    }
    const policyBody = {
      name: policyName,
      decision: 'allow',
      precedence: 1,
      include: [
        {
          oidc: {
            claim_name: 'external_apps',
            claim_value: app.slug,
            identity_provider_id: cfg.idpId,
          },
        },
      ],
    };
    const policyResult = existingPolicyId
      ? await this.cf<any>(
          `accounts/${cfg.accountId}/access/apps/${appId}/policies/${existingPolicyId}`,
          'PUT',
          policyBody,
          cfg.token,
        )
      : await this.cf<any>(
          `accounts/${cfg.accountId}/access/apps/${appId}/policies`,
          'POST',
          policyBody,
          cfg.token,
        );
    return { appId, policyId: String(policyResult.id || existingPolicyId || '') };
  }

  private async syncDns(app: ExternalAccessApp, cfg: ReturnType<typeof this.requireConfig>) {
    const target = `${cfg.tunnelId}.cfargotunnel.com`;
    let existingRecordId = app.cloudflareDnsRecordId;
    if (!existingRecordId) {
      const records = await this.cf<Array<{ id: string; type: string; name: string; content: string }>>(
        `zones/${cfg.zoneId}/dns_records?name=${encodeURIComponent(app.publicHostname)}`,
        'GET',
        undefined,
        cfg.token,
      );
      const existing = records.find((item) => item.name === app.publicHostname);
      if (existing && (existing.type !== 'CNAME' || existing.content !== target)) {
        throw new BadGatewayException(
          `Cloudflare DNS 中已存在 ${existing.type} 记录，未自动覆盖；请先核对 ${app.publicHostname}`,
        );
      }
      existingRecordId = existing?.id ?? null;
    }
    const body = {
      type: 'CNAME',
      name: app.publicHostname,
      content: target,
      proxied: true,
      ttl: 1,
      comment: `Managed by PMS external access: ${app.slug}`,
    };
    const result = existingRecordId
      ? await this.cf<any>(
          `zones/${cfg.zoneId}/dns_records/${existingRecordId}`,
          'PUT',
          body,
          cfg.token,
        )
      : await this.cf<any>(`zones/${cfg.zoneId}/dns_records`, 'POST', body, cfg.token);
    return String(result.id || existingRecordId || '');
  }

  private async syncIngress(
    apps: ExternalAccessApp[],
    cfg: ReturnType<typeof this.requireConfig>,
    oldHostname?: string,
  ) {
    const current = await this.cf<any>(
      `accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}/configurations`,
      'GET',
      undefined,
      cfg.token,
    );
    const currentIngress: ExternalIngressRule[] = current?.config?.ingress ?? [];
    const ingress = mergeIngressRules(currentIngress, apps, oldHostname);
    await this.cf(
      `accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}/configurations`,
      'PUT',
      { config: { ...(current?.config ?? {}), ingress } },
      cfg.token,
    );
  }

  private requireConfig() {
    const value = (key: string) => this.config.get<string>(key, '').trim();
    const token = value('CLOUDFLARE_API_TOKEN');
    const accountId = value('CLOUDFLARE_ACCOUNT_ID');
    const zoneId = value('CLOUDFLARE_ZONE_ID');
    const tunnelId = value('CLOUDFLARE_TUNNEL_ID');
    const idpId = value('CLOUDFLARE_ACCESS_IDP_ID');
    if (!token || !accountId || !zoneId || !tunnelId || !idpId) {
      throw new ServiceUnavailableException(
        'Cloudflare 自动发布尚未配置完整，请补充服务器环境变量',
      );
    }
    return { token, accountId, zoneId, tunnelId, idpId };
  }

  private async cf<T>(path: string, method: string, body: unknown, token: string): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => null)) as CfResponse<T> | null;
    if (!response.ok || !payload?.success) {
      const detail = payload?.errors?.map((error) => error.message).filter(Boolean).join('；');
      throw new BadGatewayException(detail || `Cloudflare API 返回 ${response.status}`);
    }
    return payload.result;
  }
}
