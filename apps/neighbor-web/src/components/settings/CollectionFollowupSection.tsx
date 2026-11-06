import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { ErrorNote, Loading, toast } from '@/components/ui';
import { Row, Section, Toggle, errMsg } from './parts';

/** 与后端 GET/PATCH /settings/collection-followup 同形；默认值由接口返回。 */
interface FollowupRule { amountCents: number; inactiveDays: number; enabled: boolean }

const RULE_URL = '/settings/collection-followup';
const MAX_YUAN = 21474836.47; // 分转元后仍需落在安全整数/32 位范围内

/** 分 → 元输入框文案：整元不带小数，其余保留两位 */
const yuanText = (cents: number) => {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  return safe % 100 === 0 ? String(safe / 100) : (safe / 100).toFixed(2);
};

export default function CollectionFollowupSection({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<FollowupRule | null>(null);
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const apply = (rule: FollowupRule) => {
    setData(rule);
    setAmount(yuanText(rule.amountCents));
    setDays(String(rule.inactiveDays));
    setEnabled(rule.enabled !== false);
  };

  const load = () => {
    setError('');
    request<FollowupRule>({ url: RULE_URL }).then(apply).catch((e) => setError(errMsg(e, '催收规则读取失败')));
  };
  useEffect(load, []);

  const clearField = (key: string) => setFields((prev) => ({ ...prev, [key]: '' }));

  async function save() {
    const errors: Record<string, string> = {};
    const yuan = Number(amount);
    const cents = Math.round(yuan * 100);
    if (amount.trim() === '' || !Number.isFinite(yuan) || yuan < 0 || yuan > MAX_YUAN) {
      errors.amountCents = '请填写 0 以上的金额（元）';
    } else if (Math.abs(cents - yuan * 100) > 1e-6) {
      errors.amountCents = '金额最多保留两位小数';
    } else if (!Number.isSafeInteger(cents)) {
      errors.amountCents = '金额超出可保存范围，请填小一些';
    }
    const dayValue = Number(days);
    if (days.trim() === '' || !Number.isInteger(dayValue) || dayValue < 1 || dayValue > 365) {
      errors.inactiveDays = '请填 1–365 之间的整数天数';
    }
    setFields(errors);
    if (Object.keys(errors).length) {
      form.current?.querySelector<HTMLElement>('[name="' + Object.keys(errors)[0] + '"]')?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      // 界面按元输入，提交转成分；返回后以后端结果为准再回填一次。
      const saved = await request<FollowupRule>({ method: 'PATCH', url: RULE_URL, data: { amountCents: cents, inactiveDays: dayValue, enabled } });
      apply(saved);
      toast('催收规则已保存，下次计算命中立即生效');
    } catch (e) {
      setError(errMsg(e, '保存失败，已保留填写内容'));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <Section title="催收规则">
        {error ? <ErrorNote>{error} <button className="btn" onClick={load}>重试</button></ErrorNote> : <Loading />}
      </Section>
    );
  }

  const off = !canEdit || busy;
  return (
    <Section title="催收规则" desc="催收跟进页「大额且久未联系」的提醒按这里判定；改完点保存立即生效，已生成的跟进记录不变。">
      <form ref={form} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Row label="大额门槛" hint="按户/责任对象合计待缴金额判断；界面按元填写，保存时转成分。">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              name="amountCents"
              className="in"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              disabled={off}
              aria-invalid={!!fields.amountCents}
              aria-describedby={fields.amountCents ? 'followup-error-amountCents' : undefined}
              style={{ maxWidth: 200, borderColor: fields.amountCents ? 'var(--dang)' : undefined }}
              onChange={(e) => { setAmount(e.target.value); clearField('amountCents'); }}
            />
            <span>元</span>
          </div>
          {fields.amountCents ? <p id="followup-error-amountCents" style={{ color: 'var(--dang)', margin: '6px 0', fontSize: 14 }}>{fields.amountCents}</p> : null}
        </Row>
        <Row label="久未跟进天数" hint="距上次人工跟进达到该天数才算失联；从未人工跟进的对象直接命中。">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              name="inactiveDays"
              className="in"
              type="number"
              min={1}
              max={365}
              step={1}
              value={days}
              disabled={off}
              aria-invalid={!!fields.inactiveDays}
              aria-describedby={fields.inactiveDays ? 'followup-error-inactiveDays' : undefined}
              style={{ maxWidth: 200, borderColor: fields.inactiveDays ? 'var(--dang)' : undefined }}
              onChange={(e) => { setDays(e.target.value); clearField('inactiveDays'); }}
            />
            <span>天（1–365）</span>
          </div>
          {fields.inactiveDays ? <p id="followup-error-inactiveDays" style={{ color: 'var(--dang)', margin: '6px 0', fontSize: 14 }}>{fields.inactiveDays}</p> : null}
        </Row>
        <Row label="启用催收提醒" hint={enabled ? '关闭后催收页不再按此规则提醒，已有关联记录保留。' : '当前已关闭；金额与天数仍可先保存，开启后立即生效。'}>
          <Toggle on={enabled} disabled={off} onChange={setEnabled} label={['已开启', '已关闭']} />
        </Row>
        <div className="note" style={{ margin: '18px 0' }}>
          命中口径 = 待缴金额 ≥ 门槛 且（从未人工跟进 或 距上次人工跟进 ≥ 天数）
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="set-actions">
          <button className="btn p" type="submit" disabled={off}>{busy ? '保存中…' : '保存催收规则'}</button>
        </div>
        <p className="muted" style={{ margin: '12px 0 0', fontSize: 14 }}>保存只改规则，不会自动发起催收或发送短信。</p>
      </form>
    </Section>
  );
}
