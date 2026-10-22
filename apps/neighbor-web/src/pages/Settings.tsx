import { useCallback, useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { Btn, Card, ErrorNote, Loading, toast } from '@/components/ui';
import { money } from '@/lib/format';

interface TenantSettings {
  ownerPhoneAutoMatch: { enabled: boolean };
  wxSubscribeTemplates: Record<string, string>;
  autoReview: { hours: number };
  purchaseApproval?: {
    office: 'summary' | 'approve' | 'off';
    manager: boolean;
    purchaser: boolean;
    skipManagerBelowYuan: number;
    skipPurchaserBelowYuan: number;
  };
  dispatchEscalation: { enabled: boolean; acceptMinutes: number; startAt: string; endAt: string };
  wxServiceAccount: { enabled: boolean; appId: string };
}

interface BusinessRule {
  id: number; serviceType: 'parking_monthly' | 'access_card'; name: string;
  communityId: number | null; billingUnit: 'month' | 'card'; unitPriceCents: number; enabled: boolean;
}
interface StandardRow {
  id: number; communityName: string; buildingNo: string; roomNo: string;
  feeName: string; amountCents: number; effectiveFrom: string; status: string;
}

type Group = 'order' | 'fee' | 'chain' | 'notice' | 'owner';

const GROUPS: Array<{ title: string; items: Array<[Group, string]> }> = [
  { title: '工单', items: [['order', '自动验收与超时催办']] },
  { title: '收费', items: [['fee', '收费标准与规则']] },
  { title: '物资', items: [['chain', '采购审批链']] },
  { title: '通知', items: [['notice', '微信订阅消息']] },
  { title: '业主', items: [['owner', '手机号快速识别']] },
];

const OFFICE_LABEL = { summary: '办公室汇总', approve: '办公室审批', off: '不经过办公室' } as const;

/**
 * 系统设置：左侧分组，右侧一块内容。
 * 只把能读、能安全改的做进来：手机号快速识别可当场开关（PATCH /settings），
 * 其余项这里是只读概览 + 去现有设置页改，避免两套界面写出不一致的配置。
 */
export default function Settings() {
  const [group, setGroup] = useState<Group>('fee');
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [rules, setRules] = useState<BusinessRule[] | null>(null);
  const [standards, setStandards] = useState<StandardRow[] | null>(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, r, std] = await Promise.all([
        request<TenantSettings>({ url: '/settings' }),
        request<BusinessRule[]>({ url: '/business/rules' }).catch(() => [] as BusinessRule[]),
        request<{ rows: StandardRow[] }>({ url: '/fees/standards', query: { status: 'active', page: 1, pageSize: 20 } })
          .catch(() => ({ rows: [] as StandardRow[] })),
      ]);
      setSettings(s);
      setRules(r);
      setStandards(std.rows);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '设置加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const togglePhoneMatch = async (enabled: boolean) => {
    setSaving(true);
    try {
      const next = await request<TenantSettings>({
        method: 'PATCH', url: '/settings', data: { ownerPhoneAutoMatch: { enabled } },
      });
      setSettings(next);
      toast(enabled ? '已开启手机号快速识别' : '已关闭');
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!settings && !err) return <Loading />;

  const chain = settings?.purchaseApproval;
  const tplKeys = Object.keys(settings?.wxSubscribeTemplates || {});
  const tplConfigured = tplKeys.filter((k) => (settings?.wxSubscribeTemplates[k] || '').trim()).length;

  return (
    <>
      <div className="ph"><div><h1>系统设置</h1><p>每类配置一个分组，收银台和工单页只读取这里的值</p></div>
        <div className="act"><button className="btn" onClick={() => { window.location.href = '/settings'; }}>打开现有设置页</button></div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="set" style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, alignItems: 'start' }}>
        <div className="subnav" style={{ padding: '4px 0' }}>
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h6>{g.title}</h6>
              {g.items.map(([k, n]) => (
                <a key={k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)} style={{ cursor: 'pointer' }}>{n}</a>
              ))}
            </div>
          ))}
        </div>

        <Card style={{ padding: '20px 22px' }}>
          {group === 'fee' ? (
            <>
              <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>收费标准与规则</h2>
              <p className="muted" style={{ margin: '0 0 16px' }}>物业费按户标准、停车月租、门禁卡单价统一在这里维护，收银台只读取</p>

              <div className="sec-t">停车月租 / 门禁卡（前台收费规则）</div>
              {rules === null ? <Loading text="读取规则…" /> : rules.length ? (
                <table className="t" style={{ marginBottom: 20 }}>
                  <thead><tr><th>项目</th><th>名称</th><th>适用范围</th><th style={{ textAlign: 'right' }}>单价</th><th>状态</th></tr></thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id}>
                        <td><b>{r.serviceType === 'parking_monthly' ? '停车月租' : '门禁卡'}</b></td>
                        <td className="sub">{r.name}</td>
                        <td className="sub">{r.communityId == null ? '全部小区' : `小区 #${r.communityId}`}</td>
                        <td style={{ textAlign: 'right' }}>{money(r.unitPriceCents / 100)} / {r.billingUnit === 'month' ? '月' : '张'}</td>
                        <td>{r.enabled ? <span className="pill s-done">启用</span> : <span className="pill s-off">停用</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="empty" style={{ padding: 18 }}>还没有配置前台收费规则</div>}

              <div className="sec-t">物业费标准<span className="r muted">生效中，前 20 条</span></div>
              {standards === null ? <Loading text="读取标准…" /> : standards.length ? (
                <table className="t">
                  <thead><tr><th>小区 / 房号</th><th>项目</th><th style={{ textAlign: 'right' }}>金额</th><th>生效</th></tr></thead>
                  <tbody>
                    {standards.map((s) => (
                      <tr key={s.id}>
                        <td><b>{s.communityName} {s.buildingNo}/{s.roomNo}</b></td>
                        <td className="sub">{s.feeName}</td>
                        <td style={{ textAlign: 'right' }}>{money(s.amountCents / 100)}</td>
                        <td className="muted">{s.effectiveFrom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="empty" style={{ padding: 18 }}>没有生效中的物业费标准</div>}
              <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>新增 / 调整标准在现有设置页与物业费页，这里只读。</p>
            </>
          ) : null}

          {group === 'chain' ? (
            <>
              <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>采购审批链</h2>
              {chain ? (
                <>
                  {[
                    ['办公室', OFFICE_LABEL[chain.office] || chain.office],
                    ['物业经理审批', chain.manager ? (chain.skipManagerBelowYuan > 0 ? `${money(chain.skipManagerBelowYuan)} 及以上` : '必经') : '关闭'],
                    ['采购经理审批', chain.purchaser ? (chain.skipPurchaserBelowYuan > 0 ? `${money(chain.skipPurchaserBelowYuan)} 及以上` : '必经') : '关闭'],
                  ].map(([a, b], i) => (
                    <div key={a} className="bill" style={{ padding: '12px 0', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line2)' }}>
                      <span className="step-n">{i + 1}</span><b>{a}</b><span className="muted">{b}</span>
                    </div>
                  ))}
                  <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                    审批链决定「采购流程」页里每一格是否出现；金额低于阈值时该环节自动跳过。
                  </p>
                </>
              ) : <div className="empty">服务端还没有下发审批链配置</div>}
              <Btn style={{ marginTop: 12 }} onClick={() => { window.location.href = '/settings'; }}>去调整</Btn>
            </>
          ) : null}

          {group === 'order' ? (
            <>
              <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>自动验收与超时催办</h2>
              <div className="facts">
                <div><small>自动验收</small><b>{settings?.autoReview?.hours ? `${settings.autoReview.hours} 小时后` : '关闭'}</b></div>
                <div><small>催办开关</small><b>{settings?.dispatchEscalation?.enabled ? '已开启' : '关闭'}</b></div>
                <div><small>接单时限</small><b>{settings?.dispatchEscalation?.acceptMinutes ? `${settings.dispatchEscalation.acceptMinutes} 分钟` : '—'}</b></div>
                <div><small>催办时段</small><b>{settings?.dispatchEscalation ? `${settings.dispatchEscalation.startAt}–${settings.dispatchEscalation.endAt}` : '—'}</b></div>
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
                工单超时后系统在催办时段内自动发微信给维修工和办公室；自动验收到期未评价的工单会按默认好评结束。
              </p>
              <Btn style={{ marginTop: 12 }} onClick={() => { window.location.href = '/settings'; }}>去调整</Btn>
            </>
          ) : null}

          {group === 'notice' ? (
            <>
              <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>微信订阅消息</h2>
              <div className="kpis" style={{ marginBottom: 14 }}>
                <div><small>订阅模板</small><b>{tplConfigured} / {tplKeys.length || 5}</b><em>未配的不会推送</em></div>
                <div><small>服务号</small><b>{settings?.wxServiceAccount?.enabled ? '已开启' : '未开启'}</b><em>{settings?.wxServiceAccount?.appId || '未配置 AppID'}</em></div>
              </div>
              <table className="t">
                <thead><tr><th>模板</th><th>状态</th></tr></thead>
                <tbody>
                  {[
                    ['orderDispatched', '工单派单通知'],
                    ['orderReview', '完工待验收'],
                    ['orderAssigned', '新工单派给维修工'],
                    ['orderOverdue', '超时未接单催办'],
                    ['orderUrge', '办公室催修'],
                  ].map(([k, label]) => {
                    const v = (settings?.wxSubscribeTemplates?.[k] || '').trim();
                    return (
                      <tr key={k}>
                        <td><b>{label}</b><div className="muted" style={{ fontSize: 12 }}>{k}</div></td>
                        <td>{v ? <span className="pill s-done">已配置</span> : <span className="pill s-pend">未配置</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <Btn style={{ marginTop: 12 }} onClick={() => { window.location.href = '/settings'; }}>去配置模板</Btn>
            </>
          ) : null}

          {group === 'owner' ? (
            <>
              <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>手机号快速识别</h2>
              <p className="muted" style={{ margin: '0 0 16px' }}>
                开启后业主在小程序报修时，用手机号就能认出是哪一户，不用再选小区楼栋房号。
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="seg">
                  <button className={settings?.ownerPhoneAutoMatch?.enabled ? 'on' : ''} disabled={saving}
                    onClick={() => void togglePhoneMatch(true)}>开启</button>
                  <button className={!settings?.ownerPhoneAutoMatch?.enabled ? 'on' : ''} disabled={saving}
                    onClick={() => void togglePhoneMatch(false)}>关闭</button>
                </div>
                <span className="muted">{saving ? '保存中…' : settings?.ownerPhoneAutoMatch?.enabled ? '当前：已开启' : '当前：已关闭'}</span>
              </div>
            </>
          ) : null}
        </Card>
      </div>
    </>
  );
}
