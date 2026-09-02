import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  AuditStatus,
  PurchaseRequestStatus,
  UserRole,
  WorkOrderStatus,
} from '../../common/enums';
import { PurchaseRequest, UserAudit, WorkOrder } from '../../entities';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { AccessService } from '../access/access.service';

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    @InjectRepository(UserAudit)
    private readonly auditRepo: Repository<UserAudit>,
    @InjectRepository(PurchaseRequest)
    private readonly purchaseRequestRepo: Repository<PurchaseRequest>,
    private readonly accessService: AccessService,
  ) {}

  async getMetrics(user: AuthUser, access?: ResolvedAccess) {
    const tenantFilter = this.getTenantFilter(user);
    // 范围受限的角色只统计自己管的小区，避免项目管理员看到全公司数字
    const scope = scopeCommunityIds(access);
    const scoped: FindOptionsWhere<WorkOrder | UserAudit> = scope
      ? { ...tenantFilter, communityId: scope.length ? In(scope) : In([-1]) }
      : tenantFilter;

    const [
      dispatching,
      material,
      review,
      pendingAudits,
      pendingPurchase,
    ] = await Promise.all([
      this.workOrderRepo.count({ where: { ...scoped, status: WorkOrderStatus.CREATED } }),
      this.workOrderRepo.count({ where: { ...scoped, status: WorkOrderStatus.WAITING_MATERIAL } }),
      this.workOrderRepo.count({ where: { ...scoped, status: WorkOrderStatus.DONE_PENDING_REVIEW } }),
      this.auditRepo.count({ where: { ...scoped, status: AuditStatus.PENDING } }),
      this.countPendingPurchases(tenantFilter, user, access),
    ]);

    return {
      dispatching,
      material,
      review,
      pendingAudits,
      pendingPurchase,
    };
  }

  private async countPendingPurchases(
    tenantFilter: { tenantId?: number },
    user: AuthUser,
    access?: ResolvedAccess,
  ) {
    const rows = await this.purchaseRequestRepo.find({
      where: {
        ...tenantFilter,
        status: In([
          PurchaseRequestStatus.MANAGER_REVIEW,
          PurchaseRequestStatus.PURCHASER_REVIEW,
        ]),
      },
      select: ['id', 'workOrderId', 'applicantId'],
    });
    const scope = scopeCommunityIds(access);
    if (!scope) return rows.length;
    if (!scope.length || !tenantFilter.tenantId) return 0;

    const workOrderIds = rows
      .map((row) => row.workOrderId)
      .filter((id): id is number => !!id);
    const workOrders = workOrderIds.length
      ? await this.workOrderRepo.find({
          where: { tenantId: tenantFilter.tenantId, id: In(workOrderIds) },
          select: ['id', 'communityId'],
        })
      : [];
    const visibleWorkOrders = new Set(
      workOrders
        .filter((workOrder) => scope.includes(workOrder.communityId))
        .map((workOrder) => workOrder.id),
    );
    const allowedOffices = new Set<number>();
    for (const communityId of scope) {
      const officeId = await this.accessService.officeIdOfCommunity(
        tenantFilter.tenantId,
        communityId,
      );
      if (officeId) allowedOffices.add(officeId);
    }

    let count = 0;
    for (const row of rows) {
      if (row.workOrderId && visibleWorkOrders.has(row.workOrderId)) {
        count += 1;
        continue;
      }
      if (row.workOrderId) continue;
      if (row.applicantId === user.id) {
        count += 1;
        continue;
      }
      const mine = await this.accessService.userOfficeIds(
        tenantFilter.tenantId,
        row.applicantId,
      );
      if (
        !mine.all &&
        mine.officeIds.length > 0 &&
        mine.officeIds.every((id) => allowedOffices.has(id))
      ) {
        count += 1;
      }
    }
    return count;
  }

  private getTenantFilter(user: AuthUser): { tenantId?: number } {
    if (user.tenantId) return { tenantId: user.tenantId };
    if (user.role === UserRole.SUPERADMIN) return {};
    throw new ForbiddenException('tenant scope is required');
  }
}
