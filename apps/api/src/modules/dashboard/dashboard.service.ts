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

@Injectable()
export class DashboardService {
  constructor(
    @InjectRepository(WorkOrder)
    private readonly workOrderRepo: Repository<WorkOrder>,
    @InjectRepository(UserAudit)
    private readonly auditRepo: Repository<UserAudit>,
    @InjectRepository(PurchaseRequest)
    private readonly purchaseRequestRepo: Repository<PurchaseRequest>,
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
      // 采购是仓库/公司维度，不挂小区，保持租户口径
      this.purchaseRequestRepo.count({
        where: {
          ...tenantFilter,
          status: In([
            PurchaseRequestStatus.MANAGER_REVIEW,
            PurchaseRequestStatus.PURCHASER_REVIEW,
          ]),
        },
      }),
    ]);

    return {
      dispatching,
      material,
      review,
      pendingAudits,
      pendingPurchase,
    };
  }

  private getTenantFilter(user: AuthUser): { tenantId?: number } {
    if (user.tenantId) return { tenantId: user.tenantId };
    if (user.role === UserRole.SUPERADMIN) return {};
    throw new ForbiddenException('tenant scope is required');
  }
}
