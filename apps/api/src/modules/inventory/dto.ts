import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WarehouseType } from '../../common/enums';

export class TenantQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;
}

export class CreateMaterialDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  code?: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  spec?: string;

  @IsString()
  @MaxLength(60)
  category: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultCostCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  params?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateMaterialDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  spec?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  defaultCostCents?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photoUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  params?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateWarehouseDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsString()
  type: WarehouseType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  type?: WarehouseType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  communityId?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CreateSupplierDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class StockQueryDto extends TenantQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  materialId?: number;
}

export class UpdateStockDto {
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  qty?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  safetyQty?: number;
}

export class PurchaseRequestQueryDto extends TenantQueryDto {
  @IsOptional()
  @IsString()
  status?: string;
}

export class ManualPurchaseItemDto {
  @Type(() => Number)
  @IsInt()
  materialId: number;

  @Type(() => Number)
  @IsPositive()
  qty: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  estUnitCostCents?: number;
}

export class CreatePurchaseRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsArray()
  items: ManualPurchaseItemDto[];
}

export class SubmitToManagerDto {
  @IsArray()
  @IsInt({ each: true })
  requestIds: number[];
}

export class RejectPurchaseRequestDto {
  @IsString()
  @MaxLength(255)
  reason: string;
}

export class PurchaseOrderItemDto {
  @Type(() => Number)
  @IsInt()
  materialId: number;

  @Type(() => Number)
  @IsPositive()
  qty: number;

  @Type(() => Number)
  @IsInt()
  unitCostCents: number;
}

export class CreatePurchaseOrderDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  requestId?: number;

  @Type(() => Number)
  @IsInt()
  supplierId: number;

  @IsOptional()
  @IsArray()
  items?: PurchaseOrderItemDto[];
}

export class GoodsReceiptItemDto {
  @Type(() => Number)
  @IsInt()
  materialId: number;

  @Type(() => Number)
  @IsPositive()
  qty: number;

  @Type(() => Number)
  @IsInt()
  unitCostCents: number;

  // 每种材料至少一张实物照片
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoUrls?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  locationId?: number;
}

export class CreateGoodsReceiptDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  purchaseOrderId: number;

  @Type(() => Number)
  @IsInt()
  warehouseId: number;

  @IsArray()
  items: GoodsReceiptItemDto[];
}

export class CreateGeneralReceiptDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  warehouseId: number;

  @IsString()
  @MaxLength(255)
  sourceText: string;

  // 小票照片 / 发票 PDF 等凭证附件
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];

  @IsArray()
  items: GoodsReceiptItemDto[];
}

export class CreateWarehouseLocationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  warehouseId: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  zone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  shelf?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  bin?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateWarehouseLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  zone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  shelf?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  bin?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class WarehouseLocationQueryDto extends TenantQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseId?: number;
}

export class TransferItemDto {
  @Type(() => Number)
  @IsInt()
  materialId: number;

  @Type(() => Number)
  @IsPositive()
  qty: number;
}

export class CreateTransferOrderDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tenantId?: number;

  @Type(() => Number)
  @IsInt()
  fromWarehouseId: number;

  @Type(() => Number)
  @IsInt()
  toWarehouseId: number;

  @IsArray()
  items: TransferItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

export class RejectTransferOrderDto {
  @IsString()
  @MaxLength(255)
  reason: string;
}

export class ReceiveTransferItemDto {
  @Type(() => Number)
  @IsInt()
  materialId: number;

  @Type(() => Number)
  @Min(0)
  receivedQty: number;
}

export class ReceiveTransferOrderDto {
  @IsOptional()
  @IsArray()
  items?: ReceiveTransferItemDto[];
}
