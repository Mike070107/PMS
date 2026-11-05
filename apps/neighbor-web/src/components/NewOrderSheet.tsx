import { useEffect, useState } from 'react';
import { DEFAULT_LOCATION_SUGGESTIONS, REPAIR_TYPE_OPTIONS } from '@pms/shared-types';
import { repairs } from '@pms/api-client';
import { Btn, ErrorNote, Field, Sheet, toast } from '@/components/ui';
import Icon from '@/components/Icon';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import type { PickedAddress } from '@/components/HouseAddressPicker';
import { useAddressTree } from '@/lib/address-tree';
import LocationSuggestions from '@/components/LocationSuggestions';
import { locationOptions, normalizeLocation } from '@/lib/repair-location-options';
import './NewOrderSheet.css';

/**
 * 登记报修：设计稿把它做成「右侧面板一页填完」。
 *
 * 地址是一个输入框：直接打 228/6/502 联想，或点选 小区 → 楼栋 → 室号，
 * 选中后自动带出业主姓名和电话；楼栋下直接选择公共区域，不借用住户。
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
  const [publicArea, setPublicArea] = useState<PickedAddress | null>(null);
  const [nameEdited, setNameEdited] = useState(false);
  const [phoneEdited, setPhoneEdited] = useState(false);
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [spot, setSpot] = useState('');
  const [pickerRevision, setPickerRevision] = useState(0);

  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [repairType, setRepairType] = useState('');
  const [content, setContent] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** 带户进来时锁定地址；点「改地址」解锁回到选房 */
  const [fixed, setFixed] = useState<RepairPrefill | null>(null);
  const [learnedLocations, setLearnedLocations] = useState<unknown>([]);
  const [locationError, setLocationError] = useState(false);
  const selectedCommunityId = fixed?.communityId ?? picked?.communityId ?? publicArea?.communityId;
  const locations = locationOptions(DEFAULT_LOCATION_SUGGESTIONS, learnedLocations);
  useEffect(() => {
    let active = true;
    setLearnedLocations([]); setLocationError(false);
    if (open && selectedCommunityId) {
      repairs.locationSuggestions(selectedCommunityId).then(result => {
        if (!active) return;
        if (!result || !Array.isArray(result.items)) throw new Error('常用位置响应无效');
        setLearnedLocations(result.items);
      }).catch(() => { if (active) setLocationError(true); });
    }
    return () => { active = false; };
  }, [open, selectedCommunityId]);

  useEffect(() => {
    if (!open) return;
    setErr('');
    setPickerRevision(value => value + 1);
    // 每次打开按传入的住户重置：带户就锁地址、带出联系人；不带户就空白选房
    setFixed(initialHouse ?? null);
    setPublicArea(null); setNameEdited(false); setPhoneEdited(false);
    setPicked(null); setSpot(''); setPublicArea(null);
    setContactName(initialHouse?.contactName ?? '');
    setContactPhone(initialHouse?.contactPhone ?? '');
    setContent(''); setRepairType(''); setUrgent(false);
  }, [open, initialHouse]);

  const reset = () => {
    setPickerRevision(value => value + 1);
    setFixed(null); setPicked(null); setSpot(''); setPublicArea(null); setNameEdited(false); setPhoneEdited(false);
    setContactName(''); setContactPhone(''); setContent(''); setRepairType(''); setUrgent(false); setErr('');
  };

  const fullAddress = fixed
      ? [fixed.addressText, spot.trim()].filter(Boolean).join(' ')
      : [picked?.text ?? publicArea?.fullText, spot.trim()].filter(Boolean).join(' ');

    const fillContact = (name = '', phone = '') => {
      if (!nameEdited) setContactName(name);
      if (!phoneEdited) setContactPhone(phone);
    };
    const clearAddress = () => {
      setPicked(null); setPublicArea(null); setSpot(''); fillContact();
    };

    const submit = async () => {
      if (!fixed && !picked && !publicArea) { setErr('请选择房号，或在楼栋下选择公共区域'); return; }
      const communityId = fixed?.communityId ?? picked?.communityId ?? publicArea?.communityId;
      if (!communityId) { setErr('所选地址缺少小区，请重新选择'); return; }

    if (!content.trim()) { setErr('请填写问题描述'); return; }
    setBusy(true);
    setErr('');
    try {
      const r = await repairs.create({
        communityId,
        addressText: fullAddress,
        locationText: normalizeLocation(spot) || undefined,
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
      <div className="new-order-form">
      {treeErr && !fixed ? <ErrorNote>{treeErr}</ErrorNote> : null}
      {err ? <ErrorNote>{err}</ErrorNote> : null}



      <section className="new-order-section" aria-label="报修位置">
        <Field label="报修位置 *">
          {fixed ? (
            <div className="fixed-addr">
              <Icon name="home" size={18} />
              <b>{fixed.addressText}</b>
              <button type="button" className="btn g sm" onClick={() => { setFixed(null); clearAddress(); }}>改地址</button>
            </div>
          ) : (
            <>
              <HousePicker
                              communities={communities}
                              value={picked}
                              publicValue={publicArea}
                selectionRevision={pickerRevision}
                              allowPublicArea
                              disabled={busy}
                              placeholder="先选小区、楼栋，再选室号或公共区域"
                              onPick={(p) => {
                                if (publicArea || (picked && picked.houseId !== p.houseId)) setSpot('');
                                setPublicArea(null); setPicked(p);
                                fillContact(p.ownerName ?? '', p.ownerPhone ?? '');
                              }}
                              onPublicPick={(p) => {
                                setPicked(null); setPublicArea(p); setSpot(''); fillContact();
                              }}
                              onIncomplete={clearAddress}
                              onClear={clearAddress}
                            />
            </>
          )}
        </Field>
        <Field label="具体位置">
          <input className="in" aria-label="具体位置" maxLength={60} value={spot}
            onChange={(e) => setSpot(e.target.value)} placeholder="选填，如大门、厨房、4楼电梯口" />
          <LocationSuggestions options={locations} value={spot} onSelect={setSpot} disabled={busy} />
                    {locationError ? <div className="muted" role="status">常用位置暂时未能加载，仍可手动填写。</div> : null}
        </Field>
      </section>

      <div className="new-order-contact">
        <Field label="联系人">
          <input className="in" aria-label="联系人" autoComplete="name" value={contactName}
            onChange={(e) => { setNameEdited(true); setContactName(e.target.value); }} />
        </Field>
        <Field label="手机号">
          <input className="in" aria-label="手机号" type="tel" autoComplete="tel" value={contactPhone}
            onChange={(e) => { setPhoneEdited(true); setContactPhone(e.target.value); }} />
        </Field>
      </div>

      <section className="new-order-section new-order-problem" aria-label="问题描述">
      <Field label="问题描述 *">
        <textarea className="in" aria-label="问题描述" rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="地漏返水，楼下天花板渗水…" />
      </Field>

      </section>

      <details className="new-order-section new-order-secondary" aria-label="补充信息">
            <summary>更多设置 <span className="muted">· 自动识别类型，默认普通报修</span></summary>
            <Field label="报修类型">
              <div className="chips">
                {REPAIR_TYPE_OPTIONS.map((t) => (
                  <button type="button" key={t.value} aria-pressed={repairType === t.value} className={`chip ${repairType === t.value ? 'on' : ''}`}
                    onClick={() => setRepairType(repairType === t.value ? '' : t.value)}>{t.label}</button>
                ))}
              </div>
            </Field>

            <Field label="紧急程度">
              <div className="seg">
                <button type="button" aria-pressed={!urgent} className={!urgent ? 'on' : ''} onClick={() => setUrgent(false)}>普通</button>
                <button type="button" aria-pressed={urgent} className={urgent ? 'on' : ''} onClick={() => setUrgent(true)}>紧急 · 2 小时内</button>
              </div>
            </Field>

            </details>

      <div className="note" style={{ marginBottom: 14 }}>
        照片附件还没接：需要带照片的话，先在现有后台或小程序里登记。
      </div>

      <button type="button" className="btn p lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={() => void submit()}>
        {busy ? '提交中…' : '提交报修'}
      </button>
      <div style={{ height: 8 }} />
      <Btn kind="g" disabled={busy} onClick={() => { reset(); toast('已清空'); }}>清空</Btn>
      </div>
    </Sheet>
  );
}
