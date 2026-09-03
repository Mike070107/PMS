import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { IsString, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { RequirePermission } from '../../common/require-permission.decorator';
import { Material } from '../../entities';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../access/permissions.guard';
import { MaterialReceiptAiService, matchReceiptMaterials } from './material-receipt.ai';

class ParseMaterialReceiptDto {
  @IsString()
  @MaxLength(1000)
  text: string;
}

/**
 * 材料入库语音填表。
 *
 * 单独一个控制器：入库是**库存权限**（inventory·edit），和维修工用的 AI 小工具
 * （ai-tools.controller，工单权限）不是同一批人；混在一个 controller 里就得给
 * 仓管开工单权限、或者给维修工开库存权限，两种都不对。
 *
 * 这个接口**只读 + 只算**：把口述理成明细并标出每行落在哪条 SKU 上，
 * 一个字都不写库。真正入库仍走 POST /goods-receipts/general，由人核对后提交。
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MaterialReceiptController {
  constructor(
    private readonly receiptAi: MaterialReceiptAiService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Post('material-receipt-parse')
  @RequirePermission('inventory', 'edit')
  async parse(@Body() dto: ParseMaterialReceiptDto, @CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId as number;
    const mentions = await this.receiptAi.parse(tenantId, dto.text);
    // null = 没配大模型 / 调不通。端上照原样手工填，别让入库卡在 AI 上。
    if (!mentions) {
      return { ok: false as const, reason: 'ai_unavailable' as const, items: [] };
    }
    const catalog = await this.dataSource.getRepository(Material).find({
      where: { tenantId, enabled: true },
      select: ['id', 'code', 'name', 'spec', 'unit', 'category'],
      order: { id: 'ASC' },
    });
    return { ok: true as const, items: matchReceiptMaterials(mentions, catalog) };
  }
}
