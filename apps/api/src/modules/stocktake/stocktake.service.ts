import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { StockMovementType } from '../../common/enums';
import {
  Material,
  Stock,
  StocktakeItem,
  StocktakeTask,
  Warehouse,
  WarehouseLocation,
} from '../../entities';
import { AccessService, ResolvedAccess } from '../access/access.service';
import {
  applyStockDelta,
  averageUnitCost,
  consumeStockLots,
  createStockLot,
  refreshMaterialReferenceCost,
} from '../inventory/stock-ledger';
import { ObjectStorageService } from '../upload/object-storage.service';
import { CreateStocktakeDto, ReviewStocktakeDto, SaveStocktakeItemDto, StocktakeQueryDto } from './dto';
import {
  roundStocktakeQty,
  stockChangedAfterCount,
  stocktakeDifference,
  stocktakeProgress,
} from './stocktake.util';

const ACTIVE_STATUSES = ['counting', 'submitted', 'rejected'] as const;

@Injectable()
export class StocktakeService {
  constructor(
    private readonly accessService: AccessService,
    private readonly storage: ObjectStorageService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(StocktakeTask) private readonly taskRepo: Repository<StocktakeTask>,
    @InjectRepository(Warehouse) private readonly warehouseRepo: Repository<Warehouse>,
  ) {}

  async list(query: StocktakeQueryDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenantId(user);
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (visible && !visible.length) return [];
    if (query.warehouseId && visible && !visible.includes(query.warehouseId)) return [];
    const tasks = await this.taskRepo.find({
      where: {
        tenantId,
        ...(query.warehouseId ? { warehouseId: query.warehouseId } : visible ? { warehouseId: In(visible) } : {}),
        ...(query.status ? { status: query.status as any } : {}),
      },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
    return this.decorateTasks(tasks, tenantId);
  }

  async create(dto: CreateStocktakeDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenantId(user);
    await this.assertWarehouseVisible(tenantId, user, dto.warehouseId, access);
    const warehouse = await this.warehouseRepo.findOne({
      where: { tenantId, id: dto.warehouseId, enabled: true },
    });
    if (!warehouse) throw new NotFoundException('仓库不存在或已停用');
    const active = await this.taskRepo.findOne({
      where: { tenantId, warehouseId: dto.warehouseId, status: In([...ACTIVE_STATUSES]) },
    });
    if (active) throw new BadRequestException(`该仓库已有未结束的盘点任务 ${active.taskNo}`);

    const created = await this.dataSource.transaction(async (manager) => {
      const stocks = await manager.find(Stock, {
        where: { tenantId, warehouseId: dto.warehouseId },
        order: { locationId: 'ASC', materialId: 'ASC' },
      });
      if (!stocks.length) throw new BadRequestException('该仓库还没有库存记录，不能创建盘点任务');
      const locationIds = stocks.map((row) => row.locationId).filter((id): id is number => !!id);
      const locations = locationIds.length
        ? await manager.find(WarehouseLocation, { where: { tenantId, id: In(locationIds) } })
        : [];
      const locationById = new Map(locations.map((row) => [row.id, row.label]));
      const snapshotAt = new Date();
      const task = await manager.save(
        StocktakeTask,
        manager.create(StocktakeTask, {
          tenantId,
          taskNo: this.nextTaskNo(),
          title: dto.title?.trim() || `${snapshotAt.getMonth() + 1}月月度盘点`,
          warehouseId: warehouse.id,
          status: 'counting',
          totalCount: stocks.length,
          countedCount: 0,
          differenceCount: 0,
          snapshotAt,
          submittedAt: null,
          reviewedAt: null,
          reviewerId: null,
          reviewNote: null,
          createdBy: user.id,
          updatedBy: user.id,
        }),
      );
      await manager.save(
        StocktakeItem,
        stocks.map((stock) =>
          manager.create(StocktakeItem, {
            tenantId,
            taskId: task.id,
            materialId: stock.materialId,
            locationId: stock.locationId ?? null,
            locationLabel: stock.locationId ? locationById.get(stock.locationId) ?? null : null,
            bookQty: roundStocktakeQty(Number(stock.qty)),
            actualQty: null,
            differenceQty: null,
            reasonCode: null,
            note: null,
            attachments: [],
            countedBy: null,
            countedAt: null,
            createdBy: user.id,
            updatedBy: user.id,
          }),
        ),
      );
      return task;
    });
    return this.detail(created.id, user, access);
  }

  async detail(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenantId(user);
    const task = await this.taskRepo.findOne({ where: { tenantId, id } });
    if (!task) throw new NotFoundException('盘点任务不存在');
    await this.assertWarehouseVisible(tenantId, user, task.warehouseId, access);
    const [warehouse, items] = await Promise.all([
      this.warehouseRepo.findOne({ where: { tenantId, id: task.warehouseId } }),
      this.dataSource.getRepository(StocktakeItem).find({
        where: { tenantId, taskId: task.id },
        order: { locationLabel: 'ASC', id: 'ASC' },
      }),
    ]);
    const materialIds = items.map((item) => item.materialId);
    const materials = materialIds.length
      ? await this.dataSource.getRepository(Material).find({ where: { tenantId, id: In(materialIds) } })
      : [];
    const materialById = new Map(materials.map((row) => [row.id, row]));
    return {
      ...task,
      warehouseName: warehouse?.name ?? '未知仓库',
      items: items.map((item) => {
        const material = materialById.get(item.materialId);
        return {
          ...item,
          bookQty: Number(item.bookQty),
          actualQty: item.actualQty == null ? null : Number(item.actualQty),
          differenceQty: item.differenceQty == null ? null : Number(item.differenceQty),
          material: {
            id: item.materialId,
            code: material?.code ?? `#${item.materialId}`,
            name: material?.name ?? '未知材料',
            spec: material?.spec ?? null,
            category: material?.category ?? null,
            unit: material?.unit ?? '个',
            photoUrl: this.storage.toDisplayUrl(material?.photoUrl) || null,
            aliases: material?.aliases ?? [],
          },
        };
      }),
    };
  }

  async saveItem(
    taskId: number,
    itemId: number,
    dto: SaveStocktakeItemDto,
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const tenantId = this.tenantId(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const task = await this.lockTask(manager, tenantId, taskId);
      await this.assertWarehouseVisible(tenantId, user, task.warehouseId, access);
      if (!['counting', 'rejected'].includes(task.status)) {
        throw new BadRequestException('该盘点任务已提交，不能再修改');
      }
      const item = await manager.findOne(StocktakeItem, {
        where: { tenantId, taskId, id: itemId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!item) throw new NotFoundException('盘点材料不存在');
      // 以实盘保存当时的库存为账面基准，避免把实盘前的正常出入库算成差异。
      const stock = await manager.findOne(Stock, {
        where: { tenantId, warehouseId: task.warehouseId, materialId: item.materialId },
        lock: { mode: 'pessimistic_write' },
      });
      item.bookQty = roundStocktakeQty(Number(stock?.qty ?? 0));
      item.actualQty = roundStocktakeQty(Number(dto.actualQty));
      item.differenceQty = stocktakeDifference(Number(item.bookQty), item.actualQty);
      item.reasonCode = item.differenceQty === 0 ? null : dto.reasonCode?.trim() || null;
      item.note = dto.note?.trim() || null;
      item.attachments = (dto.attachments || []).filter(Boolean).slice(0, 6);
      item.countedBy = user.id;
      item.countedAt = new Date();
      item.updatedBy = user.id;
      await manager.save(item);
      if (task.status === 'rejected') task.status = 'counting';
      await this.refreshProgress(manager, task, user.id);
      return item;
    });
    return {
      ...result,
      bookQty: Number(result.bookQty),
      actualQty: Number(result.actualQty),
      differenceQty: Number(result.differenceQty),
    };
  }

  async submit(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenantId(user);
    await this.dataSource.transaction(async (manager) => {
      const task = await this.lockTask(manager, tenantId, id);
      await this.assertWarehouseVisible(tenantId, user, task.warehouseId, access);
      if (task.status !== 'counting') throw new BadRequestException('该任务当前不能提交复核');
      const items = await manager.find(StocktakeItem, { where: { tenantId, taskId: id } });
      const uncounted = items.filter((item) => item.actualQty == null);
      if (uncounted.length) throw new BadRequestException(`还有 ${uncounted.length} 项未盘点`);
      const noReason = items.filter((item) => Number(item.differenceQty) !== 0 && !item.reasonCode);
      if (noReason.length) throw new BadRequestException(`还有 ${noReason.length} 项差异未填写原因`);
      task.status = 'submitted';
      task.submittedAt = new Date();
      task.reviewNote = null;
      task.updatedBy = user.id;
      await this.refreshProgress(manager, task, user.id);
    });
    return this.detail(id, user, access);
  }

  async review(id: number, dto: ReviewStocktakeDto, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenantId(user);
    const outcome = await this.dataSource.transaction(async (manager) => {
      const task = await this.lockTask(manager, tenantId, id);
      await this.assertWarehouseVisible(tenantId, user, task.warehouseId, access);
      if (task.status !== 'submitted') throw new BadRequestException('该任务不在待复核状态');
      if (!dto.approved) {
        if (!dto.note?.trim()) throw new BadRequestException('退回时请填写原因');
        task.status = 'rejected';
        task.reviewNote = dto.note.trim();
        task.reviewerId = user.id;
        task.reviewedAt = new Date();
        task.updatedBy = user.id;
        await manager.save(task);
        return null;
      }

      const items = await manager.find(StocktakeItem, {
        where: { tenantId, taskId: task.id },
        order: { id: 'ASC' },
      });
      const current = await manager.find(Stock, {
        where: { tenantId, warehouseId: task.warehouseId, materialId: In(items.map((row) => row.materialId)) },
        order: { materialId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const currentByMaterial = new Map(current.map((row) => [row.materialId, row]));
      const drifted = items.filter(
        (item) =>
          roundStocktakeQty(Number(currentByMaterial.get(item.materialId)?.qty ?? 0)) !==
          roundStocktakeQty(Number(item.bookQty)),
      );

      const materials = await manager.find(Material, {
        where: { tenantId, id: In(items.map((row) => row.materialId)) },
      });
      const materialById = new Map(materials.map((row) => [row.id, row]));

      const recountItems: StocktakeItem[] = [];
      for (const item of drifted) {
        const stock = currentByMaterial.get(item.materialId);
        const currentQty = roundStocktakeQty(Number(stock?.qty ?? 0));
        if (stockChangedAfterCount(Number(item.bookQty), currentQty, item.countedAt, stock?.updatedAt)) {
          recountItems.push(item);
          continue;
        }

        // 兼容升级前的盘点单：出入库发生在实盘前，按最新账面数重算差异。
        const rebasedDifference = stocktakeDifference(currentQty, Number(item.actualQty));
        if (rebasedDifference !== 0 && !item.reasonCode) {
          recountItems.push(item);
          continue;
        }
        item.bookQty = currentQty;
        item.differenceQty = rebasedDifference;
        if (rebasedDifference === 0) item.reasonCode = null;
        item.updatedBy = user.id;
        await manager.save(item);
      }

      if (recountItems.length) {
        for (const item of recountItems) {
          item.bookQty = roundStocktakeQty(Number(currentByMaterial.get(item.materialId)?.qty ?? 0));
          item.actualQty = null;
          item.differenceQty = null;
          item.reasonCode = null;
          item.countedBy = null;
          item.countedAt = null;
          item.updatedBy = user.id;
        }
        await manager.save(recountItems);
        const names = recountItems.map(
          (item) => materialById.get(item.materialId)?.name ?? `#${item.materialId}`,
        );
        const shownNames = names.slice(0, 5).join('、');
        const extra = names.length > 5 ? `等 ${names.length} 项` : '';
        task.status = 'counting';
        task.reviewerId = user.id;
        task.reviewedAt = new Date();
        task.reviewNote = `实盘后又发生库存变动，已自动刷新账面数并退回重盘：${shownNames}${extra}`.slice(0, 500);
        await this.refreshProgress(manager, task, user.id);
        return { names };
      }

      for (const item of items) {
        const delta = roundStocktakeQty(Number(item.differenceQty ?? 0));
        if (!delta) continue;
        const material = materialById.get(item.materialId);
        if (!material) throw new BadRequestException(`材料 #${item.materialId} 已不存在，不能过账`);
        let unitCostCents = material.defaultCostCents || 0;
        if (delta > 0) {
          await createStockLot(manager, {
            tenantId,
            warehouseId: task.warehouseId,
            materialId: item.materialId,
            qty: delta,
            unitCostCents,
            supplierId: null,
            purchaseOrderId: null,
            goodsReceiptId: null,
            sourceType: 'stocktake',
            sourceId: task.id,
            lotNo: `PD-${task.id}-${item.materialId}`,
            operatorId: user.id,
          });
        } else {
          const allocations = await consumeStockLots(manager, {
            tenantId,
            warehouseId: task.warehouseId,
            materialId: item.materialId,
            qty: Math.abs(delta),
            operatorId: user.id,
          });
          unitCostCents = averageUnitCost(allocations, Math.abs(delta));
        }
        await applyStockDelta(manager, {
          tenantId,
          warehouseId: task.warehouseId,
          materialId: item.materialId,
          deltaQty: delta,
          type: StockMovementType.ADJUST,
          unitCostCents,
          refType: 'stocktake',
          refId: task.id,
          operatorId: user.id,
          note: `盘点 ${task.taskNo}：${reasonLabel(item.reasonCode)}${item.note ? `；${item.note}` : ''}`,
        });
        await refreshMaterialReferenceCost(manager, tenantId, item.materialId, user.id);
      }
      task.status = 'approved';
      task.reviewerId = user.id;
      task.reviewedAt = new Date();
      task.reviewNote = dto.note?.trim() || null;
      task.updatedBy = user.id;
      await manager.save(task);
      return null;
    });
    if (outcome?.names.length) {
      const shownNames = outcome.names.slice(0, 5).join('、');
      const extra = outcome.names.length > 5 ? `等 ${outcome.names.length} 项` : '';
      throw new BadRequestException(
        `检测到实盘保存后库存又发生变动，已自动刷新账面数并只退回这些材料重盘：${shownNames}${extra}。其他已盘结果和差异均已保留`,
      );
    }
    return this.detail(id, user, access);
  }

  private async refreshProgress(manager: EntityManager, task: StocktakeTask, userId: number) {
    const rows = await manager.find(StocktakeItem, { where: { tenantId: task.tenantId, taskId: task.id } });
    const progress = stocktakeProgress(rows);
    task.totalCount = progress.totalCount;
    task.countedCount = progress.countedCount;
    task.differenceCount = progress.differenceCount;
    task.updatedBy = userId;
    await manager.save(task);
  }

  private async lockTask(manager: EntityManager, tenantId: number, id: number) {
    const task = await manager.findOne(StocktakeTask, {
      where: { tenantId, id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!task) throw new NotFoundException('盘点任务不存在');
    return task;
  }

  private async decorateTasks(tasks: StocktakeTask[], tenantId: number) {
    const warehouseIds = [...new Set(tasks.map((row) => row.warehouseId))];
    const warehouses = warehouseIds.length
      ? await this.warehouseRepo.find({ where: { tenantId, id: In(warehouseIds) } })
      : [];
    const names = new Map(warehouses.map((row) => [row.id, row.name]));
    return tasks.map((task) => ({ ...task, warehouseName: names.get(task.warehouseId) ?? '未知仓库' }));
  }

  private async visibleWarehouseIds(tenantId: number, user: AuthUser, access?: ResolvedAccess) {
    const officeId = access?.actingOfficeId ?? null;
    if (!officeId && (!access || access.scopeAll)) return null;
    const warehouses = await this.warehouseRepo.find({ where: { tenantId }, select: ['id', 'officeId'] });
    const extra = new Set(await this.accessService.extraWarehouseIdsOfUser(tenantId, user.id));
    const mine = await this.accessService.userOfficeIds(tenantId, user.id);
    const all = !!access?.isPlatformAdmin || !!access?.isTenantAdmin || mine.all;
    if (officeId) {
      return warehouses
        .filter((row) => row.officeId === officeId || extra.has(row.id) || (all && !row.officeId))
        .map((row) => row.id);
    }
    if (all) return null;
    const offices = new Set(mine.officeIds);
    return warehouses
      .filter((row) => (row.officeId && offices.has(row.officeId)) || extra.has(row.id))
      .map((row) => row.id);
  }

  private async assertWarehouseVisible(
    tenantId: number,
    user: AuthUser,
    warehouseId: number,
    access?: ResolvedAccess,
  ) {
    const visible = await this.visibleWarehouseIds(tenantId, user, access);
    if (visible && !visible.includes(warehouseId)) throw new NotFoundException('仓库不存在');
  }

  private tenantId(user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号未加入物业企业');
    return user.tenantId;
  }

  private nextTaskNo() {
    const now = new Date();
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `PD${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${pad(now.getMilliseconds(), 3)}`;
  }
}

export const STOCKTAKE_REASON_LABELS: Record<string, string> = {
  unregistered_usage: '领用未登记',
  unregistered_inbound: '入库未登记',
  damaged: '破损报废',
  expired: '过期报废',
  misplaced: '库位放错',
  counting_error: '上次盘点有误',
  other: '其他',
};

function reasonLabel(code: string | null) {
  return (code && STOCKTAKE_REASON_LABELS[code]) || '盘点差异';
}
