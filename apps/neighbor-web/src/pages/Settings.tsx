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
import { AiConfigSection, AiRulesSection, AiSamplesSection, AiTrySection, AiUsageSection } from '@/components/settings/ai';
import { FeeTemplatesSection } from '@/components/settings/feeTemplates';
import ToneIcon from '@/components/ToneIcon';
import CollectionSmsSection from '@/components/settings/CollectionSmsSection';
import CollectionFollowupSection from '@/components/settings/CollectionFollowupSection';
import NoticeTemplateSection from '@/components/settings/NoticeTemplateSection';
import MisMirrorSection from '@/components/settings/MisMirrorSection';
import { DispatchNoticeSection } from '@/components/settings/DispatchNoticeSection';

type Group = 'fee' | 'order' | 'chain' | 'notice' | 'sms' | 'ai' | 'owner' | 'followup' | 'notice-template' | 'mirror';
const GROUPS: Array<{ title: string; items: Array<[Group, string]> }> = [
  { title: '收费', items: [['fee', '收费标准'], ['followup', '催收规则']] },
  { title: '工单', items: [['order', '派单通知与催办'], ['ai', 'AI 填单助手']] },
  { title: '物资', items: [['chain', '采购审批链']] },
  { title: '通知', items: [['notice', '微信通知'], ['sms', '催缴短信'], ['notice-template', '通知单模板']] },
  { title: '业主', items: [['owner', '手机号快速识别']] },
  { title: '数据', items: [['mirror', 'MIS 镜像']] },
];
const ALL = GROUPS.flatMap((g) => g.items.map(([k]) => k));

function AiAssistantPanel({ settings, save, canEdit }: { settings: TenantSettings; save: SaveSettings; canEdit: boolean }) {
  const [tab, setTab] = useState<'try' | 'samples' | 'rules' | 'config' | 'usage'>('try');
  const tabs = [
    ['try', '识别测试'], ['samples', '识别样例'], ['rules', '收费与纠错'],
    ['config', '模型配置'], ['usage', '调用统计'],
  ] as const;
  return <div className="ai-workspace">
    <div className="ai-workspace__intro">
      <div><h2>AI 填单助手</h2><p>测试报修原话、管理识别样例，核对模型配置和调用情况。</p></div>
      <span className={`ai-workspace__status ${settings.aiAssist.enabled ? 'is-on' : ''}`}>{settings.aiAssist.enabled ? '模型已开启' : '规则识别'}</span>
    </div>
    <div className="ai-workspace__tabs" role="tablist" aria-label="AI 填单助手功能">
      {tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div hidden={tab !== 'try'}><AiTrySection /></div>
    <div hidden={tab !== 'samples'}><AiSamplesSection canEdit={canEdit} /></div>
    <div hidden={tab !== 'rules'}><AiRulesSection canEdit={canEdit} /></div>
    <div hidden={tab !== 'config'}><AiConfigSection settings={settings} save={save} canEdit={canEdit} /></div>
    <div hidden={tab !== 'usage'}><AiUsageSection /></div>
  </div>;
}

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
    if (group === 'sms') return <CollectionSmsSection canEdit={canEdit} />;
    if (group === 'mirror') return <MisMirrorSection canEdit={canEdit} />;
    if (group === 'followup') return <CollectionFollowupSection canEdit={canEdit} />;
    if (group === 'notice-template') return <NoticeTemplateSection canEdit={canEdit} />;
    if (group === 'ai') return <AiAssistantPanel settings={settings!} save={save} canEdit={canEdit} />;
    if (!settings) return err ? null : <Loading />;
    const p = { settings, save, canEdit };
    if (group === 'order') return <><DispatchNoticeSection canEdit={canEdit} /><AutoReviewSection {...p} /><EscalationSection {...p} /></>;
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
