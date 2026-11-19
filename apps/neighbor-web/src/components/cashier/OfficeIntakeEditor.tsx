import { useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import { RegistrationTermEditor, type RegistrationTerm } from '@/components/VehicleRegistrationTerm';
import { newOfficeKey, saveOfficeIntake } from '@/lib/vehicle-intake-office';
import type { Intake } from './NewPlateCard';

const MAX = 10;
const MAX_BYTES = 20 * 1024 * 1024;
const isImage = (file: File) => file.type.startsWith('image/');

/**
 * 办公室直接办理入口：代业主填写车牌/联系人/关系/期限并上传资料。
 * 与业主扫码页面完全分开（登录态、权限、操作编号、资料版本），不会冒用业主身份。
 */
export default function OfficeIntakeEditor({ intake, onSaved }: { intake: Intake; onSaved: (x: Intake) => void }) {
  const [open, setOpen] = useState(false);
  const [plate, setPlate] = useState(intake.plate);
  const [contactName, setContactName] = useState(intake.contactName);
  const [contactPhone, setContactPhone] = useState(intake.contactPhone);
  const [relation, setRelation] = useState(intake.relation);
  const [term, setTerm] = useState<RegistrationTerm>(intake.registrationTerm ?? { mode: 'months', months: 12 });
  const [picks, setPicks] = useState<Array<{ file: File; url: string; isImg: boolean }>>([]);
  const [keep, setKeep] = useState<number[]>(() => intake.files.map(file => file.index));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const pasteRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => () => picks.forEach(pick => URL.revokeObjectURL(pick.url)), [picks]);

  const add = (list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list);
    setErr('');
    if (files.some(file => file.size > MAX_BYTES)) { setErr('单份资料不能超过 20MB'); return; }
    const room = MAX - keep.length - picks.length;
    if (room <= 0) { setErr('资料最多 10 份'); return; }
    if (files.length > room) setErr(`最多再放 ${room} 份，多出的已忽略`);
    const next = files.slice(0, room).map(file => ({ file, url: URL.createObjectURL(file), isImg: isImage(file) }));
    setPicks(current => [...current, ...next]);
  };
  const removePick = (index: number) => setPicks(current => { URL.revokeObjectURL(current[index].url); return current.filter((_, i) => i !== index); });
  const paste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    add(files);
  };

  const reset = () => {
    setPlate(intake.plate); setContactName(intake.contactName); setContactPhone(intake.contactPhone);
    setRelation(intake.relation); setTerm(intake.registrationTerm ?? { mode: 'months', months: 12 });
    setPicks(current => { current.forEach(pick => URL.revokeObjectURL(pick.url)); return []; });
    setKeep(intake.files.map(file => file.index));
    setErr(''); setOk('');
  };

  const submit = async (confirm: boolean) => {
    if (busy) return;
    setErr(''); setOk('');
    if (confirm) {
      if (!plate.trim()) { setErr('请填写车牌'); return; }
      if (!/^1\d{10}$/.test(contactPhone.trim())) { setErr('请填写 11 位手机号'); return; }
      if (intake.kind === 'family' && !relation.trim()) { setErr('请写明车主与业主的关系'); return; }
      if (!keep.length && !picks.length) { setErr('请先上传资料再确认'); return; }
    }
    setBusy(confirm ? '确认' : '保存');
    try {
      const saved = await saveOfficeIntake(intake.id, {
        operationKey: newOfficeKey(), expectedVersion: intake.dataVersion ?? 0, confirm,
        plate: plate.trim().toUpperCase(), contactName: contactName.trim(), contactPhone: contactPhone.trim(),
        ...(intake.kind === 'family' ? { relation: relation.trim() } : {}),
        registrationTerm: term, keepFileIndexes: keep,
      }, picks.map(pick => pick.file));
      if (!mounted.current) return;
      onSaved(saved as Intake);
      setPicks(current => { current.forEach(pick => URL.revokeObjectURL(pick.url)); return []; });
      setKeep(((saved as Intake).files ?? []).map(file => file.index));
      setOk(confirm ? '已确认并提交办公室审核' : '草稿已保存，尚未提交审核');
    } catch (error) {
      if (mounted.current) setErr(error instanceof Error ? error.message : '保存失败，请重试；已填写内容和选择的资料都还在');
    } finally {
      if (mounted.current) setBusy('');
    }
  };

  return <section className="np-office" aria-label="办公室代填资料">
    <div className="np-office-head">
      <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Icon name={open ? 'chev' : 'edit'} size={16} />{open ? '收起办公室代填' : '办公室代填 / 上传资料'}
      </button>
      <span className="muted">资料版本 v{intake.dataVersion} · {intake.inputSource === 'office' ? '办公室填写' : '业主填写'} · {intake.officeConfirmedVersion === intake.dataVersion ? '办公室已确认当前版本' : '尚未确认当前版本'}</span>
    </div>
    {open ? <div className="np-office-body">
      <p className="np-garage-help">业主不用手机也能办：办公室在这里代填并上传资料，确认后进入办公室审核。与业主扫码提交互不覆盖；任何修改都会生成新资料版本，原确认和审批失效。</p>
      <div className="np-fields">
        <label>车牌<input className="in" aria-label="办公室代填车牌" value={plate} maxLength={12} disabled={!!busy} onChange={event => setPlate(event.target.value.toUpperCase())} placeholder="例如 豫GQ3N07" /></label>
        <label>车主（选填）<input className="in" aria-label="办公室代填车主" value={contactName} maxLength={50} disabled={!!busy} onChange={event => setContactName(event.target.value)} /></label>
        <label>手机<input className="in" aria-label="办公室代填手机" value={contactPhone} maxLength={30} disabled={!!busy} onChange={event => setContactPhone(event.target.value)} placeholder="11 位手机号" /></label>
        {intake.kind === 'family' ? <label>与业主关系<input className="in" aria-label="办公室代填关系" value={relation} maxLength={12} disabled={!!busy} onChange={event => setRelation(event.target.value)} placeholder="如父母、子女、表姐" /></label> : null}
      </div>
      <RegistrationTermEditor value={term} disabled={!!busy} onChange={setTerm} />
      <div
        ref={pasteRef}
        className="np-office-drop"
        role="button"
        tabIndex={0}
        aria-label="上传资料：点击选择、拖拽或按 Ctrl+V 粘贴"
        aria-disabled={!!busy}
        onClick={() => inputRef.current?.click()}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inputRef.current?.click(); } }}
        onPaste={paste}
        onDragOver={event => { event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); add(event.dataTransfer?.files ?? null); }}
      >
        <Icon name="image" size={20} />
        <b>点击选择 / 拖拽照片到这里 / 点这里后按 Ctrl+V 粘贴截图</b>
        <span className="muted">支持 JPG、PNG、HEIC、PDF，单份不超过 20MB，最多 10 份</span>
        <input ref={inputRef} type="file" accept="image/*,application/pdf" multiple hidden disabled={!!busy}
          onChange={event => { add(event.target.files); event.target.value = ''; }} />
      </div>
      {intake.files.length || picks.length ? <div className="np-files">
        {intake.files.map(file => keep.includes(file.index) ?
          <span key={`kept-${file.index}`} className="np-office-file">
            {file.contentType.startsWith('image/') ? <img src={file.fileUrl} alt="" loading="lazy" /> : <Icon name="file" size={20} />}
            <span className="np-file-caption">{file.fileName}</span>
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => setKeep(current => current.filter(index => index !== file.index))} aria-label={`本次不保留 ${file.fileName}`}>移除</button>
          </span> : null)}
        {picks.map((pick, index) => <span key={`new-${index}`} className="np-office-file">
          {pick.isImg ? <img src={pick.url} alt="" /> : <Icon name="file" size={20} />}
          <span className="np-file-caption">{pick.file.name || '照片'}</span>
          <button type="button" className="btn sm" disabled={!!busy} onClick={() => removePick(index)} aria-label={`移除 ${pick.file.name}`}>移除</button>
        </span>)}
      </div> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        <button type="button" className="btn" disabled={!!busy} onClick={() => submit(false)}>{busy === '保存' ? '保存中…' : '保存草稿'}</button>
        <button type="button" className="btn p" disabled={!!busy} onClick={() => submit(true)}>{busy === '确认' ? '确认中…' : '确认并提交审核'}</button>
        <button type="button" className="btn g sm" disabled={!!busy} onClick={reset}>恢复已保存内容</button>
        <span className="muted">{keep.length + picks.length} 份资料</span>
      </div>
      {err ? <div className="note2" role="alert" style={{ color: 'var(--dang)', marginTop: 8 }}><Icon name="alert" />{err}</div> : null}
      {ok ? <div className="note2" role="status" style={{ marginTop: 8 }}><Icon name="check" />{ok}</div> : null}
    </div> : null}
  </section>;
}
