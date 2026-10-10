import { Tenant } from './tenant.entity';
import { Community } from './community.entity';
import { Building } from './building.entity';
import { Unit } from './unit.entity';
import { CommunitySpot } from './community-spot.entity';
import { House } from './house.entity';
import { QrCode } from './qr-code.entity';
import { User } from './user.entity';
import { StaffProfile } from './staff-profile.entity';
import { UserAudit } from './user-audit.entity';
import { UserReportCommunity } from './user-report-community.entity';
import { RepairRequest } from './repair-request.entity';
import { WorkOrder } from './work-order.entity';
import { WorkOrderLog } from './work-order-log.entity';
import { WorkOrderMaterial } from './work-order-material.entity';
import { Review } from './review.entity';
import { Material } from './material.entity';
import { Warehouse } from './warehouse.entity';
import { WarehouseLocation } from './warehouse-location.entity';
import { Stock } from './stock.entity';
import { StockLot } from './stock-lot.entity';
import { StockMovement } from './stock-movement.entity';
import { TransferOrder } from './transfer-order.entity';
import { Supplier } from './supplier.entity';
import { SupplierMaterial } from './supplier-material.entity';
import { PurchaseRequest } from './purchase-request.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { GoodsReceipt } from './goods-receipt.entity';
import { WorkOrderMaterialAllocation } from './work-order-material-allocation.entity';
import { WorkOrderCompletionBatch } from './work-order-completion-batch.entity';
import { DictItem } from './dict-item.entity';
import { TenantConfig } from './tenant-config.entity';
import { Notification } from './notification.entity';
import { SubscriptionGrant } from './subscription-grant.entity';
import { BusinessRule } from './business-rule.entity';
import { ParkingVehicle } from './parking-vehicle.entity';
import { ParkingQuery } from './parking-query.entity';
import { ParkingOwnerUpdate } from './parking-owner-update.entity';
import { ParkingProofUpload } from './parking-proof-upload.entity';
import { ParkingHistory } from './parking-history.entity';
import { ParkingRecordSnapshot } from './parking-record-snapshot.entity';
import { ParkingOperation } from './parking-operation.entity';
import { AccessCard } from './access-card.entity';
import { AccessCardAgent } from './access-card-agent.entity';
import { AccessCardIssueBatch } from './access-card-issue-batch.entity';
import { AccessCardIssueItem } from './access-card-issue-item.entity';
import { AccessCardLegacySnapshot } from './access-card-legacy-snapshot.entity';
import { AccessCardLegacyCardCheck } from './access-card-legacy-card-check.entity';
import { AccessCardAuthorization } from './access-card-authorization.entity';
import { BusinessTransaction } from './business-transaction.entity';
import { BusinessLog } from './business-log.entity';
import { RepairTypeRule } from './repair-type-rule.entity';
import { RepairTypeCorrection } from './repair-type-correction.entity';
import { AiExtractSample } from './ai-extract-sample.entity';
import { AiAssistFeedback } from './ai-assist-feedback.entity';
import { AiUsageLog } from './ai-usage-log.entity';
import { AiResultCache } from './ai-result-cache.entity';
import { RepairFeeRule } from './repair-fee-rule.entity';
import { WebLoginTicket } from './web-login-ticket.entity';
import { OidcAuthorizationCode } from './oidc-authorization-code.entity';
import { ExternalAccessApp } from './external-access-app.entity';
import { ExternalAccountBinding } from './external-account-binding.entity';
import { LanGatewayAgent } from './lan-gateway-agent.entity';
import { FeeStandard } from './fee-standard.entity';
import { FeeBill } from './fee-bill.entity';
import { MaintenanceOrder } from './maintenance-order.entity';
import { MaintenanceSignSession } from './maintenance-sign-session.entity';
import { QuotaItem } from './quota-item.entity';
import { ManagementOffice } from './management-office.entity';
import { Role } from './role.entity';
import { RoleTemplate } from './role-template.entity';
import { RoleTemplatePermission } from './role-template-permission.entity';
import { RolePermission } from './role-permission.entity';
import { RoleScope } from './role-scope.entity';
import { RoleWarehouse } from './role-warehouse.entity';
import { UserRoleAssignment } from './user-role.entity';
import { PlatformLog } from './platform-log.entity';
import { StocktakeTask } from './stocktake-task.entity';
import { StocktakeItem } from './stocktake-item.entity';
import { SystemLog } from './system-log.entity';
import { RequestMetric } from './request-metric.entity';
import { UserFeedback } from './user-feedback.entity';
import { RepairExperienceNote } from './repair-experience-note.entity';
import { RepairExperienceFavorite } from './repair-experience-favorite.entity';

export const entities = [
  Tenant,
  ManagementOffice,
  Role,
  RoleTemplate,
  RoleTemplatePermission,
  RolePermission,
  RoleScope,
  RoleWarehouse,
  UserRoleAssignment,
  PlatformLog,
  StocktakeTask,
  StocktakeItem,
  SystemLog,
  RequestMetric,
  UserFeedback,
  RepairExperienceNote,
  RepairExperienceFavorite,
  Community,
  Building,
  Unit,
  CommunitySpot,
  House,
  QrCode,
  User,
  StaffProfile,
  UserAudit,
  UserReportCommunity,
  RepairRequest,
  WorkOrder,
  WorkOrderLog,
  WorkOrderMaterial,
  Review,
  Material,
  Warehouse,
  WarehouseLocation,
  Stock,
  StockLot,
  StockMovement,
  TransferOrder,
  Supplier,
  SupplierMaterial,
  PurchaseRequest,
  PurchaseOrder,
  GoodsReceipt,
  WorkOrderMaterialAllocation,
  WorkOrderCompletionBatch,
  DictItem,
  TenantConfig,
  Notification,
  SubscriptionGrant,
  BusinessRule,
  ParkingVehicle,
  ParkingQuery,
  ParkingOwnerUpdate,
  ParkingProofUpload,
  ParkingHistory,
  ParkingRecordSnapshot,
  ParkingOperation,
  AccessCard,
  AccessCardAgent,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacySnapshot,
  AccessCardLegacyCardCheck,
  AccessCardAuthorization,
  BusinessTransaction,
  BusinessLog,
  RepairTypeRule,
  RepairTypeCorrection,
  AiExtractSample,
  AiAssistFeedback,
  AiUsageLog,
  AiResultCache,
  RepairFeeRule,
  WebLoginTicket,
  OidcAuthorizationCode,
  ExternalAccessApp,
  ExternalAccountBinding,
  LanGatewayAgent,
  FeeStandard,
  FeeBill,
  MaintenanceOrder,
  MaintenanceSignSession,
  QuotaItem,
];

export {
  Tenant,
  ManagementOffice,
  Role,
  RoleTemplate,
  RoleTemplatePermission,
  RolePermission,
  RoleScope,
  RoleWarehouse,
  UserRoleAssignment,
  PlatformLog,
  StocktakeTask,
  StocktakeItem,
  SystemLog,
  RequestMetric,
  UserFeedback,
  RepairExperienceNote,
  RepairExperienceFavorite,
  Community,
  Building,
  Unit,
  CommunitySpot,
  House,
  QrCode,
  User,
  StaffProfile,
  UserAudit,
  UserReportCommunity,
  RepairRequest,
  WorkOrder,
  WorkOrderLog,
  WorkOrderMaterial,
  Review,
  Material,
  Warehouse,
  WarehouseLocation,
  Stock,
  StockLot,
  StockMovement,
  TransferOrder,
  Supplier,
  SupplierMaterial,
  PurchaseRequest,
  PurchaseOrder,
  GoodsReceipt,
  WorkOrderMaterialAllocation,
  WorkOrderCompletionBatch,
  DictItem,
  TenantConfig,
  Notification,
  SubscriptionGrant,
  BusinessRule,
  ParkingVehicle,
  ParkingQuery,
  ParkingOwnerUpdate,
  ParkingProofUpload,
  ParkingHistory,
  ParkingRecordSnapshot,
  ParkingOperation,
  AccessCard,
  AccessCardAgent,
  AccessCardIssueBatch,
  AccessCardIssueItem,
  AccessCardLegacySnapshot,
  AccessCardLegacyCardCheck,
  AccessCardAuthorization,
  BusinessTransaction,
  BusinessLog,
  RepairTypeRule,
  RepairTypeCorrection,
  AiExtractSample,
  AiAssistFeedback,
  AiUsageLog,
  AiResultCache,
  RepairFeeRule,
  WebLoginTicket,
  OidcAuthorizationCode,
  ExternalAccessApp,
  ExternalAccountBinding,
  LanGatewayAgent,
  FeeStandard,
  FeeBill,
  MaintenanceOrder,
  MaintenanceSignSession,
  QuotaItem,
};

export type { WorkOrderSnapshot } from './work-order-log.entity';
export type { CompletionBatchStatus } from './work-order-completion-batch.entity';
export type {
  WorkOrderMaterialStatus,
  WorkOrderMaterialSource,
} from './work-order-material.entity';
export type { SuggestionScope } from './management-office.entity';
export type { StocktakeStatus } from './stocktake-task.entity';
