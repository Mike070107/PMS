import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { request } from '@pms/api-client';
import { ErrorNote, Loading, toast } from '@/components/ui';
import { can } from '@/lib/perm';
import { Section, errMsg } from '@/components/settings/parts';
import {
  AutoReviewSection, EscalationSection, PhoneMatchSection, PurchaseChainSection, ServiceAccountSection, SubscribeSection,
  type SaveSettings, type TenantSettings,
} from '@/components/settings/general';
import { AiConfigSection, AiRulesSection, AiSamplesSection, AiUsageSection } from '@/components/settings/ai';
import { FeeTemplatesSection } from '@/components/settings/feeTemplates';
import ToneIcon from '@/components/ToneIcon';

type Group = 'fee' | 'order' | 'chain' | 'notice' | 'ai' | 'owner';
const GROUPS: Array<{ title: string; items: Array<[Group, string]> }> = [
  { title: '收费', items: [['fee', '收费标准']] },
  { title: '工单', items: [['order', '自动验收与催办'], ['ai', 'AI 填单助手']] },
  { title: '物资', items: [['chain', '采购审批链']] },
  { title: '通知', items: [['notice', '微信通知']] },
  { title: '业主', items: [['owner', '手机号快速识别']] },
];
const ALL = GROUPS.flatMap((g) => g.items.map(([k]) => k));

/**
 * 系统设置：左侧分组，右侧该组的全部设置，每项都能当场改（和旧后台同一套接口）。
 * 分组记在地址 ?g= 里，刷新或分享链接回到同一组。
 */
export default function Settings() {
  const canEdit = can('settings', 'edit');
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const group = (ALL.includes(params.get('g') as Group) ? params.get('g') : 'fee') as Group;
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setSettings(await request<TenantSettings>({ url: '/settings' })); setErr(''); }
    catch (e) { setErr(errMsg(e, '设置加载失败')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save: SaveSettings = async (patch, ok) => {
    try {
      const next = await request<TenantSettings>({ method: 'PATCH', url: '/settings', data: patch });
      setSettings(next); toast(ok); return next;
    } catch (e) { toast(errMsg(e, '保存失败，填写内容已保留')); return null; }
  };

  const body = () => {
    if (group === 'fee') return (
      <>
        <Section title="停车月租 / 门禁卡收费规则" desc="停车按「缴费规则分组」收费：每个分组一张价格表（缴费月数 → 金额），车牌归到分组；门禁卡按张定价。"
          extra={<button className="btn p" onClick={() => nav('/standards')}>打开收费规则</button>}>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>这部分有单独的页面，规则多、要预览计价，放在这里会太挤。</p>
        </Section>
        <FeeTemplatesSection canEdit={canEdit} />
      </>
    );
    if (group === 'ai') return <><AiConfigSection settings={settings!} save={save} canEdit={canEdit} /><AiSamplesSection canEdit={canEdit} /><AiRulesSection canEdit={canEdit} /><AiUsageSection /></>;
    if (!settings) return err ? null : <Loading />;
    const p = { settings, save, canEdit };
    if (group === 'order') return <><AutoReviewSection {...p} /><EscalationSection {...p} /></>;
    if (group === 'chain') return <PurchaseChainSection {...p} />;
    if (group === 'notice') return <><ServiceAccountSection {...p} /><SubscribeSection {...p} /></>;
    return <PhoneMatchSection {...p} />;
  };

  return (
    <>
      <div className="ph"><div><div className="h1row"><ToneIcon kind="settings" /><h1>系统设置</h1></div><p>{canEdit ? '改完点各块的「保存」立即生效' : '当前账号只能查看，不能修改'}</p></div></div>
      {err ? <ErrorNote>{err} <a style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => void load()}>重试</a></ErrorNote> : null}
      <div className="set-layout">
        <nav className="subnav" style={{ padding: '4px 0' }}>
          {GROUPS.map((g) => (
            <div key={g.title}>
              <h6>{g.title}</h6>
              {g.items.map(([k, n]) => <a key={k} className={group === k ? 'on' : ''} onClick={() => setParams({ g: k }, { replace: true })}>{n}</a>)}
            </div>
          ))}
        </nav>
        <div className="set-body">{group === 'ai' && !settings ? (err ? null : <Loading />) : body()}</div>
      </div>
    </>
  );
}
