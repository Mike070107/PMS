import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { ErrorNote, Loading, toast } from '@/components/ui';
import type { NoticeTemplate } from '@/lib/residential-bills';
import { Row, Section, Toggle, errMsg } from './parts';

/** 与后端 GET/PATCH /settings/notice-template 同形；默认值全部由接口返回，前端不写死。 */
const TEMPLATE_URL = '/settings/notice-template';
const MAX_NOTES = 6;

const normalize = (value: NoticeTemplate): NoticeTemplate => ({
  ...value,
  notes: Array.isArray(value.notes) ? value.notes.map((note) => String(note)).slice(0, MAX_NOTES) : [],
});

export default function NoticeTemplateSection({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<NoticeTemplate | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError('');
    request<NoticeTemplate>({ url: TEMPLATE_URL })
      .then((value) => setData(normalize(value)))
      .catch((e) => setError(errMsg(e, '通知单模板读取失败')));
  };
  useEffect(load, []);

  const set = (patch: Partial<NoticeTemplate>) => setData((prev) => (prev ? { ...prev, ...patch } : prev));

  const setNote = (index: number, value: string) => {
    if (!data) return;
    set({ notes: data.notes.map((note, i) => (i === index ? value : note)) });
  };

  const addNote = () => {
    if (!data || data.notes.length >= MAX_NOTES) return;
    set({ notes: [...data.notes, ''] });
  };

  const removeNote = (index: number) => {
    if (!data) return;
    set({ notes: data.notes.filter((_, i) => i !== index) });
  };

  async function save() {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      // 空条目按后端口径忽略；条数上限 6。
      const notes = data.notes.map((note) => note.trim()).filter(Boolean).slice(0, MAX_NOTES);
      const saved = await request<NoticeTemplate>({ method: 'PATCH', url: TEMPLATE_URL, data: { ...data, notes } });
      setData(normalize(saved));
      toast('通知单模板已保存，只影响之后打印的通知单');
    } catch (e) {
      setError(errMsg(e, '保存失败，已保留填写内容'));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Section title="通知单模板">
        {error ? <ErrorNote>{error} <button className="btn" onClick={load}>重试</button></ErrorNote> : <Loading />}
      </Section>
    );
  }

  const off = !canEdit || busy;
  const text = (label: string, value: string, onChange: (v: string) => void, opts?: { hint?: string; placeholder?: string; maxLength?: number }) => (
    <Row label={label} hint={opts?.hint}>
      <input
        className="in"
        value={value}
        maxLength={opts?.maxLength ?? 120}
        placeholder={opts?.placeholder}
        disabled={off}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
  const area = (label: string, value: string, onChange: (v: string) => void, hint: string, maxLength = 500) => (
    <Row label={label} hint={hint}>
      <textarea
        className="in"
        value={value}
        maxLength={maxLength}
        disabled={off}
        onChange={(e) => onChange(e.target.value)}
        style={{ height: 'auto', minHeight: 96 }}
      />
    </Row>
  );

  return (
    <Section title="通知单模板" desc="打印《物业服务费用缴费通知单》使用的抬头、收款信息与须知；保存只影响之后打印的通知单，已打印的不变。">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {text('服务中心后缀', data.orgSuffix, (v) => set({ orgSuffix: v }), {
          hint: '接在小区名称后面组成抬头，例如「××物业服务中心」。', maxLength: 40,
        })}
        {text('落款后缀', data.signatureSuffix, (v) => set({ signatureSuffix: v }), {
          hint: '通知单落款单位后缀，例如「物业管理处」。', maxLength: 40,
        })}
        {text('联系电话', data.phone, (v) => set({ phone: v }), {
          hint: '打印在通知单「服务中心」栏；留空则不打印电话。', placeholder: '如 0571-88886666', maxLength: 40,
        })}
        {text('服务时间', data.serviceHours, (v) => set({ serviceHours: v }), {
          hint: '打印在「服务中心」栏，例如「8:30–17:30 · 周一至周日」。', placeholder: '如 8:30–17:30 · 周一至周日', maxLength: 60,
        })}
        {text('服务中心地址', data.address, (v) => set({ address: v }), {
          hint: '打印在通知单底部；留空则不打印地址。', maxLength: 120,
        })}
        {text('银行户名', data.bankHolder, (v) => set({ bankHolder: v }), {
          hint: '银行转账收款户名；留空时打印「以服务中心公布为准」。', maxLength: 80,
        })}
        {text('开户银行', data.bankName, (v) => set({ bankName: v }), { maxLength: 80 })}
        {text('银行账号', data.bankAccount, (v) => set({ bankAccount: v }), { maxLength: 60 })}
        {text('缴费方式', data.payMethods, (v) => set({ payMethods: v }), {
          hint: '打印在「服务中心」栏，例如「现金 / 微信 / 支付宝 / 刷卡」。', maxLength: 60,
        })}
        {text('线上缴费标题', data.onlineTitle, (v) => set({ onlineTitle: v }), {
          hint: '通知单上线上缴费提示区的标题。', maxLength: 60,
        })}
        {area('线上缴费说明', data.onlineText, (v) => set({ onlineText: v }), '线上缴费提示区正文，说明扫码缴费的步骤。')}
        <Row
          label="须知条目"
          hint={'打印在通知单底部；最多 6 条，留空的条目保存时会被忽略。'}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.notes.map((note, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="in"
                  aria-label={`须知第 ${index + 1} 条`}
                  value={note}
                  maxLength={200}
                  disabled={off}
                  onChange={(e) => setNote(index, e.target.value)}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button type="button" className="btn g sm" disabled={off} aria-label={`删除第 ${index + 1} 条须知`} onClick={() => removeNote(index)}>删除</button>
              </div>
            ))}
            {!data.notes.length ? <p className="muted" style={{ margin: 0, fontSize: 14 }}>还没有须知条目，可以不填。</p> : null}
            <div className="set-inline">
              <button type="button" className="btn" disabled={off || data.notes.length >= MAX_NOTES} onClick={addNote}>＋ 添加须知</button>
              <span className="muted" style={{ fontSize: 13 }}>{data.notes.length}/{MAX_NOTES} 条{data.notes.length >= MAX_NOTES ? ' · 已达上限' : ''}</span>
            </div>
          </div>
        </Row>
        {area('免责说明', data.liability, (v) => set({ liability: v }), '打印在通知单底部，说明通知单不作为收款凭证；留空则不打印。')}
        <Row label="打印批次编号" hint="关闭后通知单右上角不打印批次编号。">
          <Toggle on={data.showBatchNo} disabled={off} onChange={(v) => set({ showBatchNo: v })} label={['打印', '不打印']} />
        </Row>
        <Row label="打印联系电话" hint="关闭后通知单「联系电话」一栏不打印号码（显示「—」）。">
          <Toggle on={data.showPhone} disabled={off} onChange={(v) => set({ showPhone: v })} label={['打印', '不打印']} />
        </Row>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="set-actions">
          <button className="btn p" type="submit" disabled={off}>{busy ? '保存中…' : '保存通知单模板'}</button>
        </div>
        <p className="muted" style={{ margin: '12px 0 0', fontSize: 14 }}>未启用的项在打印时会按模板默认值处理；只保存配置，不会触发打印或通知。</p>
      </form>
    </Section>
  );
}
