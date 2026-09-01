import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { In, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  AuditStatus,
  OWNER_APP_ROLES,
  STAFF_APP_ROLES,
  USER_ROLE_LABELS,
  UserRole,
  UserStatus,
} from '../../common/enums';
import {
  Building,
  Community,
  House,
  Role,
  Tenant,
  User,
  UserAudit,
  UserReportCommunity,
  UserRoleAssignment,
} from '../../entities';
import { AccessService } from '../access/access.service';
import { RbacSeedService } from '../access/rbac-seed.service';
import {
  AdminLoginDto,
  BootstrapAdminDto,
  OwnerMatchPhoneDto,
  OwnerOnboardDto,
  RefreshTokenDto,
  StaffLoginDto,
  WxLoginDto,
} from './dto';
import { SettingsService } from '../settings/settings.service';
import { WechatService } from './wechat.service';

/** 可登录员工端小程序的角色（定义收口到 enums，与报修放行共用一份） */
const STAFF_ROLES: UserRole[] = STAFF_APP_ROLES;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Community)
    private readonly communityRepo: Repository<Community>,
    @InjectRepository(Building)
    private readonly buildingRepo: Repository<Building>,
    @InjectRepository(House)
    private readonly houseRepo: Repository<House>,
    @InjectRepository(UserAudit)
    private readonly auditRepo: Repository<UserAudit>,
    @InjectRepository(UserReportCommunity)
    private readonly reportGrantRepo: Repository<UserReportCommunity>,
    @InjectRepository(UserRoleAssignment)
    private readonly userRoleRepo: Repository<UserRoleAssignment>,
    @InjectRepository(Role)
    private readonly roleRepo: Repository<Role>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly wechat: WechatService,
    private readonly settings: SettingsService,
    private readonly accessService: AccessService,
    private readonly rbacSeed: RbacSeedService,
  ) {}

  /** 小程序登录：code 换 openid → 找/建用户 → 发双 token */
  async wxLogin(dto: WxLoginDto) {
    const session = await this.wechat.jscode2session(dto.code, dto.appType);
    let user = await this.userRepo.findOne({ where: { wxOpenid: session.openid } });

    if (!user && session.unionid) {
      // openid 按小程序隔离，跨端只能靠 unionid 关联；且只认同端角色，
      // 避免业主端登录把员工账号的 openid 覆盖掉（反之亦然）。
      const expectRole = (r: UserRole) =>
        dto.appType === 'staff' ? STAFF_ROLES.includes(r) : OWNER_APP_ROLES.includes(r);
      const linked = await this.userRepo.findOne({
        where: { wxUnionid: session.unionid },
      });
      if (linked && expectRole(linked.role)) {
        user = linked;
        if (!user.wxOpenid) user.wxOpenid = session.openid;
      }
    }

    if (dto.appType === 'staff') {
      // 员工账号需管理员预先开通，不自助创建；首次登录走 staffLogin 绑定微信
      if (!user) {
        throw new UnauthorizedException('该微信尚未绑定员工账号，请用手机号验证登录');
      }
      return this.issueStaffTokens(user);
    }

    // 业主端只服务业主本人。保安/居委会/业委会/物业工作人员 2026-08-24 起改走
    // 员工端小程序，但他们的老账号里还留着业主端的 openid —— 这里必须挡住并指路，
    // 否则他们照样登进来，看到「我的房屋 / 入驻审核」那套跟自己无关的业主界面。
    if (user && !OWNER_APP_ROLES.includes(user.role)) {
      throw new ForbiddenException(
        STAFF_APP_ROLES.includes(user.role)
          ? '你的身份请改用「邻修管理」员工端小程序登录'
          : '该账号不能登录业主端小程序',
      );
    }

    if (!user) {
      user = this.userRepo.create({
        tenantId: null,
        wxOpenid: session.openid,
        wxUnionid: session.unionid ?? null,
        name: null,
        phone: null,
        wxNickname: null,
        passwordHash: null,
        loginAccount: null,
        role: UserRole.OWNER,
        houseId: null,
        status: UserStatus.ACTIVE,
        createdBy: null,
        updatedBy: null,
      });
    } else {
      if (!user.wxUnionid && session.unionid) user.wxUnionid = session.unionid;
      if (!user.wxOpenid) user.wxOpenid = session.openid;
    }
    user = await this.userRepo.save(user);

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('账号已停用');
    }
    return this.issueWxTokens(user);
  }

  /**
   * 员工端登录：账号由管理员预先开通，员工首次登录需验证身份并绑定微信。
   * - 已绑定过本微信：只传 code 即可静默登录
   * - 首次绑定：code + phoneCode（微信手机号）或 code + account/password
   */
  async staffLogin(dto: StaffLoginDto) {
    const session = await this.wechat.jscode2session(dto.code, 'staff');
    const bound = await this.userRepo.findOne({ where: { wxOpenid: session.openid } });

    const byPhone = !!dto.phoneCode;
    const byAccount = !!dto.account && !!dto.password;
    if (!byPhone && !byAccount) {
      if (!bound) {
        throw new UnauthorizedException('该微信尚未绑定员工账号，请用手机号验证登录');
      }
      return this.issueStaffTokens(bound);
    }

    let target: User | null;
    if (byPhone) {
      const phone = await this.wechat.getPhoneNumber(dto.phoneCode as string, 'staff');
      const matches = await this.userRepo.find({
        where: { phone, role: In(STAFF_ROLES) },
        order: { id: 'ASC' },
      });
      if (matches.length === 0) {
        throw new UnauthorizedException(
          `手机号 ${this.maskPhone(phone)} 未开通员工账号，请联系物业管理员`,
        );
      }
      const usable = matches.filter((u) => u.status === UserStatus.ACTIVE);
      if (usable.length === 0) {
        throw new ForbiddenException('该员工账号已停用，请联系物业管理员');
      }
      if (usable.length > 1) {
        // 说清楚是撞在了谁身上。只说「请改用账号密码登录」等于把人挂起：
        // 代报角色和维修工本来就没有账号密码，这条路对他们是死的
        // （2026-08 叶双同时挂着维修工和保安两条档案，就是这么被锁在外面的）。
        // 把重名的人和角色报出来，管理员照着去「用户管理」合并或改号即可。
        const who = usable
          .map((u) => `${u.name || '未填姓名'}（${USER_ROLE_LABELS[u.role] ?? u.role}）`)
          .join('、');
        this.logger.warn(
          `手机号 ${this.maskPhone(phone)} 命中多个员工账号：${usable
            .map((u) => `#${u.id}/${u.role}`)
            .join(', ')}`,
        );
        throw new ConflictException(
          `手机号 ${this.maskPhone(phone)} 同时登记在「${who}」名下，无法确定是哪一位。` +
            '请联系物业管理员在「用户管理」里核对，一个人只保留一条档案。',
        );
      }
      target = usable[0];
    } else {
      target = await this.userRepo.findOne({ where: { loginAccount: dto.account } });
      if (!target?.passwordHash) {
        throw new UnauthorizedException('账号或密码错误');
      }
      const matched = await bcrypt.compare(dto.password as string, target.passwordHash);
      if (!matched) {
        throw new UnauthorizedException('账号或密码错误');
      }
      if (!STAFF_ROLES.includes(target.role)) {
        throw new ForbiddenException('该账号不能登录员工端');
      }
      if (target.status !== UserStatus.ACTIVE) {
        throw new ForbiddenException('该员工账号已停用，请联系物业管理员');
      }
    }

    if (bound && bound.id !== target.id) {
      /**
       * 占着这个 openid 的不一定是员工账号 —— 上面那句 findOne 不限角色。
       * 两端共用一个小程序 AppID 时（2026-08-30 AppID 互换后就是这样），同一个微信
       * 在业主端和员工端拿到的是同一个 openid，占用者往往是个业主账号。
       *
       * 2026-08-30 踩过：文案写死「已绑定其他员工账号」，管理员照着去「员工管理」里
       * 挨个解绑，解了半天没用 —— 真正占着的是个 tenant_id 为空的空壳业主账号，
       * 那个列表里根本看不到它。提示必须说清是哪一种、该去哪儿找。
       */
      // 没填姓名就直说，别拿 id 冒充名字 —— 管理员在列表里也是按姓名找人
      const who = bound.name?.trim() || '未填姓名';
      throw new ConflictException(
        STAFF_ROLES.includes(bound.role)
          ? `该微信已绑定员工「${who}」，请管理员在后台「员工管理」里给该员工解绑后重试。`
          : `该微信已绑定业主账号「${who}」（业主端和员工端目前共用同一个小程序，两边的 openid 是同一个）。` +
            '请管理员在后台「用户管理」里找到这个业主账号解绑；' +
            '列表里找不到它，说明这个账号还没归属到你的物业公司名下，需要平台管理员处理。',
      );
    }
    if (target.wxOpenid && target.wxOpenid !== session.openid) {
      // openid 按小程序隔离：保安/居委会等 2026-08-24 从业主端搬来时，账号里存的
      // 还是业主端那个 openid，对不上员工端的。unionid 一致就说明还是同一个人
      // （同一微信开放平台账号下），直接改绑，别逼着每个人先去找管理员解绑。
      // unionid 对不上、或压根没配开放平台，才是真被别人的微信占了，必须人工解绑。
      const sameHuman =
        !!session.unionid && !!target.wxUnionid && session.unionid === target.wxUnionid;
      if (!sameHuman) {
        throw new ConflictException('该员工账号已绑定其他微信，请联系管理员解绑后重试');
      }
      target.wxOpenid = session.openid;
      target.updatedBy = target.id;
      target = await this.userRepo.save(target);
      this.logger.log(`员工 #${target.id}（${target.role}）的微信按 unionid 改绑到员工端`);
    } else if (!target.wxOpenid) {
      target.wxOpenid = session.openid;
      if (session.unionid) target.wxUnionid = session.unionid;
      target.updatedBy = target.id;
      target = await this.userRepo.save(target);
      this.logger.log(`员工 #${target.id}（${target.role}）已绑定员工端微信`);
    } else if (session.unionid && !target.wxUnionid) {
      target.wxUnionid = session.unionid;
      target = await this.userRepo.save(target);
    }

    return this.issueStaffTokens(target);
  }

  async refresh(dto: RefreshTokenDto) {
    let payload: { sub: number; typ?: string };
    try {
      payload = this.jwt.verify(dto.refreshToken, { secret: this.refreshSecret() });
    } catch {
      throw new UnauthorizedException('refresh token 无效或已过期');
    }
    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('不是有效的 refresh token');
    }
    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('用户不存在或已停用');
    }
    return this.issueWxTokens(user);
  }

  /** 业主入驻：认证态提交小区/房号，绑定租户并生成待审核记录 */
  async ownerOnboard(dto: OwnerOnboardDto, current: AuthUser) {
    const user = await this.userRepo.findOne({ where: { id: current.id } });
    if (!user) throw new UnauthorizedException('user not found');
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException('仅业主可入驻');
    }

    const community = await this.communityRepo.findOne({
      where: { id: dto.communityId, enabled: true },
    });
    if (!community) throw new NotFoundException('小区不存在');
    const tenantId = community.tenantId;

    // 楼栋定位：优先用业主手填/改过的弄+号，其次用扫码带出的 buildingId
    let buildingId: number | null = null;
    if (dto.buildingNo && dto.buildingNo.trim()) {
      const lane = dto.lane?.trim() || '';
      const buildingNo = dto.buildingNo.trim();

      // 业主只填「几号」：在小区里按号找，不限弄。
      // 商铺没有弄，住宅有弄，硬套小区主弄会把商铺全部匹配失败。
      const candidates = await this.buildingRepo.find({
        where: lane
          ? { tenantId, communityId: community.id, lane, buildingNo }
          : { tenantId, communityId: community.id, buildingNo },
      });
      if (!candidates.length) {
        throw new BadRequestException(
          `${community.name}没有「${lane ? lane + '弄' : ''}${buildingNo}号」，请核对后重填`,
        );
      }
      if (candidates.length > 1) {
        const options = candidates
          .map((item) => `${item.lane ? item.lane + '弄' : ''}${item.buildingNo}号`)
          .join('、');
        throw new BadRequestException(`${buildingNo}号在${community.name}有多个（${options}），请扫码确认`);
      }
      buildingId = candidates[0].id;
    } else if (dto.buildingId) {
      const building = await this.buildingRepo.findOne({
        where: { id: dto.buildingId, tenantId, communityId: community.id },
      });
      if (!building) throw new NotFoundException('楼栋不存在');
      buildingId = building.id;
    }

    // 首次入驻绑定租户
    if (!user.tenantId) {
      user.tenantId = tenantId;
    } else if (user.tenantId !== tenantId) {
      throw new ForbiddenException('该账号已归属其他物业');
    }
    // 微信手机号快速填充：phoneCode 解出的号码优先于手填
    let phone = dto.phone ?? null;
    if (dto.phoneCode) {
      try {
        phone = await this.wechat.getPhoneNumber(dto.phoneCode, 'owner');
      } catch (err) {
        // 解码失败不阻塞入驻，退回手填号码
        this.logger.warn(`业主 #${user.id} 微信手机号解码失败：${(err as Error).message}`);
        if (!phone) throw err;
      }
    }

    if (dto.realName) user.name = dto.realName;
    if (phone) user.phone = phone;
    await this.userRepo.save(user);

    // 已有待审核记录就更新它，而不是原样丢弃这次提交 ——
    // 审核期间业主发现房号填错了会再交一次，静默忽略等于让他一直等一条错的记录。
    const pending = await this.auditRepo.findOne({
      where: { tenantId, userId: user.id, status: AuditStatus.PENDING },
      order: { id: 'DESC' },
    });
    if (pending) {
      pending.communityId = community.id;
      pending.buildingId = buildingId;
      pending.rawAddress = dto.roomNo;
      pending.applicantName = dto.realName ?? user.name ?? pending.applicantName;
      pending.applicantPhone = phone ?? user.phone ?? pending.applicantPhone;
      pending.updatedBy = user.id;
      const saved = await this.auditRepo.save(pending);
      return { auditStatus: saved.status };
    }

    const audit = await this.auditRepo.save(
      this.auditRepo.create({
        tenantId,
        userId: user.id,
        communityId: community.id,
        buildingId,
        houseId: null,
        rawAddress: dto.roomNo,
        applicantName: dto.realName ?? user.name,
        applicantPhone: phone ?? user.phone,
        status: AuditStatus.PENDING,
        rejectReason: null,
        reviewedBy: null,
        reviewedAt: null,
        createdBy: user.id,
        updatedBy: user.id,
      }),
    );
    return { auditStatus: audit.status };
  }

  /**
   * 用微信手机号匹配业主名下房产。
   *
   * 只读不写：匹配到也**不建立绑定**，只把地址返回去给报修页预填 ——
   * 房产表里的电话可能是上一任业主留的，自动绑定会把房子绑错人。
   * 需要正式绑定的业主仍然走入驻 + 物业审核。
   */
  async ownerMatchPhone(dto: OwnerMatchPhoneDto, current: AuthUser) {
    const user = await this.userRepo.findOne({ where: { id: current.id } });
    if (!user) throw new UnauthorizedException("user not found");

    // 匹配范围：已有租户归属就用自己的；否则用扫码带出的小区反查
    let tenantId = user.tenantId ?? null;
    if (!tenantId && dto.communityId) {
      const community = await this.communityRepo.findOne({
        where: { id: dto.communityId, enabled: true },
      });
      tenantId = community?.tenantId ?? null;
    }
    if (!tenantId) {
      return { enabled: true, matched: false, reason: "还不知道你在哪个小区，先扫码或选小区" };
    }

    const settings = await this.settings.getSettingsByTenant(tenantId);
    if (!settings.ownerPhoneAutoMatch.enabled) {
      return { enabled: false, matched: false, reason: "物业未开启手机号快速识别" };
    }

    const phone = await this.wechat.getPhoneNumber(dto.phoneCode, "owner");

    // 房产档案里同号可能挂多套房（一人多产），拿不准就不猜，让业主自己填
    const candidates = await this.userRepo.find({
      where: { tenantId, phone, role: UserRole.OWNER, status: UserStatus.ACTIVE },
      order: { id: "ASC" },
    });
    const owned = candidates.filter((item) => item.houseId && item.id !== user.id);
    if (!owned.length) {
      return { enabled: true, matched: false, phone: this.maskPhone(phone) };
    }
    if (owned.length > 1) {
      return {
        enabled: true,
        matched: false,
        phone: this.maskPhone(phone),
        reason: "这个号码下有多套房产，请自己选一下",
      };
    }

    const place = await this.describeHouse(tenantId, owned[0].houseId as number);
    if (!place) return { enabled: true, matched: false, phone: this.maskPhone(phone) };

    // 顺手把租户和手机号落到当前微信账号上，之后他能看到自己的工单；
    // 但 houseId 不动 —— 那才是「绑定」，必须走审核。
    if (!user.tenantId) user.tenantId = tenantId;
    if (!user.phone) user.phone = phone;
    if (!user.name && owned[0].name) user.name = owned[0].name;
    await this.userRepo.save(user);

    return { enabled: true, matched: true, phone: this.maskPhone(phone), place };
  }


  /** houseId → 可直接展示的地址 */
  private async describeHouse(tenantId: number, houseId: number) {
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId } });
    if (!house) return null;
    const building = await this.buildingRepo.findOne({
      where: { id: house.buildingId, tenantId },
    });
    const community = building
      ? await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } })
      : null;
    const buildingText = building
      ? `${building.lane ? building.lane + "弄" : ""}${building.buildingNo}号`
      : "";
    return {
      communityId: community?.id ?? null,
      communityName: community?.name ?? "",
      buildingId: building?.id ?? null,
      buildingText,
      houseId: house.id,
      roomNo: house.roomNo,
      // 门牌各段连写不留空格：枫桦景苑二期 228弄26号101室
      addressText: [
        community?.name,
        `${buildingText}${house.roomNo ? house.roomNo + "室" : ""}`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  async adminLogin(dto: AdminLoginDto) {
    const user = await this.userRepo.findOne({
      where: { loginAccount: dto.account },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('invalid account or password');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('account is disabled');
    }
    await this.assertWebAdminAccess(user);

    const matched = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matched) {
      throw new UnauthorizedException('invalid account or password');
    }
    await this.assertTenantActive(user);

    return this.issueTokens(user);
  }

  /**
   * SaaS 服务闸门（登录时的友好版）：公司停用/到期在这里给出明确文案，
   * 逐请求的硬拦截在 jwt.strategy —— 两边判断口径保持一致。
   */
  /**
   * 「这个人能不能进网页后台」——账号密码登录和扫码登录共用这一份判断。
   *
   * 准入看的是「他的角色里有没有一个能看的页面」，不是「有没有绑角色」。
   *
   * 2026-08-26 业务身份并进角色表后，每个员工都会绑一个身份角色（维修工也不例外），
   * 再按「绑没绑角色」放行等于把后台向全体员工敞开 —— 维修工登进来还会撞上
   * 一个没有任何菜单的白屏。企业超管（内置角色 / 业务身份 admin）直通。
   *
   * 新增任何一种进后台的方式都必须过这里。少调一次，那条新路子就成了绕开
   * 角色矩阵的后门（扫码登录不校验密码，尤其不能漏）。
   */
  private async assertWebAdminAccess(user: User) {
    if (user.role === UserRole.SUPERADMIN) return;
    const denied = () => {
      throw new ForbiddenException(
        '这个账号还不能登录网页后台。请让管理员在「角色管理」里，' +
          '给你的角色勾上要用的页面（至少一个「查看」），再重新登录',
      );
    };
    const bindings = await this.userRoleRepo.find({
      where: { userId: user.id },
      select: ['roleId'],
    });
    if (!bindings.length) denied();
    const roles = await this.roleRepo.find({
      where: { id: In(bindings.map((b) => b.roleId)), enabled: true },
    });
    if (!roles.length) denied();
    // 只数网站页面：员工端那几格（app:*）也存在同一张权限表里，跟着数就等于
    // 「会用小程序 = 能登后台」，维修工进来还是一屏没有菜单的白板。
    // 内置角色（全权限）和「跟随权限模板」的角色都在这一个判断里 —— 绝不要在
    // 这里另查一次 role_permissions：跟随模板的角色在那张表里一行都没有。
    if (!(await this.accessService.rolesGrantAdminPages(roles))) denied();
  }

  /**
   * 扫码登录换网页 token：本人已经在员工端小程序里确认过身份了，
   * 所以跳过密码，但停用、后台角色、租户有效期三道校验一个都不能省。
   */
  async issueWebTokensForUser(userId: number) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('user not found');
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('该账号已停用，请联系管理员');
    }
    await this.assertWebAdminAccess(user);
    await this.assertTenantActive(user);
    return this.issueTokens(user);
  }

  private async assertTenantActive(user: User) {
    if (user.role === UserRole.SUPERADMIN || !user.tenantId) return;
    const tenant = await this.tenantRepo.findOne({
      where: { id: user.tenantId },
      select: ['id', 'enabled', 'expiresAt'],
    });
    if (!tenant || !tenant.enabled) {
      throw new ForbiddenException('物业公司账号已停用，请联系平台');
    }
    if (tenant.expiresAt) {
      const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      if (String(tenant.expiresAt).slice(0, 10) < today) {
        throw new ForbiddenException('物业公司服务已到期，请联系平台续期');
      }
    }
  }

  async me(current: AuthUser) {
    const user = await this.userRepo.findOne({ where: { id: current.id } });
    if (!user) throw new UnauthorizedException('user not found');
    const base: Record<string, unknown> = {
      id: user.id,
      tenantId: user.tenantId,
      role: user.role,
      name: user.name,
      phone: user.phone,
      loginAccount: user.loginAccount,
      status: user.status,
    };
    // 业主没有后台可言；其余身份把后台权限一并下发（管理后台登录后只调这一个接口）
    if (user.role !== UserRole.OWNER) {
      const authUser: AuthUser = {
        id: user.id,
        tenantId: current.tenantId ?? user.tenantId, // superadmin 公司视角下取切换后的租户
        role: user.role,
        actingOfficeId: current.actingOfficeId ?? null,
      };
      const [access, offices, roleNames] = await Promise.all([
        this.accessService.getAccess(authUser),
        this.accessService.listVisibleOffices(authUser),
        this.accessService.listRoleNames(authUser),
      ]);
      // 顶栏和「我的」页显示他绑的角色名 —— 现在没有「身份」可显示了，
      // 角色名就是这个人在系统里的称呼
      base.roleNames = roleNames;
      base.access = {
        isPlatformAdmin: access.isPlatformAdmin,
        isTenantAdmin: access.isTenantAdmin,
        pages: access.pages,
        scopeAll: access.scopeAll,
        communityIds: access.communityIds,
        enabledPages: access.enabledPages,
        offices,
        actingOfficeId: access.actingOfficeId,
      };
      // 能接单的人要开「有新工单派给你」的提醒，所以员工端也得拿到模板 id。
      // 判据是权限而不是身份 —— 只给员工端那一个模板，见 resolveSubscribeTemplates。
      if (access.pages['app:pool']?.edit || access.isTenantAdmin) {
        return {
          ...base,
          subscribeTemplates: await this.resolveSubscribeTemplates(user.tenantId, 'staff'),
        };
      }
      return base;
    }
    // 业主端首页要显示「我的房屋 + 入驻审核状态」，并据此决定能否直接报修
    const place = await this.resolveOwnerPlace(user);
    // 订阅消息模板 id 不是密钥，本来就要发到小程序里调 requestSubscribeMessage；
    // 跟着 me 一起下发，省掉一个只为读两个字符串的接口
    const subscribeTemplates = await this.resolveSubscribeTemplates(user.tenantId, 'owner');
    if (user.role === UserRole.OWNER) return { ...base, place, subscribeTemplates };

    // 保安/居委会/业委会：小程序据此多给一个「其它地址」的报修范围。
    // 授权小区一条都没有时 canReportOthers=false，端上就不显示那个入口，
    // 免得点进去选不到小区、以为系统坏了。
    const grants = await this.reportGrantRepo.find({
      where: { userId: user.id },
      order: { communityId: 'ASC' },
    });
    const communities = grants.length
      ? await this.communityRepo.find({
          where: { id: In(grants.map((g) => g.communityId)) },
          // 必须显式排序：无序时 Postgres 按堆序返回，「第一个授权小区」会随
          // 数据行的物理位置漂移，工作人员的默认物业地址跟着乱跳
          order: { id: 'ASC' },
        })
      : [];
    // 工作人员（保安/居委会/业委会/物业工作人员）不按「自己家」定位：
    // 默认地址显示第一个授权小区的物业地址（小区档案里的「地址」，
    // 在房产页给小区填如「198弄1号物业服务中心」即可），报修时照样能选任意地址。
    // officePlace 标记给端上换文案用（「我家里」→「物业地址」）。
    const officePlace = communities.length
      ? {
          auditStatus: AuditStatus.APPROVED,
          rejectReason: null,
          communityId: communities[0].id,
          communityName: communities[0].name,
          buildingId: null,
          buildingText: '',
          houseId: null,
          roomNo: '',
          addressText: [communities[0].name, communities[0].address || '物业服务中心']
            .filter(Boolean)
            .join(' '),
          officePlace: true,
        }
      : null;
    return {
      ...base,
      place: officePlace ?? place,
      // 代报角色 2026-08-24 起走**员工端**小程序，不能再下发业主端的模板 id ——
      // 那些模板不属于员工端小程序，端上一调 requestSubscribeMessage 整个弹窗就失败。
      // 员工端目前只有「有新工单派给你」，代报角色收不到那个，所以这里通常是空数组。
      subscribeTemplates: await this.resolveSubscribeTemplates(user.tenantId, 'staff'),
      reporter: {
        role: user.role,
        roleLabel: USER_ROLE_LABELS[user.role] ?? user.role,
        canReportOthers: communities.length > 0,
        communities: communities.map((c) => ({ id: c.id, name: c.name })),
      },
    };
  }

  /**
   * 该租户配好的订阅消息模板 id（去掉没填的）。
   *
   * **必须按端分**：模板 id 是跟小程序走的，业主端申请的模板在员工端根本不存在，
   * 把三个一起下发，员工端调 requestSubscribeMessage 会因为「模板不属于本小程序」
   * 整个弹窗失败 —— 表现是维修工怎么点都开不了提醒。
   *   业主端（邻修管家）：已派单 / 待验收
   *   员工端（邻修管理）：有新工单派给你
   */
  private async resolveSubscribeTemplates(
    tenantId: number | null,
    audience: 'owner' | 'staff',
  ): Promise<string[]> {
    if (!tenantId) return [];
    try {
      const settings = await this.settings.getSettingsByTenant(tenantId);
      const picked =
        audience === 'owner'
          ? [
              settings.wxSubscribeTemplates.orderDispatched,
              settings.wxSubscribeTemplates.orderReview,
            ]
          : [settings.wxSubscribeTemplates.orderAssigned];
      return picked.map((id) => String(id || '').trim()).filter(Boolean);
    } catch {
      // 设置读不到不该把「我的」页整个弄挂，退化成不弹订阅授权
      return [];
    }
  }

  /** 业主已绑定/申请中的房屋定位，供小程序首页与报修页带入 */
  private async resolveOwnerPlace(user: User) {
    const audit = await this.auditRepo.findOne({
      where: { userId: user.id },
      order: { id: 'DESC' },
    });
    if (!audit) return null;

    const [community, building, house] = await Promise.all([
      this.communityRepo.findOne({ where: { id: audit.communityId } }),
      audit.buildingId
        ? this.buildingRepo.findOne({ where: { id: audit.buildingId } })
        : Promise.resolve(null),
      user.houseId
        ? this.houseRepo.findOne({ where: { id: user.houseId } })
        : Promise.resolve(null),
    ]);

    // 「228弄26号」而不是「228 26」：空格拼出来的地址业主根本看不懂门牌在哪
    const buildingText = building
      ? `${building.lane ? building.lane + '弄' : ''}${building.buildingNo}号`
      : '';
    // 审核期间房还没绑，房号只存在申请里（rawAddress 写的就是业主填的房号）
    const roomNo = house?.roomNo ?? audit.rawAddress ?? '';
    const roomText = roomNo ? `${roomNo}室` : '';

    return {
      auditStatus: audit.status,
      rejectReason: audit.rejectReason,
      communityId: audit.communityId,
      communityName: community?.name ?? '',
      buildingId: audit.buildingId,
      buildingText,
      houseId: user.houseId,
      roomNo,
      // 门牌各段连写不留空格：枫桦景苑二期 228弄26号101室
      addressText: [community?.name, `${buildingText}${roomText}`]
        .filter(Boolean)
        .join(' '),
    };
  }

  async bootstrapAdmin(dto: BootstrapAdminDto) {
    const configuredToken = this.config.get<string>('BOOTSTRAP_TOKEN', '');
    if (!configuredToken) {
      throw new ForbiddenException('bootstrap is disabled');
    }
    if (dto.token !== configuredToken) {
      throw new ForbiddenException('invalid bootstrap token');
    }

    const existing = await this.userRepo.findOne({
      where: { loginAccount: dto.account },
    });
    if (existing) {
      throw new BadRequestException('account already exists');
    }

    const tenant = await this.tenantRepo.save(
      this.tenantRepo.create({
        name: dto.tenantName,
        contactName: dto.name ?? null,
        contactPhone: dto.phone ?? null,
        ownerAppid: null,
        staffAppid: null,
        enabled: true,
        createdBy: null,
        updatedBy: null,
      }),
    );

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.userRepo.save(
      this.userRepo.create({
        tenantId: tenant.id,
        wxOpenid: null,
        wxUnionid: null,
        name: dto.name ?? 'Tenant Admin',
        phone: dto.phone ?? null,
        wxNickname: null,
        passwordHash,
        loginAccount: dto.account,
        role: UserRole.STAFF,
        houseId: null,
        status: UserStatus.ACTIVE,
        createdBy: null,
        updatedBy: null,
      }),
    );

    // 内置角色和身份角色一起补上：种子挂在启动钩子上，这条路是运行期建的租户，
    // 不补的话这家公司要等下次重启才建得出第一个员工
    try {
      await this.rbacSeed.seedTenant(tenant.id);
    } catch {
      // 引导接口不该因为种子失败就整个失败；下次启动会补
    }

    return {
      tenant,
      user: {
        id: user.id,
        tenantId: user.tenantId,
        role: user.role,
        loginAccount: user.loginAccount,
        name: user.name,
      },
    };
  }

  /** 员工端发 token 前统一校验角色与状态 */
  private async issueStaffTokens(user: User) {
    if (!STAFF_ROLES.includes(user.role)) {
      throw new ForbiddenException('该微信绑定的不是员工账号');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('该员工账号已停用，请联系物业管理员');
    }
    if (!user.tenantId) {
      throw new ForbiddenException('该员工账号未归属物业公司，请联系管理员');
    }
    await this.assertTenantActive(user);
    return this.issueWxTokens(user);
  }

  private maskPhone(phone: string): string {
    return phone.length >= 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
  }

  private refreshSecret(): string {
    return this.config.get<string>(
      'JWT_REFRESH_SECRET',
      this.config.get<string>('JWT_SECRET', 'change-me-in-prod') + ':refresh',
    );
  }

  private issueWxTokens(user: User) {
    const payload = { sub: user.id, tenantId: user.tenantId, role: user.role };
    const accessTtlSec = Number(
      this.config.get<string>('JWT_ACCESS_TTL_SEC', '7200'),
    );
    const accessToken = this.jwt.sign(payload, { expiresIn: accessTtlSec });
    const refreshToken = this.jwt.sign(
      { ...payload, typ: 'refresh' },
      { secret: this.refreshSecret(), expiresIn: '30d' },
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: accessTtlSec,
      user: {
        id: String(user.id),
        role: user.role,
        nickname: user.name ?? user.wxNickname ?? undefined,
        phone: user.phone ?? undefined,
        tenantId: user.tenantId != null ? String(user.tenantId) : undefined,
      },
      needBinding: user.role === UserRole.OWNER && !user.houseId,
    };
  }

  private issueTokens(user: User) {
    const payload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
    };
    return {
      accessToken: this.jwt.sign(payload),
      tokenType: 'Bearer',
      user: {
        id: user.id,
        tenantId: user.tenantId,
        role: user.role,
        name: user.name,
        loginAccount: user.loginAccount,
      },
    };
  }
}
