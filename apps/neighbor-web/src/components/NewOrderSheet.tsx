import { useEffect, useState } from 'react';
import { REPAIR_TYPE_OPTIONS } from '@pms/shared-types';
import { repairs } from '@pms/api-client';
import { Btn, ErrorNote, Field, Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';

/**
 * 登记报修：设计稿把它做成「右侧面板一页填完」。
 *
 * 地址是一个输入框：直接打 228/6/502 联想，或点选 小区 → 楼栋 → 室号，
 * 选中后自动带出业主姓名和电话；公共区域报修切到「公共区域」直接写位置。
 */
/** 收银台已经选定住户时，带着这户直接开报修（不用再选一次房号） */
export interface RepairPrefill {
  communityId: number | null;
  /** 完整地址：枫桦景苑二期 228弄3号502室 */
  addressText: string;
  contactName?: string | null;
  contactPhone?: string | null;
}

export default function NewOrderSheet({
  open, onClose, onCreated, initialHouse,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workOrderId: number) => void;
  /** 传了就带着这户开报修：地址固定显示，可点「改地址」切回选房 */
  initialHouse?: RepairPrefill | null;
}) {
  const { communities, error: treeErr } = useAddressTree();
  const [mode, setMode] = useState<'house' | 'area'>('house');
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [spot, setSpot] = useState('');
  const [areaText, setAreaText] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [repairType, setRepairType] = useState('');
  const [content, setContent] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** 带户进来时锁定地址；点「改地址」解锁回到选房 */
  const [fixed, setFixed] = useState<RepairPrefill | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr('');
    // 每次打开按传入的住户重置：带户就锁地址、带出联系人；不带户就空白选房
    setFixed(initialHouse ?? null);
    setMode('house');
    setPicked(null); setSpot(''); setAreaText('');
    setContactName(initialHouse?.contactName ?? '');
    setContactPhone(initialHouse?.contactPhone ?? '');
    setContent(''); setRepairType(''); setUrgent(false);
  }, [open, initialHouse]);

  const reset = () => {
    setFixed(null); setPicked(null); setSpot(''); setAreaText('');
    setContactName(''); setContactPhone(''); setContent(''); setRepairType(''); setUrgent(false); setErr('');
  };

  const fullAddress = fixed
    ? [fixed.addressText, spot.trim()].filter(Boolean).join(' ')
    : mode === 'house'
      ? [picked?.text, spot.trim()].filter(Boolean).join(' ')
      : areaText.trim();

  const submit = async () => {
    if (!fixed && mode === 'house' && !picked) { setErr('请选房号，或切到「公共区域」写地址'); return; }
    if (!fixed && mode === 'area' && !areaText.trim()) { setErr('请填写公共区域地址'); return; }
    if (!content.trim()) { setErr('请填写问题描述'); return; }
    setBusy(true);
    setErr('');
    try {
      const r = await repairs.create({
        communityId: fixed?.communityId ?? picked?.communityId ?? communities[0]?.id ?? 0,
        addressText: fullAddress,
        contactName: contactName.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        repairType: repairType || undefined,
        content: content.trim(),
        urgent,
      });
      reset();
      onCreated(r.workOrder.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      subtitle="草稿不会自动保存，关闭前请提交"
      title="登记报修"
      headExtra={null}
    >
      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <Field label="报修地址 *" hint={fixed ? '收银台已选定这户；如要改到别处，点「改地址」' : '直接输入 228/6/502 查找，或点选 小区 → 楼栋 → 室号；选中自动带出业主和电话'}>
        {fixed ? (
          <>
            <div className="fixed-addr">
              <Icon name="home" size={16} />
              <b style={{ flex: 1 }}>{fixed.addressText}</b>
              <button type="button" className="btn g sm" onClick={() => { setFixed(null); setSpot(''); }}>改地址</button>
            </div>
            <input className="in" style={{ marginTop: 8 }} value={spot}
              onChange={(e) => setSpot(e.target.value)}
              placeholder="具体位置（选填）：卫生间、厨房、阳台…" />
          </>
        ) : (
          <>
            <div className="chips" style={{ marginBottom: 8 }}>
              <button className={`chip ${mode === 'house' ? 'on' : ''}`} onClick={() => setMode('house')}>住户房号</button>
              <button className={`chip ${mode === 'area' ? 'on' : ''}`} onClick={() => setMode('area')}>公共区域</button>
            </div>

            {mode === 'house' ? (
              <>
                <HousePicker
                  communities={communities}
                  value={picked}
                  placeholder="输入 228/6/502，或点选 小区 → 楼栋 → 室号"
                  onPick={(p) => {
                    setPicked(p);
                    if (p.ownerName && !contactName) setContactName(p.ownerName);
                    if (p.ownerPhone && !contactPhone) setContactPhone(p.ownerPhone);
                  }}
                  onClear={() => setPicked(null)}
                />
                {picked ? (
                  <input className="in" style={{ marginTop: 8 }} value={spot}
                    onChange={(e) => setSpot(e.target.value)}
                    placeholder="具体位置（选填）：卫生间、厨房、阳台…" />
                ) : null}
              </>
            ) : (
              <input className="in" value={areaText} onChange={(e) => setAreaText(e.target.value)}
                placeholder="例如：枫桦景苑二期 3号楼 大堂 / 地下车库 B2 水泵房" />
            )}
          </>
        )}
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="联系人">
          <input className="in" value={contactName} onChange={(e) => setContactName(e.target.value)} />
        </Field>
        <Field label="手机号">
          <input className="in" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        </Field>
      </div>

      <Field label="问题描述 *">
        <textarea className="in" value={content} onChange={(e) => setContent(e.target.value)} placeholder="地漏返水，楼下天花板渗水…" />
      </Field>

      <Field label="报修类型">
        <div className="chips">
          {REPAIR_TYPE_OPTIONS.map((t) => (
            <button key={t.value} className={`chip ${repairType === t.value ? 'on' : ''}`}
              onClick={() => setRepairType(repairType === t.value ? '' : t.value)}>{t.label}</button>
          ))}
        </div>
      </Field>

      <Field label="紧急程度">
        <div className="seg">
          <button className={!urgent ? 'on' : ''} onClick={() => setUrgent(false)}>普通</button>
          <button className={urgent ? 'on' : ''} onClick={() => setUrgent(true)}>紧急 · 2 小时内</button>
        </div>
      </Field>

      <div className="note" style={{ marginBottom: 14 }}>
        照片附件还没接：需要带照片的话，先在现有后台或小程序里登记。
      </div>

      <button className="btn p lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={() => void submit()}>
        {busy ? '提交中…' : '提交报修'}
      </button>
      <div style={{ height: 8 }} />
      <Btn kind="g" onClick={() => { reset(); toast('已清空'); }}>清空</Btn>
    </Sheet>
  );
}
