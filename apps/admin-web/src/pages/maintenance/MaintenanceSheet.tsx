import { Fragment } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import './maintenance-sheet.css';
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
 * 纸面还原：《房屋修理养护任务单》正反面，1:1 铺在 227mm × 116mm 的纸上。
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
      placeholder="8/11"
      className="mo-in--num"
      onChange={
        onChange
          ? (text) => onChange(text.trim() ? parseMD(text, refIso) : null)
          : undefined
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
      title={editable && onSign ? '点击手写签名' : undefined}
    >
      {body}
    </div>
  );
}

/** 一组「名称 + 勾选框」：点中的那个打 ✓，再点一下取消 */
function TickGroup({
  options,
  value,
  labelW,
  boxW,
  lastGrow,
  editable,
  onPick,
}: {
  options: { value: string; label: string }[];
  value: string | null;
  labelW: number;
  boxW: number;
  lastGrow?: boolean;
  editable: boolean;
  onPick?: (next: string) => void;
}) {
  return (
    <>
      {options.map((opt, i) => {
        const last = lastGrow && i === options.length - 1;
        return (
          <Fragment key={opt.value}>
            <Cell w={labelW}>
              <Lb small>{opt.label}</Lb>
            </Cell>
            <Cell w={last ? undefined : boxW} grow={last}>
              <Tick
                on={value === opt.value}
                editable={editable}
                onToggle={onPick && (() => onPick(value === opt.value ? '' : opt.value))}
              />
            </Cell>
          </Fragment>
        );
      })}
    </>
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

  return (
    <div className={`mo-sheet ${overlay ? 'mo-sheet--overlay' : ''}`}>
      <div className="mo-perf" />

      <div className="mo-block mo-block--main">
        <div className="mo-head">
          <span className="mo-title">房屋修理养护任务单</span>
          <span className="mo-no">
            {order.paperNo || order.orderNo}
            {pageCount > 1 && (
              <span className="mo-no__page">
                （第 {pageNo} 页 / 共 {pageCount} 页）
              </span>
            )}
          </span>
        </div>

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
          <Row h={9}>
            <Cell w={14}>
              <Lb>{'报修人\n姓名'}</Lb>
            </Cell>
            <Cell w={13}>
              <Field
                editable={editable}
                value={text(order.reporterName)}
                onChange={patch && ((v) => patch({ reporterName: v }))}
              />
            </Cell>
            <Cell w={11}>
              <Lb>地址</Lb>
            </Cell>
            <Cell w={45}>
              <div className="mo-addr">
                {(
                  [
                    ['addrVillage', '村', 1.5],
                    ['addrRoad', '路', 1.5],
                    ['addrLane', '弄', 0.95],
                    ['addrBuildingNo', '号', 0.95],
                    ['addrRoom', '室', 0.95],
                  ] as const
                ).map(([key, unit, weight]) => (
                  <span className="mo-addr__slot" key={key} style={{ flexGrow: weight }}>
                    <Field
                      editable={editable}
                      value={text(order[key] as string | null)}
                      onChange={patch && ((v) => patch({ [key]: v } as Partial<MaintenanceOrder>))}
                    />
                    <span className="mo-addr__unit">{unit}</span>
                  </span>
                ))}
              </div>
            </Cell>
            <Cell w={10.5}>
              <Lb>{'报修\n日期'}</Lb>
            </Cell>
            <Cell w={10.5}>
              <DateField
                editable={editable}
                value={order.reportedOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ reportedOn: v }))}
              />
            </Cell>
            <Cell w={10.5}>
              <Lb>{'有人\n时间'}</Lb>
            </Cell>
            <Cell w={10.5}>
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
          <Row h={9}>
            <Cell w={14}>
              <Lb>{'报修\n部位'}</Lb>
            </Cell>
            <Cell w={13}>
              <Field
                editable={editable}
                value={text(order.faultPart)}
                onChange={patch && ((v) => patch({ faultPart: v }))}
              />
            </Cell>
            <Cell w={11}>
              <Lb>{'报修\n项目'}</Lb>
            </Cell>
            <Cell w={21.5}>
              <Field
                editable={editable}
                value={text(order.repairItem)}
                onChange={patch && ((v) => patch({ repairItem: v }))}
              />
            </Cell>
            <Cell w={11}>
              <Lb>{'预约\n日期'}</Lb>
            </Cell>
            <Cell w={12.5}>
              <DateField
                editable={editable}
                value={order.appointOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ appointOn: v }))}
              />
            </Cell>
            <Cell w={10.5}>
              <Lb>{'开工\n日期'}</Lb>
            </Cell>
            <Cell w={10.5}>
              <DateField
                editable={editable}
                value={order.startOn}
                refIso={order.reportedOn}
                onChange={patch && ((v) => patch({ startOn: v }))}
              />
            </Cell>
            <Cell w={10.5}>
              <Lb>{'完工\n日期'}</Lb>
            </Cell>
            <Cell w={10.5}>
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
          <Row h={7.6}>
            <Cell w={52.5}>
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
            <Cell w={52}>
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

          {/* 第 4 行：三组勾选 —— 每组的总宽和上一行三个括号对齐 */}
          <Row h={7.6}>
            <TickGroup
              options={PART_CATEGORY_OPTIONS}
              value={order.partCategory}
              labelW={11}
              boxW={6.5}
              editable={editable}
              onPick={patch && ((v) => patch({ partCategory: v }))}
            />
            <TickGroup
              options={FEE_CATEGORY_OPTIONS}
              value={order.feeCategory}
              labelW={8.5}
              boxW={4.5}
              editable={editable}
              onPick={patch && ((v) => patch({ feeCategory: v }))}
            />
            <TickGroup
              options={SHARE_METHOD_OPTIONS}
              value={order.shareMethod}
              labelW={12}
              boxW={6.5}
              lastGrow
              editable={editable}
              onPick={patch && ((v) => patch({ shareMethod: v }))}
            />
          </Row>

          {/* 第 5 行：明细表头 */}
          <Row h={10.2}>
            <Cell w={10.5}>
              <Lb>{'查勘\n部位'}</Lb>
            </Cell>
            <Cell w={35.5}>
              <Lb>查勘修理项目</Lb>
            </Cell>
            <Cell w={10}>
              <Lb>{'查勘\n数量'}</Lb>
            </Cell>
            <Cell w={10.5}>
              <Lb>{'实做\n数量'}</Lb>
            </Cell>
            <Cell w={10}>
              <Lb>{'实做\n工时'}</Lb>
            </Cell>
            <Cell w={10.5}>
              <Lb>{'量方\n数量'}</Lb>
            </Cell>
            <Cell w={38} className="mo-col2">
              <div className="mo-sub" style={{ height: '4.2mm' }}>
                <Lb>预 算 定 额</Lb>
              </div>
              <div className="mo-sub" style={{ height: '6mm' }}>
                <div className="mo-subrow">
                  <Cell w={14}>
                    <Lb>编号</Lb>
                  </Cell>
                  <Cell w={9.5}>
                    <Lb>工时</Lb>
                  </Cell>
                  <Cell grow>
                    <Lb>人工费</Lb>
                  </Cell>
                </div>
              </div>
            </Cell>
            <Cell w={13.5}>
              <Lb>材料费</Lb>
            </Cell>
            <Cell w={10}>
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
            const cell = (
              key: keyof MaintenanceItem,
              width: number | undefined,
              grow?: boolean,
            ) => (
              <Cell w={width} grow={grow}>
                <Field
                  editable={editable}
                  className="mo-in--num"
                  value={numText(item?.[key] as number | null)}
                  onChange={
                    patchItem && ((v) => patchItem(index, { [key]: toNum(v) } as Partial<MaintenanceItem>))
                  }
                />
              </Cell>
            );
            return (
              <Row h={6.6} key={index}>
                <Cell w={10.5}>
                  <Field
                    editable={editable}
                    value={item?.part || ''}
                    onChange={patchItem && ((v) => patchItem(index, { part: v }))}
                  />
                </Cell>
                <Cell w={35.5}>
                  <Field
                    editable={editable}
                    className="mo-in--left"
                    value={item?.name || ''}
                    onChange={patchItem && ((v) => patchItem(index, { name: v }))}
                  />
                </Cell>
                {cell('surveyQty', 10)}
                {cell('actualQty', 10.5)}
                {cell('actualHours', 10)}
                {cell('measureQty', 10.5)}
                <Cell w={14}>
                  <Field
                    editable={editable}
                    list={quotaListId}
                    className="mo-in--num mo-in--code"
                    value={item?.quotaCode || ''}
                    onChange={patchItem && ((v) => patchItem(index, { quotaCode: v }))}
                  />
                </Cell>
                {cell('quotaHours', 9.5)}
                <Cell w={14.5}>
                  <Field
                    editable={editable}
                    className="mo-in--num"
                    value={centsToYuan(item?.laborFeeCents)}
                    onChange={
                      patchItem && ((v) => patchItem(index, { laborFeeCents: yuanToCents(v) }))
                    }
                  />
                </Cell>
                <Cell w={13.5}>
                  <Field
                    editable={editable}
                    className="mo-in--num"
                    value={centsToYuan(item?.materialFeeCents)}
                    onChange={
                      patchItem && ((v) => patchItem(index, { materialFeeCents: yuanToCents(v) }))
                    }
                  />
                </Cell>
                <Cell w={10}>
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
          <Row h={14.9}>
            <Cell w={7}>
              <span className="mo-vlabel">填单人</span>
            </Cell>
            <Cell w={21}>
              <SignSlotBox
                url={order.fillerSignUrl}
                name={order.fillerName}
                editable={editable}
                onSign={props.onSign && (() => props.onSign?.('filler'))}
              />
            </Cell>
            <Cell w={7}>
              <span className="mo-vlabel">修理人</span>
            </Cell>
            <Cell w={22}>
              <SignSlotBox
                url={order.repairerSignUrl}
                name={order.repairerName}
                editable={editable}
                onSign={props.onSign && (() => props.onSign?.('repairer'))}
              />
            </Cell>
            <Cell w={7}>
              <span className="mo-vlabel">查验员</span>
            </Cell>
            <Cell w={24}>
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
            <Cell w={11}>
              <span className="mo-vpair">
                <span className="mo-vlabel">定额</span>
                <span className="mo-vlabel">工料费</span>
              </span>
            </Cell>
            <Cell w={25}>
              <span className="mo-total">
                <span className="mo-total__lb">合计</span>
                <span className="mo-total__v">{isLast ? centsToYuan(order.totalCents) : ''}</span>
              </span>
            </Cell>
            <Cell grow className="mo-col2">
              <div className="mo-sub" style={{ height: '7mm' }}>
                <Lb>凭证发放</Lb>
              </div>
              <div className="mo-sub" style={{ height: '7.9mm' }}>
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
        <div className="mo-head" style={{ height: '7mm' }}>
          <span className="mo-no">{order.paperNo || order.orderNo}</span>
        </div>
        <div className="mo-head" style={{ height: '8mm' }}>
          <span className="mo-title">报修凭证</span>
        </div>
        <div className="mo-tbl">
          <Row h={9.5}>
            <Cell w={13}>
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
          <Row h={10.5}>
            <Cell w={18}>
              <Lb>{'报修人\n姓名'}</Lb>
            </Cell>
            <Cell grow>
              <div className="mo-txt">{text(order.reporterName)}</div>
            </Cell>
          </Row>
          <Row h={10}>
            <Cell w={13}>
              <Lb>{'报修\n部位'}</Lb>
            </Cell>
            <Cell grow>
              <div className="mo-txt">{text(order.faultPart)}</div>
            </Cell>
          </Row>
          <Row h={7.5}>
            <Cell grow>
              <Lb>报 修 项 目</Lb>
            </Cell>
          </Row>
          <Row h={16.5}>
            <Cell grow className="mo-cell--left">
              <div className="mo-txt mo-txt--left">{text(order.repairItem)}</div>
            </Cell>
          </Row>
          <Row h={15.5}>
            <Cell grow />
          </Row>
          <Row h={8}>
            <Cell grow />
          </Row>
          <Row h={7.2}>
            <Cell w={18}>
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

  return (
    <div className={`mo-sheet mo-sheet--back ${overlay ? 'mo-sheet--overlay' : ''}`}>
      <div className="mo-perf" />

      <div className="mo-block mo-block--main">
        <div className="mo-head">
          <span className="mo-title mo-title--spaced">材料领耗记录</span>
          {pageCount > 1 && (
            <span className="mo-no">
              {order.paperNo || order.orderNo}
              <span className="mo-no__page">
                （第 {pageNo} 页 / 共 {pageCount} 页）
              </span>
            </span>
          )}
        </div>
        <div className="mo-unitline" />

        <div className="mo-back-grid">
          <div className="mo-back-grid__left">
            <div className="mo-tbl">
              <Row h={9.5}>
                <Cell w={19.5}>
                  <Lb>材料名称</Lb>
                </Cell>
                <Cell w={12}>
                  <Lb>规格</Lb>
                </Cell>
                <Cell w={10}>
                  <Lb>单位</Lb>
                </Cell>
                <Cell w={14}>
                  <Lb>{'估料\n数量'}</Lb>
                </Cell>
                <Cell w={14}>
                  <Lb>{'领料\n数量'}</Lb>
                </Cell>
                <Cell w={13}>
                  <Lb>{'实耗\n数量'}</Lb>
                </Cell>
                <Cell w={13}>
                  <Lb>{'退料\n数量'}</Lb>
                </Cell>
                <Cell w={13}>
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
                  <Row h={8.4} key={index}>
                    <Cell w={19.5}>
                      <Field
                        editable={editable}
                        className="mo-in--left"
                        value={row?.name || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { name: v }))}
                      />
                    </Cell>
                    <Cell w={12}>
                      <Field
                        editable={editable}
                        value={row?.spec || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { spec: v }))}
                      />
                    </Cell>
                    <Cell w={10}>
                      <Field
                        editable={editable}
                        value={row?.unit || ''}
                        onChange={patchMaterial && ((v) => patchMaterial(index, { unit: v }))}
                      />
                    </Cell>
                    {numCell('estQty', 14)}
                    {numCell('pickQty', 14)}
                    {numCell('usedQty', 13)}
                    {numCell('returnQty', 13)}
                    <Cell w={13}>
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
              <Row h={8.5}>
                <Cell w={19.5}>
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
              <Row h={8.2}>
                <Cell w={19.5}>
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
            <Cell style={{ height: '9.5mm' }}>
              <Lb>{'折旧料或\n整料记录'}</Lb>
            </Cell>
            <Cell style={{ height: '42mm', alignItems: 'flex-start' }}>
              <Field
                editable={editable}
                wrap
                className="mo-in--left"
                value={order.scrapNote || ''}
                onChange={patch && ((v) => patch({ scrapNote: v }))}
              />
            </Cell>
            <Cell style={{ height: '8.4mm' }}>
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
