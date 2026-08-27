import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import { RequirePermission } from '../../common/require-permission.decorator';
import { Roles } from '../../common/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolvedAccess } from '../access/access.service';
import { CurrentAccess } from '../access/current-access.decorator';
import { RolesOrPermissionGuard } from '../access/roles-or-permission.guard';
import {
  BuildingQueryDto,
  AddressBookQueryDto,
  CommunityQueryDto,
  CreateBuildingDto,
  CreateCommunityDto,
  CreateHouseDto,
  HouseQueryDto,
  TenantScopedQueryDto,
  UpdateBuildingDto,
  UpdateCommunityDto,
  UpdateHouseDto,
} from './dto';
import { PropertiesService } from './properties.service';

/**
 * 双轨鉴权：@Roles 只保留小程序端业务身份，管理后台走页面权限矩阵。
 * 小区/楼栋/房号是多个后台页面共用的基础数据，查看权取「任一相关页面」。
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesOrPermissionGuard)
export class PropertiesController {
  constructor(private readonly propertiesService: PropertiesService) {}

  // ---------------- Communities ----------------

  @Get('communities')
  // 库存页仓库档案要按名称选「所属小区」，管库存的人未必有房产页权限
  @RequirePermission(['properties', 'qr', 'users', 'work-orders', 'inventory'], 'view')
  listCommunities(
    @Query() query: CommunityQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.listCommunities(query, user, access);
  }

  /** 小区 → 楼栋 → 房号 全量地址树（报修录入的即时联想用） */
  @Get('address-tree')
  @RequirePermission(['work-orders', 'properties'], 'view')
  getAddressTree(
    @Query() query: TenantScopedQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.getAddressTree(query, user, access);
  }

  /**
   * 入驻用的小区清单：只有 id + 名称，任意登录角色可读。
   *
   * 新业主账号还没有 tenantId，没法按租户收窄，所以这里跨租户返回。
   * 只暴露小区名称（小区名本来就写在门口），不带地址、楼栋、房号和任何业主信息；
   * 选定小区后才能用 /address-book 拿到该小区的楼栋房号。
   */
  @Get('communities/public')
  // 业主入驻要选小区；员工侧凡是能报修/接单的人都要能选，
  // 所以列上报修与工单那几格，不再枚举身份
  @Roles(UserRole.OWNER)
  @RequirePermission(
    ['properties', 'work-orders', 'app:repair-create', 'app:pool', 'app:my-orders'],
    'view',
  )
  listPublicCommunities(@CurrentUser() user: AuthUser) {
    return this.propertiesService.listPublicCommunities(user);
  }

  /**
   * 小程序端地址簿：不含业主信息，允许业主/维修工调用。
   * 业主首次入驻时还没有 tenantId，用扫码解析出的 communityId 定位租户。
   */
  @Get('address-book')
  // 代报的人要在授权小区里选到具体房号，维修工要看单子的地址 —— 同样不含业主信息
  @Roles(UserRole.OWNER)
  @RequirePermission(
    ['work-orders', 'properties', 'app:repair-create', 'app:pool', 'app:my-orders'],
    'view',
  )
  getAddressBook(
    @Query() query: AddressBookQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.getAddressBook(query.communityId, user);
  }

  /** 按「N期」后缀自动归组小区（枫桦景苑一期/二期 → 枫桦景苑） */
  @Post('communities/auto-group')
  @RequirePermission('properties', 'edit')
  autoGroupCommunities(
    @Body() body: TenantScopedQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.autoGroupCommunities(user, body?.tenantId);
  }

  @Post('communities')
  @RequirePermission('properties', 'edit')
  createCommunity(
    @Body() dto: CreateCommunityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.createCommunity(dto, user);
  }

  @Patch('communities/:id')
  @RequirePermission('properties', 'edit')
  updateCommunity(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCommunityDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.updateCommunity(id, dto, user);
  }

  @Delete('communities/:id')
  @RequirePermission('properties', 'delete')
  deleteCommunity(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.deleteCommunity(id, user);
  }

  // ---------------- Buildings ----------------

  @Get('buildings')
  @RequirePermission(['properties', 'qr', 'work-orders'], 'view')
  listBuildings(
    @Query() query: BuildingQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.listBuildings(query, user, access);
  }

  @Post('buildings')
  @RequirePermission('properties', 'edit')
  createBuilding(@Body() dto: CreateBuildingDto, @CurrentUser() user: AuthUser) {
    return this.propertiesService.createBuilding(dto, user);
  }

  @Patch('buildings/:id')
  @RequirePermission('properties', 'edit')
  updateBuilding(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBuildingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.updateBuilding(id, dto, user);
  }

  @Delete('buildings/:id')
  @RequirePermission('properties', 'delete')
  deleteBuilding(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.deleteBuilding(id, user);
  }

  // ---------------- Houses ----------------

  @Get('houses')
  @RequirePermission(['properties', 'business'], 'view')
  listHouses(
    @Query() query: HouseQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.listHouses(query, user, access);
  }

  @Post('houses')
  @RequirePermission('properties', 'edit')
  createHouse(@Body() dto: CreateHouseDto, @CurrentUser() user: AuthUser) {
    return this.propertiesService.createHouse(dto, user);
  }

  @Patch('houses/:id')
  @RequirePermission('properties', 'edit')
  updateHouse(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHouseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.updateHouse(id, dto, user);
  }

  @Delete('houses/:id')
  @RequirePermission('properties', 'delete')
  deleteHouse(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.propertiesService.deleteHouse(id, user);
  }
}
