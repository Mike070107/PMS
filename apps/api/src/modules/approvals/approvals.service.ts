import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ApprovalLogEntry } from '../../common/approval-log';
import { BusinessTransaction, MaintenanceOrder, Material, TransferOrder, VehicleIntake } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { InventoryService } from '../inventory/inventory.service';
import { FamilyCarService } from '../access-card-issuance/family-car.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { StocktakeService } from '../stocktake/stocktake.service';
import { BusinessService } from '../business/business.service';
import { VehicleIntakeService } from '../business/vehicle-intake.service';

export const APPROVAL_CATEGORIES = {
  purchase: '采购审批', summary: '采购汇总', transfer: '库存调拨', family: '亲情车经理',
  familyOffice: '亲情车资料', vehicle: '车辆登记', business: '收费特批', stocktake: '盘点复核', maintenance: '养护签字',
};
export type ApprovalCategory = keyof typeof APPROVAL_CATEGORIES;
export interface CenterRow {
  key: string; category: ApprovalCategory; id: number; title: string; subtitle: string;
  at: string; result: string; note?: string; detail?: any;
}
export interface CenterQuery { tab?: string; category?: string; q?: string; page?: string | number; pageSize?: string | number }
const iso = (value: Date | string) => new Date(value).toISOString();

/** One authoritative permission/scope-filtered source for lists, filters and badges. */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly db: DataSource,
    private readonly inventory: InventoryService,
    private readonly family: FamilyCarService,
    private readonly maintenance: MaintenanceService,
    private readonly business: BusinessService,
    private readonly vehicles: VehicleIntakeService,
    private readonly stocktakes: StocktakeService,
  ) {}

  private can(a: ResolvedAccess, keys: string[], action: 'view' | 'edit' = 'edit') {
    return !!(a.isPlatformAdmin || a.isTenantAdmin || keys.some(key => a.pages?.[key]?.[action]));
  }

  async collect(user: AuthUser, access: ResolvedAccess) {
    if (!user.tenantId) throw new ForbiddenException('当前账号没有物业公司范围');
    const tenantId = user.tenantId;
    const pending: CenterRow[] = [], done: CenterRow[] = [];
    const enabled = new Set<ApprovalCategory>();
    const can = (keys: string[], action: 'view' | 'edit' = 'edit') => this.can(access, keys, action);
    const scope = scopeCommunityIds(access);
    const communityVisible = (id: number | null) => scope === null || scope === undefined || (!!id && scope.includes(id));
    const push = (category: ApprovalCategory, row: { id: number; createdAt: Date | string }, title: string, subtitle: string, detail?: any) => {
      pending.push({ key: `${category}:${row.id}`, category, id: row.id, title, subtitle, at: iso(row.createdAt), result: '待处理', detail });
    };
    const history = (category: ApprovalCategory, id: number, title: string, subtitle: string, entries: ApprovalLogEntry[]) => {
      entries.forEach((e, i) => {
        if (e.userId === user.id && e.at && Number.isFinite(Date.parse(e.at))) {
          done.push({ key: `${category}:${id}:${i}:${e.at}`, category, id, title, subtitle, at: iso(e.at), result: e.result, note: e.note });
        }
      });
    };
    const purchaseManager = can(['app:approve-purchase-manager', 'app:approve-manager']);
    const purchaser = can(['app:approve-purchaser']);
    const summary = can(['inventory', 'app:inventory']);
    if (purchaseManager || purchaser || summary) {
      if (purchaseManager || purchaser) enabled.add('purchase');
      if (summary) enabled.add('summary');
      const rows = await this.inventory.listPurchaseRequests({}, user, access);
      for (const r of rows) {
        const text = [r.applicantName, r.reason, ...(r.items || []).map(i => i.name)].filter(Boolean).join(' · ');
        if ((purchaseManager && r.status === 'manager_review') || (purchaser && r.status === 'purchaser_review')) push('purchase', r, r.requestNo, text, r);
        if (summary && r.status === 'office_review') push('summary', r, r.requestNo, text, r);
        const logs = r.approvalLog || [];
        const isOffice = (e: ApprovalLogEntry) => ['office', 'office_review'].includes(e.stage);
        history('purchase', r.id, r.requestNo, text, logs.filter(e => !isOffice(e)));
        history('summary', r.id, r.requestNo, text, logs.filter(isOffice));
      }
    }
    const stocktake = can(['stocktakes', 'app:stocktakes']);
    if (purchaseManager || stocktake) {
      const warehouses = await this.inventory.approvalWarehouses(user, access);
      const ids = new Set(warehouses.map(w => w.id));
      const name = (id: number) => warehouses.find(w => w.id === id)?.name || '未命名仓库';
      if (purchaseManager) {
        enabled.add('transfer');
        // Approval requires BOTH warehouses; inventory browsing alone permits EITHER.
        const rows = (await this.db.getRepository(TransferOrder).find({ where: { tenantId } })).filter(r => ids.has(r.fromWarehouseId) && ids.has(r.toWarehouseId));
        const mids = [...new Set(rows.flatMap(r => r.items.map(i => i.materialId)))];
        const materials = mids.length ? await this.db.getRepository(Material).find({ where: { tenantId, id: In(mids) } }) : [];
        for (const r of rows) {
          const subtitle = `${name(r.fromWarehouseId)} → ${name(r.toWarehouseId)}`;
          const detail = { lines: r.items.map(i => `${materials.find(m => m.id === i.materialId)?.name || '材料'} ×${i.qty}`).join('；'), note: r.note };
          if (r.status === 'pending_review') push('transfer', r, r.transferNo, subtitle, detail);
          if (r.approverId && r.approvedAt) history('transfer', r.id, r.transferNo, subtitle, [{ userId: r.approverId, at: iso(r.approvedAt), stage: 'manager', result: r.status === 'rejected' ? '已驳回' : '已通过', note: r.rejectReason || undefined }]);
        }
      }
      if (stocktake) {
        enabled.add('stocktake');
        const rows = await this.stocktakes.approvalRows(user, access);
        for (const r of rows) {
          if (r.status === 'submitted') push('stocktake', r, r.taskNo, `${r.warehouseName} · ${r.title || '库存盘点'}`, { lines: '请查看盘点差异明细后复核' });
          history('stocktake', r.id, r.taskNo, name(r.warehouseId), r.approvalLog || []);
        }
      }
    }
    const familyManager = can(['family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager']);
    const familyOffice = can(['family-cars']);
    if (familyManager || familyOffice) {
      if (familyManager) enabled.add('family');
      if (familyOffice) enabled.add('familyOffice');
      for (const r of await this.family.approvalRows(user, access)) {
        const subtitle = `${r.lane}弄${r.buildingNo}号${r.roomNo}室 · ${r.carOwnerName || r.ownerName}`;
        if (familyManager && r.status === 'manager') push('family', r, r.plate, subtitle);
        if (familyOffice && ['office', 'returned'].includes(r.status)) push('familyOffice', r, r.plate, subtitle);
        const logs = (r.log || []).filter(e => /物业经理退回办公室|物业经理审核通过|办公室审核通过|办公室处理退回后重新提交经理审核|要求业主补资料|办公室驳回并作废/.test(e.action));
        for (const e of logs) history(e.action.startsWith('物业经理') ? 'family' : 'familyOffice', r.id, r.plate, subtitle, [{ userId: e.userId || 0, at: e.at, stage: '', result: e.action, note: e.note }]);
      }
    }
    if (can(['business', 'family-cars', 'app:approve-business-manager', 'app:approve-manager'])) {
      enabled.add('vehicle');
      const rows = await this.db.getRepository(VehicleIntake).find({ where: { tenantId } });
      for (const r of rows.filter(r => communityVisible(r.communityId))) {
        if (r.status === 'submitted') push('vehicle', r, r.plate || '车辆资料审核', `${r.houseLabel} · ${r.contactName}`);
        history('vehicle', r.id, r.plate, r.houseLabel, (r.log || []).filter(e => /审核通过|退回让业主重新上传/.test(e.action)).map(e => ({ userId: e.userId || 0, at: e.at, stage: 'office', result: e.action, note: e.note })));
      }
    }
    if (can(['app:approve-business-manager', 'app:approve-manager'])) {
      enabled.add('business');
      const rows = await this.db.getRepository(BusinessTransaction).find({ where: { tenantId } });
      for (const r of rows.filter(r => communityVisible(r.communityId))) {
        const review = r.snapshot?.review as any;
        const subtitle = [(r.snapshot?.vehicle as any)?.plateNo || r.snapshot?.plate, r.startDate, r.endDate, `¥${(r.amountCents / 100).toFixed(2)}`].filter(Boolean).join(' · ');
        if (r.serviceType === 'parking_monthly' && r.externalSyncStatus === 'review' && (r.createdBy !== user.id || access.isPlatformAdmin || access.isTenantAdmin)) push('business', r, r.txnNo, subtitle, { lines: r.remark || '', snapshot: r.snapshot });
        if (review?.decidedBy && review.decidedAt) history('business', r.id, r.txnNo, subtitle, [{ userId: review.decidedBy, at: review.decidedAt, stage: 'manager', result: review.decision === 'approved' ? '已通过' : '已驳回', note: review.decisionReason }]);
      }
    }
    if (can(['app:maintenance-sign', 'app:maintenance-inspect'], 'view')) {
      enabled.add('maintenance');
      for (const r of await this.maintenance.listSignTasks(user, access)) push('maintenance', r as any, r.paperNo || r.orderNo, `${r.addressText} · 待${r.slotLabel}`, r);
      const rows = await this.db.getRepository(MaintenanceOrder).find({ where: { tenantId } });
      for (const r of rows.filter(r => communityVisible(r.communityId))) history('maintenance', r.id, r.paperNo || r.orderNo, r.repairItem || '', r.approvalLog || []);
    }
    pending.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
    done.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
    return { pending, done, enabled };
  }

  async list(query: CenterQuery, user: AuthUser, access: ResolvedAccess) {
    if (query.tab && !['pending', 'done'].includes(query.tab)) throw new BadRequestException('审批Tab无效');
    if (query.category && query.category !== 'all' && !(query.category in APPROVAL_CATEGORIES)) throw new BadRequestException('审批分类无效');
    const { pending, done, enabled } = await this.collect(user, access);
    const q = String(query.q || '').trim().toLocaleLowerCase().slice(0, 100);
    const source = query.tab === 'done' ? done : pending;
    const searched = source.filter(r => !q || `${r.title} ${r.subtitle} ${r.note || ''} ${r.result} ${r.detail?.lines || ''}`.toLocaleLowerCase().includes(q));
    const categories = Object.entries(APPROVAL_CATEGORIES).filter(([key]) => enabled.has(key as ApprovalCategory) || source.some(r => r.category === key)).map(([key, label]) => ({ key, label, count: searched.filter(r => r.category === key).length }));
    const selected = searched.filter(r => !query.category || query.category === 'all' || r.category === query.category);
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(query.pageSize) || 20)));
    const rows = selected.slice((page - 1) * pageSize, page * pageSize);
    // Sign private attachment URLs only for the current page, never expose object keys in cards.
    for (const row of rows) {
      if (query.tab !== 'done' && (row.category === 'family' || row.category === 'familyOffice')) row.detail = await this.family.get(row.id, user, access);
      if (query.tab !== 'done' && row.category === 'vehicle') row.detail = await this.vehicles.get(row.id, user, access);
    }
    return { rows, categories, tabs: { pending: pending.length, done: done.length }, allCount: searched.length, total: selected.length, page, hasMore: page * pageSize < selected.length };
  }

  async decide(category: string, id: number, approved: boolean, note: string | undefined, user: AuthUser, access: ResolvedAccess) {
    const { pending } = await this.collect(user, access);
    if (!pending.some(r => r.category === category && r.id === id)) throw new ForbiddenException('单据已处理或不在你的可审批范围');
    const text = String(note || '').trim().slice(0, 255);
    if (!approved && !text) throw new BadRequestException('退回请填写原因');
    switch (category) {
      case 'transfer': return approved ? this.inventory.approveTransferOrder(id, user, access) : this.inventory.rejectTransferOrder(id, text, user, access);
      case 'business': return this.business.decideReview(id, approved, text, user, access);
      case 'vehicle': return this.vehicles.review(id, { decision: approved ? 'approve' : 'reupload', note: text }, user, access);
      case 'familyOffice': return this.family.officeReview(id, approved ? 'approve' : 'reupload', text, user, access);
      default: throw new BadRequestException('请使用该流程原有的详情审批入口');
    }
  }
}
