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
  CommunitySpotQueryDto,
  CreateBuildingDto,
  CreateCommunityDto,
  CreateCommunitySpotDto,
  CreateHouseDto,
  HouseQueryDto,
  ParseHouseAddressDto,
  TenantScopedQueryDto,
  UpdateBuildingDto,
  UpdateCommunityDto,
  UpdateCommunitySpotDto,
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
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.getAddressBook(query.communityId, user, access);
  }

  /** 后台录房产：一整句地址拆成路名/小区/弄/号/室（与小程序语音识别共用同一套解析） */
  @Post('houses/parse-address')
  @RequirePermission('properties', 'edit')
  parseHouseAddress(
    @Body() dto: ParseHouseAddressDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.parseHouseAddress(dto, user, access);
  }

  /** 「所属管理处」下拉的选项（房产页用，不必另开管理处页权限） */
  @Get('communities/offices')
  @RequirePermission('properties', 'view')
  listOfficeOptions(
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.listOfficeOptions(user, access);
  }

  @Post('communities')
  @RequirePermission('properties', 'edit')
  createCommunity(
    @Body() dto: CreateCommunityDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.createCommunity(dto, user, access);
  }

  @Patch('communities/:id')
  @RequirePermission('properties', 'edit')
  updateCommunity(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCommunityDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.updateCommunity(id, dto, user, access);
  }

  @Delete('communities/:id')
  @RequirePermission('properties', 'delete')
  deleteCommunity(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.deleteCommunity(id, user, access);
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
  createBuilding(
    @Body() dto: CreateBuildingDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.createBuilding(dto, user, access);
  }

  @Patch('buildings/:id')
  @RequirePermission('properties', 'edit')
  updateBuilding(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBuildingDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.updateBuilding(id, dto, user, access);
  }

  @Delete('buildings/:id')
  @RequirePermission('properties', 'delete')
  deleteBuilding(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.deleteBuilding(id, user, access);
  }

  // ---------------- 公区点位 ----------------

  @Get('community-spots')
  @RequirePermission(['properties', 'work-orders', 'app:repair-create'], 'view')
  listCommunitySpots(
    @Query() query: CommunitySpotQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.listCommunitySpots(query, user, access);
  }

  @Post('community-spots')
  @RequirePermission('properties', 'edit')
  createCommunitySpot(
    @Body() dto: CreateCommunitySpotDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.createCommunitySpot(dto, user, access);
  }

  @Patch('community-spots/:id')
  @RequirePermission('properties', 'edit')
  updateCommunitySpot(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCommunitySpotDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.updateCommunitySpot(id, dto, user, access);
  }

  @Delete('community-spots/:id')
  @RequirePermission('properties', 'delete')
  deleteCommunitySpot(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.deleteCommunitySpot(id, user, access);
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

  /**
   * 房产树的户数角标：按小区/楼栋分组数房，不受列表分页影响。
   * 单独一个接口是因为角标要的是「一共多少户」，列表要的是「这一页的行」，
   * 用同一个接口凑会逼着列表把全量拉回来（房产上了 5000 套就顶到上限了）。
   */
  @Get('houses/summary')
  @RequirePermission(['properties', 'business'], 'view')
  houseSummary(
    @Query() query: HouseQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.houseSummary(query, user, access);
  }

  @Post('houses')
  @RequirePermission('properties', 'edit')
  createHouse(
    @Body() dto: CreateHouseDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.createHouse(dto, user, access);
  }

  @Patch('houses/:id')
  @RequirePermission('properties', 'edit')
  updateHouse(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateHouseDto,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.updateHouse(id, dto, user, access);
  }

  @Delete('houses/:id')
  @RequirePermission('properties', 'delete')
  deleteHouse(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @CurrentAccess() access: ResolvedAccess,
  ) {
    return this.propertiesService.deleteHouse(id, user, access);
  }
}
