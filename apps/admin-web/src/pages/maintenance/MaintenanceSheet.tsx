import { Fragment } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import './maintenance-sheet.css';
import {
  ADDR_SLOTS,
  BACK_COLS,
  BACK_LEFT_W,
  BACK_RIGHT,
  BACK_ROW_H,
  CHECK_GROUPS,
  DETAIL_COLS,
  DETAIL_HEAD_SPLIT,
  FOOTER,
  QUOTA_GROUP_W,
  ROW1,
  ROW2,
  ROW3,
  ROW_H,
  STUB_LABEL_NARROW,
  STUB_LABEL_WIDE,
  STUB_ROWS,
  VOUCHER_SPLIT,
} from './sheet-geometry';
import {
  FEE_CATEGORY_OPTIONS,
  ITEMS_PER_SHEET,
  MATERIALS_PER_SHEET,
  PART_CATEGORY_OPTIONS,
  SHARE_METHOD_OPTIONS,
  centsToYuan,
  formatMD,
  numText,
  parseIsoDate,
  parseMD,
  toNum,
  yuanToCents,
  type MaintenanceItem,
  type MaintenanceMaterial,
  type MaintenanceOrder,
  type SignSlot,
} from './types';

/**
 * 纸面还原：《房屋修理养护任务单》正反面，铺在 227mm × 116mm 的纸上。
 * 每一格的尺寸都在 sheet-geometry.ts 里（量自 300dpi 1:1 扫描件），要调尺寸去那儿改。
 *
 * 同一个组件既是**填单界面**也是**打印稿**（editable 切换）：
 * 所见即所印，不做两套渲染 —— 两套一定会跑偏，纸上少一格没人发现得了。
 *
 * 明细超过一张纸就再印一张：正面 4 行、背面 7 行（和纸上的格子数一致），
 * 页数取两者较大值，正反配对，方便双面打印。
 */

export interface SheetHandlers {
  onPatch?: (patch: Partial<MaintenanceOrder>) => void;
  onItemPatch?: (index: number, patch: Partial<MaintenanceItem>) => void;
  onMaterialPatch?: (index: number, patch: Partial<MaintenanceMaterial>) => void;
  onSign?: (slot: SignSlot) => void;
}

export interface SheetProps extends SheetHandlers {
  order: MaintenanceOrder;
  /** 第几张纸（1 起） */
  pageNo: number;
  pageCount: number;
  editable: boolean;
  /** 套打：纸是预印好的联单，只印内容 */
  overlay?: boolean;
  /** 定额编号候选（datalist id） */
  quotaListId?: string;
}

export function sheetCount(order: MaintenanceOrder): number {
  return Math.max(
    1,
    Math.ceil((order.items?.length || 0) / ITEMS_PER_SHEET),
    Math.ceil((order.materials?.length || 0) / MATERIALS_PER_SHEET),
  );
}

/**
 * 这一张纸上印的单号 —— 只印**实体联单号**，不印系统单号。
 *
 * 实体联单是一本连号的纸，连打时每印一张号码就往后走一个：库里只存起始号，
 * 第 N 张显示「起始号 + N − 1」，位数保持不变（0119610 → 0119611）。
 * 还没填实体单号就留空 —— 系统号（YH-…）印上去只会和纸上的号对不上账。
 */
export function paperNoForSheet(order: MaintenanceOrder, pageNo: number): string {
  const raw = (order.paperNo || '').trim();
  if (!raw) return '';
  if (!/^\d+$/.test(raw)) return raw;
  return String(Number(raw) + pageNo - 1).padStart(raw.length, '0');
}

// ---------------- 骨架 ----------------

function Row({ h, children }: { h: number; children: ReactNode }) {
  return (
    <div className="mo-row" style={{ height: `${h}mm` }}>
      {children}
    </div>
  );
}

function Cell({
  w,
  grow,
  className = '',
  style,
  children,
}: {
  w?: number;
  grow?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div
      className={`mo-cell ${grow ? 'mo-cell--grow' : ''} ${className}`}
      style={{ width: w ? `${w}mm` : undefined, ...style }}
    >
      {children}
    </div>
  );
}

/** 预印的字段名（套打时整体隐藏） */
function Lb({ children, small }: { children: ReactNode; small?: boolean }) {
  return <span className={`mo-lb ${small ? 'mo-lb--sm' : ''}`}>{children}</span>;
}

function Field({
  value,
  onChange,
  editable,
  className = '',
  placeholder,
  title,
  list,
  wrap,
}: {
  value: string;
  onChange?: (next: string) => void;
  editable: boolean;
  className?: string;
  placeholder?: string;
  title?: string;
  list?: string;
  wrap?: boolean;
}) {
  if (!editable || !onChange) {
    return (
      <div className={`mo-txt ${className}`} title={title}>
        {value}
      </div>
    );
  }
  if (wrap) {
    return (
      <textarea
        className={`mo-in mo-in--wrap ${className}`}
        value={value}
        title={title}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      className={`mo-in ${className}`}
      value={value}
      title={title}
      list={list}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 日期格：纸上写「8/11」，存的是完整日期 */
function DateField({
  value,
  onChange,
  editable,
  refIso,
}: {
  value: string | null;
  onChange?: (next: string | null) => void;
  editable: boolean;
  refIso?: string | null;
}) {
  return (
    <Field
      editable={editable}
      value={formatMD(value)}
      title={value || undefined}
      placeholder="月/日"
      className="mo-in--num"
      onChange={
        onChange ? (text) => onChange(text.trim() ? parseMD(text, refIso) : null) : undefined
      }
    />
  );
}

function Tick({
  on,
  editable,
  onToggle,
}: {
  on: boolean;
  editable: boolean;
  onToggle?: () => void;
}) {
  if (!editable || !onToggle) {
    return <span className="mo-tick">{on ? '✓' : ''}</span>;
  }
  return (
    <span
      className="mo-check"
      role="checkbox"
      aria-checked={on}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="mo-tick">{on ? '✓' : ''}</span>
    </span>
  );
}

/**
 * 签名位。签了就只显示手迹（那就是名字）；没签显示打印的姓名，
 * 纸上仍有位置让人手签 —— 不是所有人都在电脑前。
 */
function SignSlotBox({
  url,
  name,
  editable,
  onSign,
  hint,
}: {
  url: string | null;
  name: string | null;
  editable: boolean;
  onSign?: () => void;
  hint?: string;
}) {
  const body = url ? (
    <img className="mo-sign" src={url} alt={name || '签名'} />
  ) : (
    <>
      <span className="mo-txt">{name || ''}</span>
      {editable && onSign && <span className="mo-signslot__hint">{hint || '点此签名'}</span>}
    </>
  );
  return (
    <div
      className={`mo-signslot ${editable && onSign ? 'mo-signslot--clickable' : ''}`}
      onClick={editable && onSign ? onSign : undefined}
      title={editable && onSign ? '点击签名（可发到手机上签）' : undefined}
    >
      {body}
    </div>
  );
}

function AddrSlot({
  width,
  unit,
  value,
  editable,
  onChange,
}: {
  /** 百分比；不给就占满剩下的 */
  width?: number;
  unit: string;
  value: string;
  editable: boolean;
  onChange?: (next: string) => void;
}) {
  return (
    <span className="mo-addr__slot" style={width ? { flex: `0 0 ${width}%` } : { flex: '1 1 auto' }}>
      <Field editable={editable} value={value} onChange={onChange} className="mo-in--addr" />
      <span className="mo-addr__unit">{unit}</span>
    </span>
  );
}

/** 一组「名称 + 勾选框」：点中的那个打 ✓，再点一下取消 */
function TickGroup({
  options,
  sizes,
  value,
  editable,
  onPick,
}: {
  options: { value: string; label: string }[];
  /** 每项的 [名称宽, 勾选框宽]，量自纸面 */
  sizes: readonly (readonly [number, number])[];
  value: string | null;
  editable: boolean;
  onPick?: (next: string) => void;
}) {
  return (
    <>
      {options.map((opt, i) => (
        <Fragment key={opt.value}>
          <Cell w={sizes[i][0]}>
            <Lb small>{opt.label}</Lb>
          </Cell>
          <Cell w={sizes[i][1]}>
            <Tick
              on={value === opt.value}
              editable={editable}
              onToggle={onPick && (() => onPick(value === opt.value ? '' : opt.value))}
            />
          </Cell>
        </Fragment>
      ))}
    </>
  );
}

/**
 * 标题带：标题在表格上**左右居中**，单号紧挨着标题右边 —— 纸上就是这么排的
 * （量到标题中心 988px、表格中心 998px，基本重合；单号从标题右边 1.8mm 处起）。
 * 单号用绝对定位挂在标题右侧，不参与居中计算，否则标题会被单号推向左边。
 */
function SheetHead({
  title,
  no,
  page,
  spaced,
}: {
  title: string;
  no?: string;
  page?: string;
  spaced?: boolean;
}) {
  return (
    <div className="mo-head">
      <span className="mo-head__anchor">
        <span className={`mo-title ${spaced ? 'mo-title--spaced' : ''}`}>{title}</span>
        {(no || page) && (
          <span className="mo-head__after">
            {no && <span className="mo-no">{no}</span>}
            {page && <span className="mo-no__page">{page}</span>}
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------- 正面 ----------------

export function MaintenanceFront(props: SheetProps) {
  const { order, pageNo, pageCount, editable, overlay, quotaListId } = props;
  const patch = props.onPatch;
  const text = (v: string | null | undefined) => v || '';
  const isLast = pageNo === pageCount;
  const offset = (pageNo - 1) * ITEMS_PER_SHEET;
  const rows: (MaintenanceItem | null)[] = Array.from(
    { length: ITEMS_PER_SHEET },
    (_, i) => order.items?.[offset + i] ?? null,
  );
  const inspectedAt = parseIsoDate(order.inspectedAt);
  const paperNo = paperNoForSheet(order, pageNo);
  const pageMark = pageCount > 1 ? `（第 ${pageNo} 页 / 共 ${pageCount} 页）` : '';

  return (
    <div className={`mo-sheet ${overlay ? 'mo-sheet--overlay' : ''}`}>
      <div className="mo-perf" />

      <div className="mo-block mo-block--main">
        <SheetHead title="房屋修理养护任务单" no={paperNo} page={pageMark} />

        <div className="mo-unitline">
          <Lb>管房单位</Lb>
          <span className="mo-unitline__value">
            <Field
              editable={editable}
              value={text(order.unitName)}
              onChange={patch && ((v) => patch({ unitName: v }))}
            />
          </span>
        </div>

        <div className="mo-tbl">
          {/* 第 1 行：报修人 / 地址 / 报修日期 / 有人时间 / 验收 */}
          <Row h={ROW_H.reporter}>
            <Cell w={ROW1[0]}>
              <Lb>{'报修人\n姓名'}</Lb>
            </Cell>
            <Cell w={ROW1[1]}>
              <Field
                editable={editable}
                value={text(order.reporterName)}
                onChange={patch && ((v) => patch({ reporterName: v }))}
              />
            </Cell>
            <Cell w={ROW1[2]}>
              <Lb>地址</Lb>
            </Cell>
            <Cell w={ROW1[3]}>
              {/* 纸上是两行：上行只有「村」，正对着下行的「弄」 */}
              <div className="mo-addr">
                <div className="mo-addr__row">
                  <AddrSlot
                    width={ADDR_SLOTS.road + ADDR_SLOTS.lane}
                    unit="村"
                    value={text(order.addrVillage)}
                    editable={editable}
                    onChange={patch && ((v) => patch({ addrVillage: v }))}
                  />
                  <span style={{ flex: '1 1 auto' }} />
                </div>
                <div className="mo-addr__row">
                  <AddrSlot
                    width={ADDR_SLOTS.road}
                    unit="路"
                    value={text(order.addrRoad)}
                    editable={editable}
                    onChange={patch && ((v) => patch({ addrRoad: v }))}
                  />
                  <AddrSlot
                    width={ADDR_SLOTS.lane}
                    unit="弄"
                    value={text(order.addrLane)}
                    editable={editable}
                    onChange={patch && ((v) => patch({ addrLane: v }))}
                  />
                  <AddrSlot
                    width={ADDR_SLOTS.buildingNo}
                    unit="号"
                    value={text(order.addrBuildingNo)}
                    editable={editable}
                    onChange={patch && ((v) => patch({ addrBuildingNo: v }))}
                  />
                  <AddrSlot
                    width={ADDR_SLOTS.room}
                    unit="室"
                    value={text(order.addrRoom)}
                    editable={editable}
                    onChange={patch && ((v) => patch({ addrRoom: v }))}
                  />
                </div>
              </div>
            </Cell>
            <Cell w={ROW1[4]}>
              <Lb>{'报修\n日期'}</Lb>
            </Cell>
            <Cell w={ROW1[5]}>
              <DateField
                editable={editable}
                value={order.reportedOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ reportedOn: v }))}
              />
            </Cell>
            <Cell w={ROW1[6]}>
              <Lb>{'有人\n时间'}</Lb>
            </Cell>
            <Cell w={ROW1[7]}>
              <Field
                editable={editable}
                value={text(order.presentTime)}
                onChange={patch && ((v) => patch({ presentTime: v }))}
              />
            </Cell>
            <Cell grow>
              <Lb>报修人(户)验收</Lb>
            </Cell>
          </Row>

          {/* 第 2 行：报修部位 / 项目 / 三个日期 */}
          <Row h={ROW_H.part}>
            <Cell w={ROW2[0]}>
              <Lb>{'报修\n部位'}</Lb>
            </Cell>
            <Cell w={ROW2[1]}>
              <Field
                editable={editable}
                value={text(order.faultPart)}
                onChange={patch && ((v) => patch({ faultPart: v }))}
              />
            </Cell>
            <Cell w={ROW2[2]}>
              <Lb>{'报修\n项目'}</Lb>
            </Cell>
            <Cell w={ROW2[3]}>
              <Field
                editable={editable}
                value={text(order.repairItem)}
                onChange={patch && ((v) => patch({ repairItem: v }))}
              />
            </Cell>
            <Cell w={ROW2[4]}>
              <Lb>{'预约\n日期'}</Lb>
            </Cell>
            <Cell w={ROW2[5]}>
              <DateField
                editable={editable}
                value={order.appointOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ appointOn: v }))}
              />
            </Cell>
            <Cell w={ROW2[6]}>
              <Lb>{'开工\n日期'}</Lb>
            </Cell>
            <Cell w={ROW2[7]}>
              <DateField
                editable={editable}
                value={order.startOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ startOn: v }))}
              />
            </Cell>
            <Cell w={ROW2[8]}>
              <Lb>{'完工\n日期'}</Lb>
            </Cell>
            <Cell w={ROW2[9]}>
              <DateField
                editable={editable}
                value={order.finishOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ finishOn: v }))}
              />
            </Cell>
            <Cell grow>
              <SignSlotBox
                url={order.ownerSignUrl}
                name={null}
                editable={editable}
                onSign={props.onSign && (() => props.onSign?.('owner'))}
                hint="业主签名"
              />
            </Cell>
          </Row>

          {/* 第 3 行：三个括号 */}
          <Row h={ROW_H.category}>
            <Cell w={ROW3[0]}>
              <span className="mo-paren">
                <Lb>修缮日期（</Lb>
                <Field
                  editable={editable}
                  value={text(order.repairDateText)}
                  className="mo-in--paren"
                  onChange={patch && ((v) => patch({ repairDateText: v }))}
                />
                <Lb>）</Lb>
              </span>
            </Cell>
            <Cell w={ROW3[1]}>
              <span className="mo-paren">
                <Lb>费用类别（</Lb>
                <Field
                  editable={editable}
                  value={text(order.feeCategoryText)}
                  className="mo-in--paren"
                  onChange={patch && ((v) => patch({ feeCategoryText: v }))}
                />
                <Lb>）</Lb>
              </span>
            </Cell>
            <Cell grow>
              <span className="mo-paren">
                <Lb>分摊方式（</Lb>
                <Field
                  editable={editable}
                  value={text(order.shareMethodText)}
                  className="mo-in--paren"
                  onChange={patch && ((v) => patch({ shareMethodText: v }))}
                />
                <Lb>）</Lb>
              </span>
            </Cell>
          </Row>

          {/* 第 4 行：三组勾选。三组的分界和上一行的三格并不对齐 —— 纸上就是错开的 */}
          <Row h={ROW_H.checks}>
            <TickGroup
              options={PART_CATEGORY_OPTIONS}
              sizes={CHECK_GROUPS.part}
              value={order.partCategory}
              editable={editable}
              onPick={patch && ((v) => patch({ partCategory: v }))}
            />
            <TickGroup
              options={FEE_CATEGORY_OPTIONS}
              sizes={CHECK_GROUPS.fee}
              value={order.feeCategory}
              editable={editable}
              onPick={patch && ((v) => patch({ feeCategory: v }))}
            />
            <TickGroup
              options={SHARE_METHOD_OPTIONS}
              sizes={CHECK_GROUPS.share}
              value={order.shareMethod}
              editable={editable}
              onPick={patch && ((v) => patch({ shareMethod: v }))}
            />
          </Row>

          {/* 第 5 行：明细表头 */}
          <Row h={ROW_H.detailHead}>
            <Cell w={DETAIL_COLS.part}>
              <Lb>{'查勘\n部位'}</Lb>
            </Cell>
            <Cell w={DETAIL_COLS.name}>
              <Lb>查勘修理项目</Lb>
            </Cell>
            <Cell w={DETAIL_COLS.surveyQty}>
              <Lb>{'查勘\n数量'}</Lb>
            </Cell>
            <Cell w={DETAIL_COLS.actualQty}>
              <Lb>{'实做\n数量'}</Lb>
            </Cell>
            <Cell w={DETAIL_COLS.actualHours}>
              <Lb>{'实做\n工时'}</Lb>
            </Cell>
            <Cell w={DETAIL_COLS.measureQty}>
              <Lb>{'量方\n数量'}</Lb>
            </Cell>
            <Cell w={QUOTA_GROUP_W} className="mo-col2">
              <div className="mo-sub" style={{ height: `${DETAIL_HEAD_SPLIT.top}mm` }}>
                <Lb>预 算 定 额</Lb>
              </div>
              <div className="mo-sub" style={{ height: `${DETAIL_HEAD_SPLIT.bottom}mm` }}>
                <div className="mo-subrow">
                  <Cell w={DETAIL_COLS.quotaCode}>
                    <Lb>编号</Lb>
                  </Cell>
                  <Cell w={DETAIL_COLS.quotaHours}>
                    <Lb>工时</Lb>
                  </Cell>
                  <Cell grow>
                    <Lb>人工费</Lb>
                  </Cell>
                </div>
              </div>
            </Cell>
            <Cell w={DETAIL_COLS.materialFee}>
              <Lb>材料费</Lb>
            </Cell>
            <Cell w={DETAIL_COLS.quality}>
              <Lb>{'质量\n验收'}</Lb>
            </Cell>
            <Cell grow>
              <Lb>备注</Lb>
            </Cell>
          </Row>

          {/* 明细行 */}
          {rows.map((item, i) => {
            const index = offset + i;
            const patchItem = props.onItemPatch;
            const numCell = (key: keyof MaintenanceItem, width: number) => (
              <Cell w={width}>
                <Field
                  editable={editable}
                  className="mo-in--num"
                  value={numText(item?.[key] as number | null)}
                  onChange={
                    patchItem &&
                    ((v) => patchItem(index, { [key]: toNum(v) } as Partial<MaintenanceItem>))
                  }
                />
              </Cell>
            );
            return (
              <Row h={ROW_H.detail} key={index}>
                <Cell w={DETAIL_COLS.part}>
                  <Field
                    editable={editable}
                    value={item?.part || ''}
                    onChange={patchItem && ((v) => patchItem(index, { part: v }))}
                  />
                </Cell>
                <Cell w={DETAIL_COLS.name}>
                  <Field
                    editable={editable}
                    className="mo-in--left"
                    value={item?.name || ''}
                    onChange={patchItem && ((v) => patchItem(index, { name: v }))}
                  />
                </Cell>
                {numCell('surveyQty', DETAIL_COLS.surveyQty)}
                {numCell('actualQty', DETAIL_COLS.actualQty)}
                {numCell('actualHours', DETAIL_COLS.actualHours)}
                {numCell('measureQty', DETAIL_COLS.measureQty)}
                <Cell w={DETAIL_COLS.quotaCode}>
                  <Field
                    editable={editable}
                    list={quotaListId}
                    className="mo-in--num mo-in--code"
                    value={item?.quotaCode || ''}
                    onChange={patchItem && ((v) => patchItem(index, { quotaCode: v }))}
                  />
                </Cell>
                {numCell('quotaHours', DETAIL_COLS.quotaHours)}
                <Cell w={DETAIL_COLS.laborFee}>
                  <Field
                    editable={editable}
                    className="mo-in--num"
                    value={centsToYuan(item?.laborFeeCents)}
                    onChange={
                      patchItem && ((v) => patchItem(index, { laborFeeCents: yuanToCents(v) }))
                    }
                  />
                </Cell>
                <Cell w={DETAIL_COLS.materialFee}>
                  <Field
                    editable={editable}
                    className="mo-in--num"
                    value={centsToYuan(item?.materialFeeCents)}
                    onChange={
                      patchItem && ((v) => patchItem(index, { materialFeeCents: yuanToCents(v) }))
                    }
                  />
                </Cell>
                <Cell w={DETAIL_COLS.quality}>
                  <Field
                    editable={editable}
                    value={item?.quality || ''}
                    onChange={patchItem && ((v) => patchItem(index, { quality: v }))}
                  />
                </Cell>
                <Cell grow>
                  <Field
                    editable={editable}
                    className="mo-in--note"
                    value={item?.note || ''}
                    onChange={patchItem && ((v) => patchItem(index, { note: v }))}
                  />
                </Cell>
              </Row>
            );
          })}

          {/* 页脚：三个签名 + 合计 + 凭证发放 */}
          <Row h={ROW_H.footer}>
            <Cell w={FOOTER.fillerLabel}>
              <span className="mo-vlabel">填单人</span>
            </Cell>
            <Cell w={FOOTER.fillerValue}>
              <SignSlotBox
                url={order.fillerSignUrl}
                name={order.fillerName}
                editable={editable}
                onSign={props.onSign && (() => props.onSign?.('filler'))}
              />
            </Cell>
            <Cell w={FOOTER.repairerLabel}>
              <span className="mo-vlabel">修理人</span>
            </Cell>
            <Cell w={FOOTER.repairerValue}>
              <SignSlotBox
                url={order.repairerSignUrl}
                name={order.repairerName}
                editable={editable}
                onSign={props.onSign && (() => props.onSign?.('repairer'))}
              />
            </Cell>
            <Cell w={FOOTER.inspectorLabel}>
              <span className="mo-vlabel">查验员</span>
            </Cell>
            <Cell w={FOOTER.inspectorValue}>
              {/* 查验员这一格在表单里不给点：签名只能从「查验并签名」进来，
                  否则填单的人自己就把经理的字签了 */}
              <SignSlotBox
                url={order.inspectorSignUrl}
                name={order.inspectorName}
                editable={false}
              />
              <span className="mo-md">
                <span className="mo-md__n">{inspectedAt ? inspectedAt.getMonth() + 1 : ''}</span>
                <Lb>月</Lb>
                <span className="mo-md__n">{inspectedAt ? inspectedAt.getDate() : ''}</span>
                <Lb>日</Lb>
              </span>
            </Cell>
            <Cell w={FOOTER.quotaFeeLabel}>
              <span className="mo-vpair">
                <span className="mo-vlabel">定额</span>
                <span className="mo-vlabel">工料费</span>
              </span>
            </Cell>
            <Cell w={FOOTER.total}>
              <span className="mo-total">
                <span className="mo-total__lb">合计</span>
                <span className="mo-total__v">{isLast ? centsToYuan(order.totalCents) : ''}</span>
              </span>
            </Cell>
            <Cell grow className="mo-col2">
              <div className="mo-sub" style={{ height: `${VOUCHER_SPLIT.label}mm` }}>
                <Lb>凭证发放</Lb>
              </div>
              <div className="mo-sub" style={{ height: `${VOUCHER_SPLIT.value}mm` }}>
                <Field
                  editable={editable}
                  value={text(order.voucherIssue)}
                  onChange={patch && ((v) => patch({ voucherIssue: v }))}
                />
              </div>
            </Cell>
          </Row>
        </div>
      </div>

      {/* 右边的「报修凭证」存根 */}
      <div className="mo-block mo-block--stub">
        <div className="mo-head mo-head--stubno">
          {paperNo && <span className="mo-no">{paperNo}</span>}
        </div>
        <SheetHead title="报修凭证" />
        <div className="mo-tbl">
          <Row h={STUB_ROWS[0]}>
            <Cell w={STUB_LABEL_NARROW}>
              <Lb>{'报修\n日期'}</Lb>
            </Cell>
            <Cell grow>
              <span className="mo-ymd">
                <span className="mo-md__n">{ymd(order.reportedOn).y}</span>
                <Lb>年</Lb>
                <span className="mo-md__n">{ymd(order.reportedOn).m}</span>
                <Lb>月</Lb>
                <span className="mo-md__n">{ymd(order.reportedOn).d}</span>
                <Lb>日</Lb>
              </span>
            </Cell>
          </Row>
          <Row h={STUB_ROWS[1]}>
            <Cell w={STUB_LABEL_WIDE}>
              <Lb>{'报修人\n姓名'}</Lb>
            </Cell>
            <Cell grow>
              <div className="mo-txt">{text(order.reporterName)}</div>
            </Cell>
          </Row>
          <Row h={STUB_ROWS[2]}>
            <Cell w={STUB_LABEL_NARROW}>
              <Lb>{'报修\n部位'}</Lb>
            </Cell>
            <Cell grow>
              <div className="mo-txt">{text(order.faultPart)}</div>
            </Cell>
          </Row>
          <Row h={STUB_ROWS[3]}>
            <Cell grow>
              <Lb>报 修 项 目</Lb>
            </Cell>
          </Row>
          <Row h={STUB_ROWS[4]}>
            <Cell grow className="mo-cell--left">
              <div className="mo-txt mo-txt--left">{text(order.repairItem)}</div>
            </Cell>
          </Row>
          <Row h={STUB_ROWS[5]}>
            <Cell grow />
          </Row>
          <Row h={STUB_ROWS[6]}>
            <Cell grow />
          </Row>
          <Row h={STUB_ROWS[7]}>
            <Cell grow />
          </Row>
          <Row h={STUB_ROWS[8]}>
            <Cell grow />
          </Row>
          <Row h={STUB_ROWS[9]}>
            <Cell w={STUB_LABEL_WIDE}>
              <Lb>填单人</Lb>
            </Cell>
            <Cell grow>
              <div className="mo-txt">{text(order.fillerName)}</div>
            </Cell>
          </Row>
        </div>
      </div>
    </div>
  );
}

// ---------------- 背面 ----------------

export function MaintenanceBack(props: SheetProps) {
  const { order, pageNo, pageCount, editable, overlay } = props;
  const patch = props.onPatch;
  const isLast = pageNo === pageCount;
  const offset = (pageNo - 1) * MATERIALS_PER_SHEET;
  const rows: (MaintenanceMaterial | null)[] = Array.from(
    { length: MATERIALS_PER_SHEET },
    (_, i) => order.materials?.[offset + i] ?? null,
  );
  const patchMaterial = props.onMaterialPatch;
  const paperNo = paperNoForSheet(order, pageNo);

  return (
    <div className={`mo-sheet mo-sheet--back ${overlay ? 'mo-sheet--overlay' : ''}`}>
      <div className="mo-perf" />

      <div className="mo-block mo-block--main">
        <SheetHead
          title="材料领耗记录"
          spaced
          no={pageCount > 1 ? paperNo : undefined}
          page={pageCount > 1 ? `（第 ${pageNo} 页 / 共 ${pageCount} 页）` : ''}
        />
        <div className="mo-unitline" />

        <div className="mo-back-grid">
          <div className="mo-back-grid__left" style={{ flex: `0 0 ${BACK_LEFT_W}mm` }}>
            <div className="mo-tbl">
              <Row h={BACK_ROW_H.head}>
                <Cell w={BACK_COLS.name}>
                  <Lb>材料名称</Lb>
                </Cell>
                <Cell w={BACK_COLS.spec}>
                  <Lb>规格</Lb>
                </Cell>
                <Cell w={BACK_COLS.unit}>
                  <Lb>单位</Lb>
                </Cell>
                <Cell w={BACK_COLS.estQty}>
                  <Lb>{'估料\n数量'}</Lb>
                </Cell>
                <Cell w={BACK_COLS.pickQty}>
                  <Lb>{'领料\n数量'}</Lb>
                </Cell>
                <Cell w={BACK_COLS.usedQty}>
                  <Lb>{'实耗\n数量'}</Lb>
                </Cell>
                <Cell w={BACK_COLS.returnQty}>
                  <Lb>{'退料\n数量'}</Lb>
                </Cell>
                <Cell w={BACK_COLS.amount}>
                  <Lb>{'实耗\n金额'}</Lb>
                </Cell>
                <Cell grow>
                  <Lb>备 注</Lb>
                </Cell>
              </Row>
              {rows.map((row, i) => {
                const index = offset + i;
                const numCell = (key: keyof MaintenanceMaterial, width: number) => (
                  <Cell w={width}>
                    <Field
                      editable={editable}
                      className="mo-in--num"
                      value={numText(row?.[key] as number | null)}
                      onChange={
                        patchMaterial &&
                        ((v) =>
                          patchMaterial(index, { [key]: toNum(v) } as Partial<MaintenanceMaterial>))
                      }
                    />
                  </Cell>
                );
                return (
                  <Row h={BACK_ROW_H.detail} key={index}>
                    <Cell w={BACK_COLS.name}>
                      <Field
                        editable={editable}
                        className="mo-in--left"
                        value={row?.name || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { name: v }))}
                      />
                    </Cell>
                    <Cell w={BACK_COLS.spec}>
                      <Field
                        editable={editable}
                        className="mo-in--spec"
                        value={row?.spec || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { spec: v }))}
                      />
                    </Cell>
                    <Cell w={BACK_COLS.unit}>
                      <Field
                        editable={editable}
                        className="mo-in--spec"
                        value={row?.unit || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { unit: v }))}
                      />
                    </Cell>
                    {numCell('estQty', BACK_COLS.estQty)}
                    {numCell('pickQty', BACK_COLS.pickQty)}
                    {numCell('usedQty', BACK_COLS.usedQty)}
                    {numCell('returnQty', BACK_COLS.returnQty)}
                    <Cell w={BACK_COLS.amount}>
                      <Field
                        editable={editable}
                        className="mo-in--num"
                        value={centsToYuan(row?.amountCents)}
                        onChange={
                          patchMaterial &&
                          ((v) => patchMaterial(index, { amountCents: yuanToCents(v) }))
                        }
                      />
                    </Cell>
                    <Cell grow>
                      <Field
                        editable={editable}
                        className="mo-in--left mo-in--note"
                        value={row?.note || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { note: v }))}
                      />
                    </Cell>
                  </Row>
                );
              })}
              <Row h={BACK_ROW_H.service}>
                <Cell w={BACK_COLS.name}>
                  <Lb>服务记录</Lb>
                </Cell>
                <Cell grow>
                  <Field
                    editable={editable}
                    value={order.serviceRecord || ''}
                    onChange={patch && ((v) => patch({ serviceRecord: v }))}
                  />
                </Cell>
              </Row>
              <Row h={BACK_ROW_H.followUp}>
                <Cell w={BACK_COLS.name}>
                  <Lb>回访记录</Lb>
                </Cell>
                <Cell grow>
                  <Field
                    editable={editable}
                    value={order.followUpRecord || ''}
                    onChange={patch && ((v) => patch({ followUpRecord: v }))}
                  />
                </Cell>
              </Row>
            </div>
          </div>

          <div className="mo-back-grid__right">
            <Cell style={{ height: `${BACK_RIGHT.head}mm` }}>
              <Lb>{'折旧料或\n整料记录'}</Lb>
            </Cell>
            <Cell style={{ height: `${BACK_RIGHT.scrap}mm`, alignItems: 'flex-start' }}>
              <Field
                editable={editable}
                wrap
                className="mo-in--left"
                value={order.scrapNote || ''}
                onChange={patch && ((v) => patch({ scrapNote: v }))}
              />
            </Cell>
            <Cell style={{ height: `${BACK_RIGHT.totalLabel}mm` }}>
              <Lb>材料合计</Lb>
            </Cell>
            <Cell grow>
              <span className="mo-total__v">
                {isLast ? centsToYuan(order.materialTotalCents) : ''}
              </span>
            </Cell>
          </div>
        </div>
      </div>

      {/* 左边存根背面的「说明」 */}
      <div className="mo-block mo-block--stub">
        <div className="mo-head" style={{ height: '15mm' }}>
          <span className="mo-title mo-title--spaced">说明</span>
        </div>
        <div className="mo-notes">
          <div className="mo-notes__item">
            1、报修后如管房单位未按规定时间派员修理，可凭此证催修。
          </div>
          <div className="mo-notes__item">2、请报修人（户）妥善保存此证，以备查核。</div>
          <div className="mo-notes__item">
            3、报修项目修竣后，请报修人（户）验收、并在《任务单》上签字。
          </div>
          <div className="mo-notes__item">4、报修项目修竣后，此证即行作废。</div>
        </div>
      </div>
    </div>
  );
}

/** 全部纸张：正、背、正、背……方便双面打印 */
export function MaintenanceSheets(props: Omit<SheetProps, 'pageNo' | 'pageCount'>) {
  const count = sheetCount(props.order);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Fragment key={i}>
          <MaintenanceFront {...props} pageNo={i + 1} pageCount={count} />
          <MaintenanceBack {...props} pageNo={i + 1} pageCount={count} />
        </Fragment>
      ))}
    </>
  );
}

function ymd(iso: string | null | undefined): { y: string; m: string; d: string } {
  const date = parseIsoDate(iso);
  if (!date) return { y: '', m: '', d: '' };
  return {
    y: String(date.getFullYear()),
    m: String(date.getMonth() + 1),
    d: String(date.getDate()),
  };
}
