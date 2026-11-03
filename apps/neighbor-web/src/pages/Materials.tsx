import { useEffect, useMemo, useState } from 'react';
import { inventory, request } from '@pms/api-client';
import type { MaterialView, MaterialCategoryView } from '@pms/shared-types';
import { money } from '@/lib/format';
import PhotoField from '@/components/PhotoField';
import Icon from '@/components/Icon';
import { Btn, Field, Loading, Sheet, toast } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';

interface Usage { id: number; used: boolean; where: string[]; lockedFields: string[] }
interface Draft {
  name: string; spec: string; category: string; unit: string; cost: string;
  aliases: string; params: string; photos: string[]; enabled: boolean;
}
const PHOTO_LIMIT = 4;
const empty: Draft = { name: '', spec: '', category: '', unit: '个', cost: '', aliases: '', params: '', photos: [], enabled: true };
const splitAliases = (s: string) => s.split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);

/**
 * 材料SKU：每种材料的参数与照片只在这里维护一次，入库、调拨、领料、采购时直接选用。
 * 编辑/删除规则（后端兜底校验）：
 *  - 已被任何单据使用 → 不能删除（提示停用）；名称/规格/单位/分类/参数锁定；
 *  - 参考价格、图片、别名、启停用随时可改（工单扣料扣的是库存批次成本，不受参考价影响）。
 */
export default function Materials() {
  const [list, setList] = useState<MaterialView[] | null>(null);
  const [cats, setCats] = useState<MaterialCategoryView[]>([]);
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const [showOff, setShowOff] = useState(false);
  const [editing, setEditing] = useState<MaterialView | 'new' | null>(null);

  const load = () => inventory.listMaterials().then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
    inventory.listMaterialCategories().then(setCats).catch(() => setCats([]));
  }, []);

  const rows = useMemo(() => {
    let l = (list ?? []).filter((m) => showOff || m.enabled);
    if (cat) l = l.filter((m) => m.category === cat);
    const kw = q.trim().toLowerCase();
    if (kw) l = l.filter((m) => [m.name, m.spec, m.code, ...(m.aliases || [])].some((s) => (s || '').toLowerCase().includes(kw)));
    return l;
  }, [list, cat, q, showOff]);

  if (list === null) return <Loading />;

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="materials" /><h1 style={{ fontSize: 22 }}>材料SKU</h1></div><p>每种材料的参数与照片只在这里维护一次，入库、调拨、领料、采购时直接选用，不用重复填写 · 共 {rows.length} 项</p></div>
        <div className="act"><button className="btn p" onClick={() => setEditing('new')}><Icon name="plus" size={18} />新建 SKU</button></div>
      </div>

      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips">
          <button className={`chip ${cat === '' ? 'on' : ''}`} onClick={() => setCat('')}>全部</button>
          {cats.filter((c) => c.enabled).map((c) => (
            <button key={c.id} className={`chip ${cat === c.label ? 'on' : ''}`} onClick={() => setCat(c.label)}>{c.label}{c.materialCount ? ` ${c.materialCount}` : ''}</button>
          ))}
        </div>
        <button className={`chip ${showOff ? 'on' : ''}`} onClick={() => setShowOff(!showOff)}>含已停用</button>
        <input className="in" style={{ width: 260, marginLeft: 'auto' }} value={q} placeholder="搜名称 / 规格 / 编码 / 别名" onChange={(e) => setQ(e.target.value)} />
      </div>

      {rows.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center', marginTop: 4 }}><span className="muted">没有匹配的材料</span></div>
      ) : (
        <div className="card" style={{ overflow: 'hidden', marginTop: 4 }}>
          <div className="rowList">
            {rows.map((m) => (
              <div key={m.id} className="lrow" style={{ cursor: 'pointer', opacity: m.enabled ? 1 : 0.55 }} onClick={() => setEditing(m)}>
                {m.photoUrl
                  ? <img className="stock-thumb" src={m.photoUrl} alt={m.name} />
                  : <span className="stock-thumb is-empty"><Icon name="box" size={26} /></span>}
                <div className="lt">
                  <b>{m.name}{m.spec ? <span className="muted" style={{ fontWeight: 400 }}> · {m.spec}</span> : null}{m.enabled ? null : <span className="tag mute" style={{ marginLeft: 6 }}>已停用</span>}</b>
                  <small>{m.code}{m.category ? ` · ${m.category}` : ''} · 单位：{m.unit}{m.aliases?.length ? ` · 别名：${m.aliases.join('、')}` : ''}</small>
                </div>
                {m.defaultCostCents ? <b className="money">{money(m.defaultCostCents / 100)}<span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>/{m.unit}</span></b> : <span className="muted" style={{ fontSize: 13 }}>未定价</span>}
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); setEditing(m); }}><Icon name="gear" size={15} />编辑</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="note2" style={{ marginTop: 16 }}><Icon name="alert" />已被入库、库存、工单、采购、调拨、盘点用过的 SKU 不能删除，名称、规格、单位、分类、参数也不能改（历史单据要能查到原样）；参考价格、图片、别名随时可改，不用了可以停用。</div>

      {editing ? (
        <MaterialEditor
          material={editing === 'new' ? null : editing}
          cats={cats}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => { toast(msg); setEditing(null); await load(); }}
        />
      ) : null}
    </>
  );
}

function MaterialEditor({
  material, cats, onClose, onSaved,
}: {
  material: MaterialView | null;
  cats: MaterialCategoryView[];
  onClose: () => void;
  onSaved: (msg: string) => Promise<void>;
}) {
  const [d, setD] = useState<Draft>(() => material ? {
    name: material.name, spec: material.spec || '', category: material.category || '', unit: material.unit,
    cost: material.defaultCostCents ? String(material.defaultCostCents / 100) : '',
    aliases: (material.aliases || []).join('、'), params: material.params || '',
    photos: (material.photoUrls?.length ? material.photoUrls : material.photoUrl ? [material.photoUrl] : []).slice(0, PHOTO_LIMIT),
    enabled: material.enabled,
  } : { ...empty, category: cats.find((c) => c.enabled)?.label || '' });
  const [usage, setUsage] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((p) => ({ ...p, ...patch }));

  useEffect(() => {
    if (!material) { setUsage({ id: 0, used: false, where: [], lockedFields: [] }); return; }
    request<Usage>({ url: `/materials/${material.id}/usage` }).then(setUsage).catch(() => setUsage(null));
  }, [material]);

  const locked = !!usage?.used;
  const lockTip = locked ? `已被使用（${usage!.where.join('、')}），不能改` : '';

  const save = async () => {
    if (!d.name.trim()) { toast('请填写名称'); return; }
    if (!d.unit.trim()) { toast('请填写单位'); return; }
    const cost = d.cost.trim() ? Math.round(Number(d.cost) * 100) : 0;
    if (Number.isNaN(cost) || cost < 0) { toast('参考价格不正确'); return; }
    const free = { defaultCostCents: cost, photoUrls: d.photos, aliases: splitAliases(d.aliases), enabled: d.enabled };
    const full = { name: d.name.trim(), spec: d.spec.trim(), category: d.category || undefined, unit: d.unit.trim(), params: d.params.trim(), ...free };
    setBusy(true);
    try {
      if (!material) {
        const created = await inventory.createMaterial(full);
        // 新建接口不一定吃全部字段，保存后补一次多图/别名/参数
        await inventory.updateMaterial(created.id, { photoUrls: free.photoUrls, aliases: free.aliases, params: full.params, enabled: free.enabled });
        await onSaved(`已新建 ${created.code || full.name}`);
      } else {
        await inventory.updateMaterial(material.id, locked ? free : full);
        await onSaved('已保存');
      }
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!material) return;
    if (!window.confirm(`删除「${material.name}」？删除后不可恢复。`)) return;
    setBusy(true);
    try {
      await request({ method: 'DELETE', url: `/materials/${material.id}` });
      await onSaved('已删除');
    } catch (e) { toast(e instanceof Error ? e.message : '删除失败'); }
    finally { setBusy(false); }
  };

  const lockedInput = (v: string, on: (s: string) => void, ph?: string) => (
    <input className="in" value={v} disabled={locked} title={lockTip} placeholder={ph} onChange={(e) => on(e.target.value)} />
  );

  return (
    <Sheet open onClose={onClose} title={material ? `编辑 SKU · ${material.code}` : '新建 SKU'} subtitle={material ? material.name : '名称 + 规格相同视为同一材料，不能重复'} width={560}>
      {material && usage === null ? <Loading text="检查使用情况…" /> : null}
      {locked ? (
        <div className="note2" style={{ marginBottom: 12 }}>
          <Icon name="alert" />此SKU已被使用（{usage!.where.join('、')}）。名称、规格、单位、分类、参数已锁定，参考价格、图片、别名可以改；不再使用请停用。
        </div>
      ) : null}

      <Field label="名称">{lockedInput(d.name, (s) => set({ name: s }), '例如：角阀')}</Field>
      <Field label="规格型号">{lockedInput(d.spec, (s) => set({ spec: s }), '例如：DN15 铜')}</Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="分类">
          <select className="in" value={d.category} disabled={locked} title={lockTip} onChange={(e) => set({ category: e.target.value })}>
            <option value="">（未分类）</option>
            {cats.filter((c) => c.enabled || c.label === d.category).map((c) => <option key={c.id} value={c.label}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="单位">{lockedInput(d.unit, (s) => set({ unit: s }), '个 / 米 / 卷')}</Field>
      </div>
      <Field label="参数（材质、尺寸、品牌等）">
        <textarea className="in" value={d.params} disabled={locked} title={lockTip} onChange={(e) => set({ params: e.target.value })} placeholder="例如：黄铜，4 分接口，品牌 XX" />
      </Field>

      <Field label="参考价格（元 / 单位）" hint="仅用于估价；工单扣料按库存批次成本计算">
        <input className="in" type="number" min={0} step="0.01" value={d.cost} onChange={(e) => set({ cost: e.target.value })} placeholder="0.00" />
      </Field>
      <Field label="别名" hint="现场常用叫法，用顿号或逗号分隔，搜索时都能搜到">
        <input className="in" value={d.aliases} onChange={(e) => set({ aliases: e.target.value })} placeholder="例如：三角阀、角阀门" />
      </Field>

      <Field label={`实物照片（最多 ${PHOTO_LIMIT} 张：正面 / 侧面 / 铭牌 / 包装）`}>
        <PhotoField value={d.photos} onChange={(photos) => set({ photos })} max={PHOTO_LIMIT} size={120} />
      </Field>

      {material ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 14px', fontSize: 15 }}>
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />启用（停用后不再出现在领料、采购、入库的选择里，历史单据不受影响）
        </label>
      ) : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
        <Btn kind="p" size="lg" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Btn>
        <Btn onClick={onClose}>取消</Btn>
        {material ? (
          <span style={{ marginLeft: 'auto' }} title={locked ? '此SKU已被使用，不能删除' : ''}>
            <Btn kind="d" disabled={busy || !usage || locked} onClick={() => void remove()}>删除</Btn>
          </span>
        ) : null}
      </div>
      {material && locked ? <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>此SKU已被使用，不能删除；不再使用可以取消「启用」。</div> : null}
    </Sheet>
  );
}
