import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { ErrorNote, Loading, toast } from '@/components/ui';
import { renderNoticeDocument, type Notice, type NoticeTemplate } from '@/lib/residential-bills';
import { uploadImage } from '@/lib/upload';
import { Row, Section, Toggle, errMsg } from './parts';

/** 与后端 GET/PATCH /settings/notice-template 同形；默认值全部由接口返回，前端不写死。 */
const TEMPLATE_URL = '/settings/notice-template';
const MAX_NOTES = 6;

const normalize = (value: NoticeTemplate): NoticeTemplate => ({
  ...value,
  notes: Array.isArray(value.notes) ? value.notes.map((note) => String(note)).slice(0, MAX_NOTES) : [],
  qrImageUrl: typeof value.qrImageUrl === 'string' ? value.qrImageUrl : '',
});

/** 预览用合成样例：6 个账期各 ¥158.00，不读真实数据、不落库。 */
const PREVIEW_BILLS = Array.from({ length: 6 }, (_, index) => ({
  id: `preview-${index + 1}`,
  feeCode: 'preview-property',
  feeName: '物业管理费',
  period: `2026${String(index + 1).padStart(2, '0')}`,
  amountCents: 15800,
}));

function previewNotice(): Notice {
  return {
    houseKey: 'preview-0001',
    address: '示例小区1号楼2单元301',
    ownerName: '示例住户',
    communityId: 0,
    communityName: '示例小区',
    amountCents: PREVIEW_BILLS.reduce((sum, bill) => sum + bill.amountCents, 0),
    phoneMasked: '138****0000',
    contactEligible: true,
    bills: PREVIEW_BILLS,
  };
}

const imageFiles = (transfer: DataTransfer | null): File[] => {
  if (!transfer) return [];
  const fromFiles = Array.from(transfer.files || []).filter((file) => file.type.startsWith('image/'));
  if (fromFiles.length) return fromFiles;
  return Array.from(transfer.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file && file.type.startsWith('image/'));
};

/** 缴费二维码：一个上传栏，支持点选 / 拖入 / Ctrl+V 粘贴；有图时显示缩略图并可替换、删除。 */
function QrImageUpload({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ disabled, busy, onChange });
  latest.current = { disabled, busy, onChange };

  const pick = (files: File[]) => {
    const current = latest.current;
    if (!files.length || current.disabled || current.busy) return;
    const file = files.find((item) => item.type.startsWith('image/'));
    if (!file) { toast('请选择图片文件（PNG/JPG 等）'); return; }
    if (file.size > 15 * 1024 * 1024) { toast('二维码图片不能超过 15MB'); return; }
    setBusy(true);
    uploadImage(file)
      .then((url) => { latest.current.onChange(url); toast('二维码已上传，点「保存通知单模板」后生效'); })
      .catch((e) => toast(errMsg(e, '二维码上传失败')))
      .finally(() => setBusy(false));
  };

  return (
    <div className="photo-field" style={{ alignItems: 'flex-start' }}>
      {value ? (
        <div
          className="photo-item"
          style={{ width: 120, height: 120, borderColor: over ? 'var(--acc)' : undefined }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(imageFiles(e.dataTransfer)); }}
        >
          <img src={value} alt="缴费二维码预览" style={{ objectFit: 'contain', background: '#fff' }} />
        </div>
      ) : disabled ? (
        <div className="photo-drop" style={{ width: 160, height: 120, cursor: 'default' }}>
          <Icon name="image" size={22} />
          <span>当前账号只能查看，不能上传</span>
        </div>
      ) : (
        <div
          tabIndex={0}
          role="button"
          className={`photo-drop ${focus ? 'on' : ''} ${over ? 'over' : ''}`}
          style={{ width: 160, height: 120 }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          onPaste={(e) => { const files = imageFiles(e.clipboardData); if (files.length) { e.preventDefault(); pick(files); } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(imageFiles(e.dataTransfer)); }}
        >
          {busy ? <><div className="spin" /><span>上传中…</span></> : (
            <>
              <Icon name="image" size={22} />
              <b>{focus ? '按 Ctrl+V 粘贴' : '上传缴费二维码'}</b>
              <span>点此选图，或拖入 / Ctrl+V 粘贴</span>
            </>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignSelf: 'center' }}>
        <span className="muted" style={{ fontSize: 13 }}>{value ? '已上传，保存后打印在通知单上' : '未上传，通知单上只打印文字说明'}</span>
        <div className="set-inline">
          <button type="button" className="btn sm" disabled={disabled || busy} onClick={() => fileRef.current?.click()}>{value ? '替换' : '选择图片'}</button>
          {value ? <button type="button" className="btn g sm" disabled={disabled || busy} onClick={() => onChange('')}>删除</button> : null}
          {busy ? <span className="muted" style={{ fontSize: 13 }}>上传中…</span> : null}
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { pick(Array.from(e.target.files || [])); e.target.value = ''; }} />
    </div>
  );
}

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

  /** 用当前表单里未保存的值 + 合成样例打开 A5 预览；不落库、不弹打印框。 */
  function openPreview() {
    if (!data) return;
    try {
      const template: NoticeTemplate = { ...data, notes: data.notes.map((note) => note.trim()).filter(Boolean).slice(0, MAX_NOTES) };
      const html = renderNoticeDocument([previewNotice()], {
        queriedAt: new Date().toISOString(),
        batchNo: '预览',
        paper: 'A5',
        template,
      });
      const win = window.open('', '_blank');
      if (!win) { toast('预览窗口被浏览器拦截，请允许本站弹出窗口后重试'); return; }
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
    } catch (e) {
      toast(errMsg(e, '预览生成失败'));
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
        <Row label="缴费二维码" hint="打印在通知单「扫码缴费」卡片里；请上传正方形、底色白的二维码图片，未上传时只打印文字说明。">
          <QrImageUpload value={data.qrImageUrl || ''} disabled={off} onChange={(url) => set({ qrImageUrl: url })} />
        </Row>
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
          <button className="btn" type="button" onClick={openPreview}>预览效果</button>
          <button className="btn p" type="submit" disabled={off}>{busy ? '保存中…' : '保存通知单模板'}</button>
          <span className="muted" style={{ alignSelf: 'center', fontSize: 13 }}>预览用当前未保存的内容 + 示例数据，不落库、不打印</span>
        </div>
        <p className="muted" style={{ margin: '12px 0 0', fontSize: 14 }}>未启用的项在打印时会按模板默认值处理；只保存配置，不会触发打印或通知。</p>
      </form>
    </Section>
  );
}
