import { useEffect, useState } from 'react';
import { REPAIR_TYPE_OPTIONS } from '@pms/shared-types';
import { repairs, request } from '@pms/api-client';
import { Btn, ErrorNote, Field, Sheet, toast } from '@/components/ui';

interface Community { id: number; name: string }

/**
 * 登记报修：设计稿把它做成「右侧面板一页填完」。
 *
 * 地址目前是「小区 + 地址文本」，还没有接房号选择器（HouseAddressPicker）：
 * 选房号能自动带出业主和电话，那一块等迁移完房产/业主两个页面再接。
 */
export default function NewOrderSheet({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workOrderId: number) => void;
}) {
  const [communities, setCommunities] = useState<Community[]>([]);
  const [communityId, setCommunityId] = useState<number | 0>(0);
  const [address, setAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [repairType, setRepairType] = useState('');
  const [content, setContent] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    request<Community[]>({ url: '/communities' })
      .then((list) => {
        setCommunities(list);
        if (!communityId && list[0]) setCommunityId(list[0].id);
      })
      .catch(() => undefined);
  }, [open]);

  const reset = () => {
    setAddress(''); setContactName(''); setContactPhone(''); setContent(''); setRepairType(''); setUrgent(false); setErr('');
  };

  const submit = async () => {
    if (!communityId) { setErr('请选择小区'); return; }
    if (!address.trim()) { setErr('请填写报修地址'); return; }
    if (!content.trim()) { setErr('请填写问题描述'); return; }
    setBusy(true);
    setErr('');
    try {
      const r = await repairs.create({
        communityId,
        addressText: address.trim(),
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

      <Field label="小区">
        <select className="in" value={communityId} onChange={(e) => setCommunityId(Number(e.target.value))}>
          {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>

      <Field label="报修地址 *" hint="按「小区 楼栋/单元/房号」或「公共区域 + 位置」填写">
        <input className="in" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="例如：228/6/502 卫生间" />
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
