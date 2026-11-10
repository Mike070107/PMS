import { useCallback, useEffect, useRef, useState } from 'react';
import { repairs, request } from '@pms/api-client';
import { classifyRepairType } from '@pms/shared-types';
import { ConfirmModal, toast } from '@/components/ui';
import { FormModal, ResultNote, Row, Section, Stat, Toggle, errMsg, yuan } from './parts';
import type { SaveSettings, TenantSettings } from './general';

/** 使用正式填单解析接口和当前公司类型词表，展示两者各自结果。 */
export function AiTrySection() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ rule: string; matched: string[]; ai: string; description: string; sample: boolean } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const run = async () => {
    if (!text.trim()) { setError('请输入要测试的报修原话'); input.current?.focus(); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const [types, parsed] = await Promise.all([repairs.types(), repairs.parseAddress({ text: text.trim() })]);
      const hit = classifyRepairType(text, types);
      const aiType = types.find((type) => type.repairType === parsed.ai?.repairType);
      setResult({ rule: hit?.label || '未识别', matched: hit?.matched || [], ai: aiType?.label || '未返回类型', description: parsed.ai?.description || '', sample: !!parsed.ai?.sampleMatched });
    } catch (e) { setError(errMsg(e, '识别测试失败')); }
    finally { setBusy(false); }
  };
  return <Section title="测试一句报修" desc="使用当前公司的类型词表和正式填单解析接口；结果仅供检查，不会创建工单。">
    <label htmlFor="ai-try-text" className="dispatch-notice__label">报修原话 <span className="dispatch-notice__required">*</span></label>
    <textarea id="ai-try-text" ref={input} className={`in ai-try__input ${error && !text.trim() ? 'ai-try__input--error' : ''}`} value={text} disabled={busy} aria-invalid={!!error && !text.trim()} aria-describedby="ai-try-error" onChange={(e) => { setText(e.target.value); setError(''); }} />
    {error ? <p id="ai-try-error" className="dispatch-notice__error" role="alert">{error}</p> : null}
    <button type="button" className="btn p" disabled={busy} onClick={() => void run()}>{busy ? '识别中…' : '开始识别'}</button>
    {result ? <div className="ai-try__result" aria-live="polite">
      <div><span>关键词判断</span><b>{result.rule}</b><small>{result.matched.length ? `命中 ${result.matched.join('、')}` : '没有命中关键词'}</small></div>
      <div><span>填单解析返回</span><b>{result.ai}</b><small>{result.sample ? '命中已确认样例' : result.description || '未返回故障描述'}</small></div>
    </div> : null}
    <p className="muted">测试按公司词表展示。实际派单还会核对报修小区所属管理处的启用类型及维修工配置。</p>
  </Section>;
}

/* ───────── AI 维修填单助手：接口配置 ───────── */
export function AiConfigSection({ settings, save, canEdit }: { settings: TenantSettings; save: SaveSettings; canEdit: boolean }) {
  const [ai, setAi] = useState(settings.aiAssist);
  const [busy, setBusy] = useState('');
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => setAi(settings.aiAssist), [settings.aiAssist]);
  const dirty = JSON.stringify(ai) !== JSON.stringify(settings.aiAssist);
  const num = (k: keyof typeof ai, v: string, f = (x: number) => x) => setAi({ ...ai, [k]: f(Math.max(0, Number(v) || 0)) });
  const test = async () => {
    setBusy('test'); setRes(null);
    try {
      const r = await request<{ ok: boolean; reply?: string; error?: string; model?: string }>({ method: 'POST', url: '/settings/ai/test', data: ai });
      setRes(r.ok ? { ok: true, message: `连通正常（${r.model}）：${r.reply || ''}` } : { ok: false, message: r.error || '调用失败' });
    } catch (e) { setRes({ ok: false, message: errMsg(e, '请求失败') }); }
    finally { setBusy(''); }
  };
  return (
    <Section title="AI 维修填单助手"
      desc={ai.enabled ? `已开启：${ai.model}（${ai.baseUrl}）` : '未开启：只用内置规则识别，行为和以前一样'}
      extra={<Toggle on={ai.enabled} disabled={!canEdit} onChange={(enabled) => setAi({ ...ai, enabled })} label={['已开启', '已关闭']} />}>
      <p style={{ margin: '0 0 12px', lineHeight: 1.7 }}>
        报修人说一句「5511弄236号502电子门旋钮打滑，急，138…」，系统把<b>地址、故障、联系人、电话、报修类型</b>分开填好；维修工完工后说一句做了什么，系统再整理<b>位置、现象、说明、用料草稿和收费建议</b>。
      </p>
      <div className="set-note">
        <b>门牌和电话仍由系统自己定。</b>模型给的地址只当线索，要回房产库里撞一遍，撞不上不采信；电话仍按 11 位严格抽取。用料必须匹配真实材料 SKU，收费只能选下面已有的规则。调不通、超时时自动退回规则识别，不会因此提交不了报修。
      </div>
      <Row label="接口地址" hint={<>OpenAI 兼容协议（自动拼 /v1/chat/completions）。DeepSeek、通义千问、智谱、Moonshot、本地 ollama 都能填。</>}>
        <input className="in" value={ai.baseUrl} disabled={!canEdit} placeholder="https://api.deepseek.com" onChange={(e) => setAi({ ...ai, baseUrl: e.target.value })} />
      </Row>
      <Row label="模型名" hint={ai.baseUrl.includes('deepseek.com') && ai.model === 'deepseek-chat' ? '当前仍是 DeepSeek 旧兼容模型名，建议改为 deepseek-v4-flash，先点「发送测试」通过再保存。' : undefined}>
        <input className="in" value={ai.model} disabled={!canEdit} placeholder="deepseek-v4-flash" onChange={(e) => setAi({ ...ai, model: e.target.value })} />
      </Row>
      <Row label="API Key" hint="保存后只回显后 4 位；密钥只存在服务器，换了接口地址会要求重填">
        <input className="in" type="password" autoComplete="new-password" value={ai.apiKey} disabled={!canEdit} placeholder="留空 = 保持原有密钥不变" onChange={(e) => setAi({ ...ai, apiKey: e.target.value })} />
      </Row>
      <Row label="超时">
        <div className="set-inline"><input className="in" type="number" min={1} max={30} style={{ width: 90 }} value={Math.round(ai.timeoutMs / 1000)} disabled={!canEdit}
          onChange={(e) => num('timeoutMs', e.target.value, (x) => Math.round(Math.min(30, Math.max(1, x || 6)) * 1000))} /><span>秒，超过就退回规则识别</span></div>
      </Row>
      <Row label="结果缓存">
        <div className="set-inline"><input className="in" type="number" min={0} max={3650} style={{ width: 90 }} value={ai.cacheDays} disabled={!canEdit} onChange={(e) => num('cacheDays', e.target.value, Math.round)} /><span>天内同一句话直接复用上次结果（0 = 关闭）</span></div>
      </Row>
      <Row label="单价" hint="元 / 百万 token，照服务商官网价格填，不填就只看 token 数不估钱">
        <div className="set-inline">
          <span>输入·未命中缓存</span><input className="in" type="number" min={0} step="0.1" style={{ width: 90 }} value={ai.priceInputMissPerM} disabled={!canEdit} onChange={(e) => num('priceInputMissPerM', e.target.value)} />
          <span>输入·命中缓存</span><input className="in" type="number" min={0} step="0.1" style={{ width: 90 }} value={ai.priceInputHitPerM} disabled={!canEdit} onChange={(e) => num('priceInputHitPerM', e.target.value)} />
          <span>输出</span><input className="in" type="number" min={0} step="0.1" style={{ width: 90 }} value={ai.priceOutputPerM} disabled={!canEdit} onChange={(e) => num('priceOutputPerM', e.target.value)} />
        </div>
      </Row>
      {canEdit ? (
        <div className="set-actions">
          <button className="btn p" disabled={!dirty || !!busy} onClick={async () => { setBusy('save'); const n = await save({ aiAssist: ai }, '已保存'); if (n) setAi(n.aiAssist); setBusy(''); }}>{busy === 'save' ? '保存中…' : '保存'}</button>
          <button className="btn" disabled={!!busy} onClick={() => void test()}>{busy === 'test' ? '测试中…' : '发送测试'}</button>
        </div>
      ) : null}
      {res ? <ResultNote ok={res.ok}>{res.message}</ResultNote> : null}
      <p className="muted" style={{ fontSize: 13.5, margin: '12px 0 0' }}>报修原话可能含住户姓名、电话和门牌，请使用符合公司数据合规要求的服务。</p>
    </Section>
  );
}

/* ───────── 识别样例 ───────── */
interface AiSample { id: number; kind: string; text: string; note: string; enabled: boolean; expected: Record<string, unknown> }
type SampleKind = 'repair' | 'completion';
const SAMPLE_FIELDS: Record<SampleKind, Array<{ key: string; label: string; ph: string; hint?: string }>> = {
  repair: [
    { key: 'repairType', label: '应该识别成的报修类型', ph: '' },
    { key: 'addressText', label: '应该认出的地址', ph: '5511弄，236号，502', hint: '照抄原话里表示地点的那一段；真正的门牌仍要回房产库里撞。' },
    { key: 'publicArea', label: '故障区域', ph: '', hint: '按坏的设施判断：住户说了房号，但坏的是楼下门、门口机时选公共区域。' },
    { key: 'description', label: '应该认出的故障描述', ph: '电子门旋钮打滑，居民出不去' },
    { key: 'contactName', label: '应该认出的联系人', ph: '没说人名就留空' },
    { key: 'phone', label: '应该认出的联系电话', ph: '18201728748', hint: '门牌号里的数字不能当电话。' },
  ],
  completion: [
    { key: 'actionNote', label: '应该整理成的维修说明', ph: '更换角阀一只；水管接头加缠生料带', hint: '业主会看到这一句，只写实际做了什么。' },
    { key: 'faultLocation', label: '应该认出的故障位置', ph: '厨房水槽下方' },
    { key: 'faultSymptom', label: '应该认出的故障现象', ph: '角阀锈蚀卡死' },
    { key: 'materials', label: '应该认出的用料', ph: '角阀、生料带（顿号分隔，只写名字）', hint: '会加进用料清单当草稿行，仍要绑 SKU 才扣库存。' },
  ],
};
const EXP_LABEL: Record<string, string> = { addressText: '地址', description: '描述', contactName: '联系人', phone: '电话', actionNote: '维修说明', faultLocation: '位置', faultSymptom: '现象', materials: '用料' };

function useRepairTypes() {
  const [types, setTypes] = useState<Array<{ repairType: string; label: string }>>([]);
  useEffect(() => { request<Array<{ repairType: string; label: string }>>({ url: '/repair-types' }).then(setTypes).catch(() => setTypes([])); }, []);
  return types;
}

export function AiSamplesSection({ canEdit }: { canEdit: boolean }) {
  const [kind, setKind] = useState<SampleKind>('repair');
  const [rows, setRows] = useState<AiSample[] | null>(null);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AiSample | null>(null);
  const types = useRepairTypes();
  const load = useCallback(() => { request<AiSample[]>({ url: `/settings/ai/samples?kind=${kind}` }).then(setRows).catch((e) => { toast(errMsg(e, '加载样例失败')); setRows([]); }); }, [kind]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const add = async () => {
    if (!draft) return;
    if (!draft.text?.trim()) return toast('先把「这句话」填上');
    if (kind === 'repair' && !draft.repairType) return toast('请选择应该识别成的报修类型');
    setBusy(true);
    try {
      const expected = Object.fromEntries(SAMPLE_FIELDS[kind].map((f) => [f.key,
        f.key === 'materials' ? (draft.materials || '').split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean)
          : f.key === 'publicArea' ? (draft.publicArea === 'true' ? true : draft.publicArea === 'false' ? false : undefined)
            : draft[f.key]?.trim()]).filter(([, v]) => (Array.isArray(v) ? v.length : v !== undefined && v !== '')));
      await request({ method: 'POST', url: '/settings/ai/samples', data: { kind, text: draft.text, note: draft.note || '', expected } });
      setDraft(null); load(); toast('加好了，下一次识别就会带上它');
    } catch (e) { toast(errMsg(e, '保存失败')); }
    finally { setBusy(false); }
  };
  const patch = async (r: AiSample, enabled: boolean) => { try { await request({ method: 'PATCH', url: `/settings/ai/samples/${r.id}`, data: { enabled } }); load(); } catch (e) { toast(errMsg(e, '操作失败')); } };
  const typeLabel = (v: unknown) => types.find((t) => t.repairType === v)?.label || String(v);
  return (
    <Section title="识别样例" desc="保存原话和期望结果。完全相同的原话优先使用已启用样例；其他说法会优先选取相似样例供模型参考，最多 20 条。样例有误时可以先停用。"
      extra={canEdit ? <button className="btn" onClick={() => setDraft({})}>＋ 加一条样例</button> : undefined}>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={kind === 'repair' ? 'on' : ''} onClick={() => setKind('repair')}>一句话报修</button>
        <button className={kind === 'completion' ? 'on' : ''} onClick={() => setKind('completion')}>完工小结</button>
      </div>
      {rows === null ? <div className="empty">加载中…</div> : !rows.length ? <div className="empty">还没有样例</div> : (
        <table className="t">
          <thead><tr><th>这句话</th><th style={{ width: '38%' }}>应该认成</th><th style={{ width: 90 }}>启用</th>{canEdit ? <th style={{ width: 70 }} /> : null}</tr></thead>
          <tbody>{rows.map((r) => {
            const e = r.expected || {};
            return (
              <tr key={r.id}>
                <td>{r.text}{r.note ? <div className="sub2">{r.note}</div> : null}</td>
                <td><div className="set-tags">
                  {e.repairType ? <span className="acc">类型 {typeLabel(e.repairType)}</span> : null}
                  {typeof e.publicArea === 'boolean' ? <span className={e.publicArea ? 'acc' : 'ok'}>{e.publicArea ? '公共区域' : '住户户内'}</span> : null}
                  {Object.entries(EXP_LABEL).map(([k, l]) => { const v = e[k]; if (!v || (Array.isArray(v) && !v.length)) return null; return <span key={k}>{l} {Array.isArray(v) ? v.join('、') : String(v)}</span>; })}
                  {e.urgent ? <span className="dang">紧急</span> : null}
                </div></td>
                <td><Toggle on={r.enabled} disabled={!canEdit} onChange={(v) => void patch(r, v)} /></td>
                {canEdit ? <td><button className="btn g sm" style={{ color: 'var(--dang)' }} onClick={() => setRemoving(r)}>删除</button></td> : null}
              </tr>
            );
          })}</tbody>
        </table>
      )}
      <FormModal open={!!draft} title={`加一条样例 · ${kind === 'repair' ? '一句话报修' : '完工小结'}`} onClose={() => setDraft(null)} onOk={() => void add()} busy={busy}>
        {draft ? <>
          <label>这句话（原话照抄）<textarea className="in" rows={2} value={draft.text || ''} placeholder={kind === 'completion' ? '换了个角阀，原来那个锈死了' : '5511弄，236号，502报修电子门里面，旋钮打滑'} onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></label>
          {SAMPLE_FIELDS[kind].map((f) => (
            <label key={f.key}>{f.label}
              {f.key === 'repairType' ? (
                <select className="in" value={draft.repairType || ''} onChange={(e) => setDraft({ ...draft, repairType: e.target.value })}><option value="">请选择报修类型</option>{types.map((t) => <option key={t.repairType} value={t.repairType}>{t.label}</option>)}</select>
              ) : f.key === 'publicArea' ? (
                <select className="in" value={draft.publicArea || ''} onChange={(e) => setDraft({ ...draft, publicArea: e.target.value })}><option value="">不指定</option><option value="true">公共区域（楼下门、门口机、单元门等）</option><option value="false">住户户内</option></select>
              ) : <input className="in" value={draft[f.key] || ''} placeholder={f.ph} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />}
              {f.hint ? <span className="hint">{f.hint}</span> : null}
            </label>
          ))}
          <label>备注<input className="in" value={draft.note || ''} placeholder="为什么加这条，如：语音把弄号断成了两段" onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
        </> : null}
      </FormModal>
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} title="删掉这条样例？" danger confirmText="删除"
        onConfirm={async () => { const r = removing!; setRemoving(null); try { await request({ method: 'DELETE', url: `/settings/ai/samples/${r.id}` }); load(); toast('已删除'); } catch (e) { toast(errMsg(e, '删除失败')); } }}>
        教错了也可以只关掉，留着能看出当初为什么这么教。
      </ConfirmModal>
    </Section>
  );
}

/* ───────── 维修收费规则 + 人工纠错 ───────── */
interface FeeRule { id: number; code: string; name: string; repairType: string | null; officeId: number | null; keywords: string[]; feeCents: number; enabled: boolean }
interface Feedback { id: number; kind: 'repair' | 'completion'; sourceText: string; fieldDiff: Record<string, { before: unknown; after: unknown }>; createdAt: string }
const show = (v: unknown) => (Array.isArray(v) ? v.join('、') || '空' : v === null || v === undefined || v === '' ? '空' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function AiRulesSection({ canEdit }: { canEdit: boolean }) {
  const types = useRepairTypes();
  const [offices, setOffices] = useState<Array<{ id: number; name: string }>>([]);
  const [rules, setRules] = useState<FeeRule[] | null>(null);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [edit, setEdit] = useState<{ row: FeeRule | null; code: string; name: string; repairType: string; officeId: string; keywords: string; feeYuan: string; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<FeeRule | null>(null);
  const load = useCallback(async () => {
    try {
      const [r, f] = await Promise.all([request<FeeRule[]>({ url: '/settings/ai/fee-rules' }), request<Feedback[]>({ url: '/settings/ai/feedback?status=pending' })]);
      setRules(r); setFeedback(f);
    } catch (e) { toast(errMsg(e, '加载 AI 学习配置失败')); setRules([]); }
  }, []);
  useEffect(() => { void load(); request<Array<{ id: number; name: string }>>({ url: '/repair-type-rules/offices' }).then(setOffices).catch(() => setOffices([])); }, [load]);
  const open = (row?: FeeRule) => setEdit(row
    ? { row, code: row.code, name: row.name, repairType: row.repairType || '', officeId: row.officeId ? String(row.officeId) : '', keywords: (row.keywords || []).join('、'), feeYuan: String(row.feeCents / 100), enabled: row.enabled }
    : { row: null, code: '', name: '', repairType: '', officeId: '', keywords: '', feeYuan: '', enabled: true });
  const saveRule = async () => {
    if (!edit) return;
    const fee = Number(edit.feeYuan);
    if (!edit.code.trim() || !edit.name.trim() || edit.feeYuan === '' || !Number.isFinite(fee) || fee < 0) return toast('请填规则编码、名称和金额');
    setBusy(true);
    try {
      await request({ method: edit.row ? 'PATCH' : 'POST', url: edit.row ? `/settings/ai/fee-rules/${edit.row.id}` : '/settings/ai/fee-rules',
        data: { code: edit.code.trim(), name: edit.name.trim(), repairType: edit.repairType || undefined, officeId: edit.officeId ? Number(edit.officeId) : undefined,
          keywords: edit.keywords.split(/[、,，\s]+/).map((v) => v.trim()).filter(Boolean), feeCents: Math.round(fee * 100), enabled: edit.enabled } });
      setEdit(null); void load(); toast('收费规则已保存');
    } catch (e) { toast(errMsg(e, '保存失败（规则编码不能重复）')); }
    finally { setBusy(false); }
  };
  const toggle = async (r: FeeRule, enabled: boolean) => { try { await request({ method: 'PATCH', url: `/settings/ai/fee-rules/${r.id}`, data: { ...r, enabled } }); void load(); } catch (e) { toast(errMsg(e, '操作失败')); } };
  const review = async (r: Feedback, action: 'promote' | 'ignore') => {
    try { await request({ method: 'POST', url: `/settings/ai/feedback/${r.id}/${action}` }); void load(); toast(action === 'promote' ? '已收为正式识别样例' : '已忽略这次修改'); }
    catch (e) { toast(errMsg(e, '操作失败')); }
  };
  return (
    <>
      <Section title="维修收费规则" desc="AI 只能从这里选收费建议，不能自己编金额。没有匹配规则时收费栏保持空白，最终仍由维修工确认。"
        extra={canEdit ? <button className="btn" onClick={() => open()}>＋ 新增收费规则</button> : undefined}>
        {rules === null ? <div className="empty">加载中…</div> : !rules.length ? <div className="empty">还没有收费规则</div> : (
          <table className="t">
            <thead><tr><th>规则</th><th>适用范围</th><th style={{ textAlign: 'right', width: 110 }}>建议金额</th><th style={{ width: 90 }}>启用</th>{canEdit ? <th style={{ width: 120 }} /> : null}</tr></thead>
            <tbody>{rules.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b><div className="sub2">{r.code}</div></td>
                <td><div className="set-tags">
                  <span className={r.officeId ? 'acc' : ''}>{offices.find((o) => o.id === r.officeId)?.name || '公司通用'}</span>
                  <span>{types.find((t) => t.repairType === r.repairType)?.label || '全部类型'}</span>
                  {(r.keywords || []).map((w) => <span key={w}>{w}</span>)}
                </div></td>
                <td className="nw" style={{ textAlign: 'right' }}>{yuan(r.feeCents)}</td>
                <td><Toggle on={r.enabled} disabled={!canEdit} onChange={(v) => void toggle(r, v)} /></td>
                {canEdit ? <td><div className="set-inline"><button className="btn g sm" onClick={() => open(r)}>编辑</button><button className="btn g sm" style={{ color: 'var(--dang)' }} onClick={() => setRemoving(r)}>删除</button></div></td> : null}
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      <Section title={`待审核的人工纠错（${feedback.length}）`} desc="系统比较原始语音、AI 草稿和人工最终提交。同一句原话在两张工单里被改成相同结果会自动收为样例；只出现一次或结果冲突的留在这里人工审核，避免误操作教错系统。">
        {!feedback.length ? <div className="empty">暂无待审核纠错</div> : (
          <table className="t">
            <thead><tr><th>原话</th><th style={{ width: '42%' }}>人工改了什么</th>{canEdit ? <th style={{ width: 170 }} /> : null}</tr></thead>
            <tbody>{feedback.map((r) => (
              <tr key={r.id}>
                <td><span className="set-tags" style={{ display: 'inline-flex', marginRight: 6 }}><span>{r.kind === 'repair' ? '报修' : '完工'}</span></span>{r.sourceText}</td>
                <td>{Object.entries(r.fieldDiff || {}).map(([k, v]) => <div key={k} style={{ fontSize: 13.5 }}>{k}：{show(v.before)} → <b>{show(v.after)}</b></div>)}</td>
                {canEdit ? <td><div className="set-inline"><button className="btn sm" onClick={() => void review(r, 'promote')}>收为样例</button><button className="btn g sm" onClick={() => void review(r, 'ignore')}>忽略</button></div></td> : null}
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>
      <FormModal open={!!edit} title={edit?.row ? '编辑维修收费规则' : '新增维修收费规则'} onClose={() => setEdit(null)} onOk={() => void saveRule()} busy={busy}>
        {edit ? <>
          <label>规则编码<input className="in" value={edit.code} disabled={!!edit.row} placeholder="如 replace_angle_valve" onChange={(e) => setEdit({ ...edit, code: e.target.value })} /><span className="hint">保存后不能改，同一公司内不能重复</span></label>
          <label>规则名称<input className="in" value={edit.name} placeholder="如 更换普通角阀" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
          <label>适用报修类型<select className="in" value={edit.repairType} onChange={(e) => setEdit({ ...edit, repairType: e.target.value })}><option value="">全部类型</option>{types.map((t) => <option key={t.repairType} value={t.repairType}>{t.label}</option>)}</select></label>
          <label>适用管理处<select className="in" value={edit.officeId} onChange={(e) => setEdit({ ...edit, officeId: e.target.value })}><option value="">公司通用</option>{offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label>适用词<input className="in" value={edit.keywords} placeholder="如 更换角阀、换角阀（顿号分隔）" onChange={(e) => setEdit({ ...edit, keywords: e.target.value })} /></label>
          <div className="set-inline"><span style={{ fontWeight: 600 }}>建议金额（元）</span><input className="in" type="number" min={0} step="0.01" style={{ width: 130 }} value={edit.feeYuan} onChange={(e) => setEdit({ ...edit, feeYuan: e.target.value })} />
            <Toggle on={edit.enabled} onChange={(enabled) => setEdit({ ...edit, enabled })} label={['启用', '停用']} /></div>
        </> : null}
      </FormModal>
      <ConfirmModal open={!!removing} onClose={() => setRemoving(null)} title={`删除收费规则「${removing?.name ?? ''}」？`} danger confirmText="删除"
        onConfirm={async () => { const r = removing!; setRemoving(null); try { await request({ method: 'DELETE', url: `/settings/ai/fee-rules/${r.id}` }); void load(); toast('收费规则已删除'); } catch (e) { toast(errMsg(e, '删除失败')); } }}>
        删除后 AI 不再推荐这条收费。只是暂时不用的话，关掉「启用」即可。
      </ConfirmModal>
    </>
  );
}

/* ───────── 用量月账 ───────── */
interface Usage {
  month: string; calls: number; okCalls: number; failedCalls: number; localCacheHits: number; promptTokens: number; promptCacheHitTokens: number;
  completionTokens: number; providerCacheRatio: number; estimatedCostYuan: number | null;
  byKind: Array<{ kind: string; calls: number; localCacheHits: number; promptTokens: number; completionTokens: number }>;
}
const KIND_LABELS: Record<string, string> = { 'repair-parse': '一句话报修解析', 'completion-summary': '完工小结', 'material-receipt': '入库单识别', 'material-profile': '材料档案识别', test: '连通性测试', other: '其他' };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const shift = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const fmt = (n: number) => n.toLocaleString('zh-CN');

export function AiUsageSection() {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<Usage | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback((m: string) => { setErr(''); request<Usage>({ url: `/settings/ai/usage?month=${m}` }).then(setData).catch((e) => setErr(errMsg(e, '加载用量失败'))); }, []);
  useEffect(() => load(month), [month, load]);
  return (
    <Section title="用量月账" desc="按 token 计费。「本系统缓存」是同一句话在缓存天数内直接复用、没打服务商；「服务商缓存」是服务商按提示词前缀自动打折的输入。填了单价才估算费用。"
      extra={<div className="set-inline">
        <button className="btn sm" onClick={() => setMonth((m) => shift(m, -1))}>上月</button>
        <b style={{ fontVariantNumeric: 'tabular-nums' }}>{month}</b>
        <button className="btn sm" disabled={month >= thisMonth()} onClick={() => setMonth((m) => shift(m, 1))}>下月</button>
        <button className="btn sm" onClick={() => load(month)}>刷新</button>
      </div>}>
      {err ? <ResultNote ok={false}>{err}</ResultNote> : null}
      {data ? <>
        <div className="set-stats">
          <Stat label="调用次数" value={fmt(data.calls)} hint={`打到服务商 ${fmt(data.calls - data.localCacheHits)} 次`} />
          <Stat label="本系统缓存命中" value={fmt(data.localCacheHits)} hint={data.calls ? `${Math.round((data.localCacheHits / data.calls) * 100)}% 的请求没花钱` : '—'} />
          <Stat label="失败" value={fmt(data.failedCalls)} hint="超时或报错，已退回规则" warn={data.failedCalls > 0} />
          <Stat label="输入 token" value={fmt(data.promptTokens)} hint={`服务商缓存命中 ${Math.round(data.providerCacheRatio * 100)}%`} />
          <Stat label="输出 token" value={fmt(data.completionTokens)} />
          <Stat label="估算费用" value={data.estimatedCostYuan == null ? '—' : `¥${data.estimatedCostYuan.toFixed(2)}`} hint={data.estimatedCostYuan == null ? '填单价后可估算' : '以服务商账单为准'} />
        </div>
        {!data.byKind.length ? <div className="empty">这个月还没有调用</div> : (
          <table className="t">
            <thead><tr><th>用途</th><th style={{ textAlign: 'right' }}>次数</th><th style={{ textAlign: 'right' }}>其中本系统缓存</th><th style={{ textAlign: 'right' }}>输入 token</th><th style={{ textAlign: 'right' }}>输出 token</th></tr></thead>
            <tbody>{data.byKind.map((k) => (
              <tr key={k.kind}><td className="nw"><b>{KIND_LABELS[k.kind] || k.kind}</b></td><td className="nw" style={{ textAlign: 'right' }}>{fmt(k.calls)}</td><td className="nw" style={{ textAlign: 'right' }}>{fmt(k.localCacheHits)}</td><td className="nw" style={{ textAlign: 'right' }}>{fmt(k.promptTokens)}</td><td className="nw" style={{ textAlign: 'right' }}>{fmt(k.completionTokens)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </> : !err ? <div className="empty">加载中…</div> : null}
    </Section>
  );
}
