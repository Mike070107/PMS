import { BadRequestException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import { Brackets, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import {
  Building, BusinessLog, BusinessTransaction, Community, House, Notification, ParkingPlateTag, User, VehicleIntake,
  type VehicleIntakeFile, type VehicleIntakeKind,
} from '../../entities';
import { BusinessServiceType, NotifyChannel, NotifyStatus, UserRole } from '../../common/enums';
import { ResolvedAccess } from '../access/access.service';
import { scopeCommunityIds } from '../access/scope.util';
import { FamilyCarService } from '../access-card-issuance/family-car.service';
import { FAMILY_RELATIONS, isValidFamilyPlate, normalizeFamilyPlate } from '../access-card-issuance/family-car.util';
import { normalizeVehicleClass } from './parking-pricing';
import { detectUploadContentType } from '../upload/upload.controller';
import { ObjectStorageService } from '../upload/object-storage.service';
import { BusinessExecutionService } from './business-execution.service';

/** 扫码填写链接默认 1 小时有效 */
export const INTAKE_TTL_MS = 60 * 60 * 1000;
const PHONE = /^1\d{10}$/;

export interface CreateIntakeInput { houseId: number; kind: VehicleIntakeKind; vehicleClass?: string; garages?: string[]; garageNumbers?: Record<string, string>; formBase: string }
export interface ReviewIntakeInput {
  decision: 'approve' | 'reupload' | 'void';
  note?: string;
  plate?: string; contactName?: string; contactPhone?: string; relation?: string;
  garages?: string[]; garageNumbers?: Record<string, string>;
  /** 亲情车：旧库车牌查重任务（5 分钟内） */
  duplicateCheckQueryId?: number;
}

/**
 * 车牌办理单（扫码自填）：
 * 收银台生成二维码 → 业主手机填车牌、车主电话、上传资料（可拍下二维码回家再填，1 小时内有效）
 * → 办公室实时看到并审核 → 付费车：资料通过 + 已收费 → 进入执行；亲情车：转亲情车登记走经理审核与开通。
 * 每一步写日志（谁、何时、做了什么），供车牌管理页审计。
 */
@Injectable()
export class VehicleIntakeService {
  private readonly logger = new Logger(VehicleIntakeService.name);

  constructor(
    @InjectRepository(VehicleIntake) private readonly repo: Repository<VehicleIntake>,
    @InjectRepository(BusinessTransaction) private readonly txnRepo: Repository<BusinessTransaction>,
    @InjectRepository(BusinessLog) private readonly logRepo: Repository<BusinessLog>,
    @InjectRepository(House) private readonly houseRepo: Repository<House>,
    @InjectRepository(Building) private readonly buildingRepo: Repository<Building>,
    @InjectRepository(Community) private readonly communityRepo: Repository<Community>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly storage: ObjectStorageService,
    private readonly familyCars: FamilyCarService,
    private readonly execution: BusinessExecutionService,
    private readonly config: ConfigService,
  ) {}

  // ---------------- 办公室 ----------------

  async create(input: CreateIntakeInput, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenant(user);
    if (input.kind !== 'paid' && input.kind !== 'family') throw new BadRequestException('请选择付费车或亲情车');
    const house = await this.resolveHouse(Number(input.houseId), tenantId, access);
    const formBase = this.checkFormBase(input.formBase);
    const token = randomBytes(24).toString('base64url');
    const row = await this.repo.save(this.repo.create({
      tenantId, kind: input.kind, status: 'waiting', houseId: house.id, communityId: house.communityId,
      houseLabel: house.label, ownerName: house.ownerName, ownerPhone: house.ownerPhone,
      plate: '', contactName: '', contactPhone: '', relation: '', files: [], vehicleClass: input.kind === 'paid' ? this.cls(input.vehicleClass) : '',
      garages: this.cleanList(input.garages), garageNumbers: this.cleanNumbers(input.garageNumbers),
      tokenHash: this.hash(token), expiresAt: new Date(Date.now() + INTAKE_TTL_MS), openedAt: null, submittedAt: null,
      reviewedBy: null, reviewedAt: null, reviewNote: '', transactionId: null, familyCarId: null, log: [],
      createdBy: user.id, updatedBy: user.id,
    }));
    row.log = [await this.entry(user, input.kind === 'family' ? '生成亲情车扫码登记' : '生成新办车牌扫码登记', `二维码有效至 ${this.hm(row.expiresAt)}`)];
    await this.repo.save(row);
    return { ...(await this.view(row)), qr: await this.qr(formBase, token, row.expiresAt) };
  }

  async list(query: { status?: string; kind?: string; q?: string; houseId?: number; open?: boolean }, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenant(user);
    const scope = scopeCommunityIds(access);
    if (scope && !scope.length) return [];
    const qb = this.repo.createQueryBuilder('i').where('i.tenant_id = :tenantId', { tenantId });
    if (scope) qb.andWhere('i.community_id IN (:...scope)', { scope });
    if (query.houseId) qb.andWhere('i.house_id = :houseId', { houseId: Number(query.houseId) });
    if (query.kind) qb.andWhere('i.kind = :kind', { kind: query.kind });
    if (query.status) qb.andWhere('i.status IN (:...st)', { st: String(query.status).split(',') });
    if (query.open) qb.andWhere("(i.status IN ('waiting','submitted','reupload') OR (i.status = 'approved' AND i.kind = 'paid' AND i.transaction_id IS NULL))");
    const q = (query.q || '').trim();
    if (q) {
      qb.andWhere(new Brackets((b) => {
        b.where('i.plate ILIKE :kw', { kw: `%${q.replace(/[\s·.]/g, '').toUpperCase()}%` })
          .orWhere('i.house_label ILIKE :kw2', { kw2: `%${q}%` })
          .orWhere('i.owner_name ILIKE :kw2').orWhere('i.contact_name ILIKE :kw2')
          .orWhere('i.contact_phone ILIKE :kw2').orWhere('i.owner_phone ILIKE :kw2');
      }));
    }
    const rows = await qb.orderBy('i.id', 'DESC').take(200).getMany();
    return Promise.all(rows.map((row) => this.view(row)));
  }

  async get(id: number, user: AuthUser, access?: ResolvedAccess) {
    return this.view(await this.load(id, user, access), true);
  }

  /** 付费车改「按哪类收费」（收款前） */
  async setClass(id: number, vehicleClass: string, user: AuthUser, access?: ResolvedAccess) {
    const row = await this.load(id, user, access);
    if (row.kind !== 'paid' || row.transactionId || row.status === 'void') throw new BadRequestException('已收款或已作废，不能再改车辆类别');
    const cls = this.cls(vehicleClass);
    if (cls === row.vehicleClass) return this.view(row);
    row.log = [...row.log, await this.entry(user, `车辆类别改为「${cls || '不分类'}」`, row.vehicleClass ? `原为「${row.vehicleClass}」` : undefined)];
    row.vehicleClass = cls;
    row.updatedBy = user.id;
    await this.repo.save(row);
    return this.view(row);
  }

  /** 重新生成二维码：旧码立即失效，新码 1 小时有效 */
  async regenerate(id: number, formBase: string, user: AuthUser, access?: ResolvedAccess) {
    const row = await this.load(id, user, access);
    if (!['waiting', 'reupload', 'submitted'].includes(row.status)) throw new BadRequestException('这条登记已审核完成，不能再生成二维码');
    const base = this.checkFormBase(formBase);
    const token = randomBytes(24).toString('base64url');
    row.tokenHash = this.hash(token);
    row.expiresAt = new Date(Date.now() + INTAKE_TTL_MS);
    row.openedAt = null;
    if (row.status === 'submitted') row.status = 'reupload';
    row.updatedBy = user.id;
    row.log = [...row.log, await this.entry(user, '重新生成二维码（旧码作废）', `有效至 ${this.hm(row.expiresAt)}`)];
    await this.repo.save(row);
    return { ...(await this.view(row)), qr: await this.qr(base, token, row.expiresAt) };
  }

  async review(id: number, input: ReviewIntakeInput, user: AuthUser, access?: ResolvedAccess) {
    const row = await this.load(id, user, access);
    const note = (input.note || '').trim().slice(0, 500);
    if (input.decision === 'void') {
      if (row.status === 'void') return this.view(row);
      if (row.status === 'approved' && (row.kind === 'family' || row.transactionId)) throw new BadRequestException('已审核通过并进入办理的登记不能在这里作废，请到车牌管理处理');
      if (!note) throw new BadRequestException('作废请写原因');
      row.status = 'void';
      row.log = [...row.log, await this.entry(user, '作废', note)];
      row.updatedBy = user.id;
      await this.repo.save(row);
      await this.onVoid(row, note, user);
      return this.view(row);
    }
    if (input.decision === 'reupload') {
      if (!['submitted', 'reupload'].includes(row.status)) throw new BadRequestException('业主还没有提交，不需要退回');
      if (!note) throw new BadRequestException('请写明要业主补什么');
      row.status = 'reupload';
      row.reviewNote = note;
      // 原二维码没过期就继续能用；过期了请前台重新生成
      row.log = [...row.log, await this.entry(user, '退回让业主重新上传', note)];
      row.updatedBy = user.id;
      await this.repo.save(row);
      return this.view(row);
    }
    // 通过
    if (row.status !== 'submitted' && row.status !== 'reupload') throw new BadRequestException(row.status === 'approved' ? '已经审核通过了' : '业主还没有提交资料');
    if (!row.files.length) throw new BadRequestException('还没有资料，不能通过');
    // 办公室可以更正业主填错的车牌、电话
    if (input.plate !== undefined) row.plate = normalizeFamilyPlate(input.plate);
    if (input.contactName !== undefined) row.contactName = input.contactName.trim().slice(0, 50);
    if (input.contactPhone !== undefined) row.contactPhone = input.contactPhone.trim().slice(0, 30);
    if (input.relation !== undefined) row.relation = input.relation.trim();
    if (input.garages) row.garages = this.cleanList(input.garages);
    if (input.garageNumbers) row.garageNumbers = this.cleanNumbers(input.garageNumbers);
    if (!isValidFamilyPlate(row.plate)) throw new BadRequestException('车牌格式不正确，例如 豫GQ3N07');
    if (!row.contactName || !PHONE.test(row.contactPhone)) throw new BadRequestException('请补全车主姓名和 11 位手机号');

    if (row.kind === 'family') {
      if (!(FAMILY_RELATIONS as readonly string[]).includes(row.relation)) throw new BadRequestException('请选择车主与业主的关系');
      if (!input.duplicateCheckQueryId) throw new BadRequestException('亲情车通过前要先在旧停车库查重');
      const car = await this.familyCars.createFromIntake({
        houseId: row.houseId, plate: row.plate, duplicateCheckQueryId: Number(input.duplicateCheckQueryId),
        carOwnerName: row.contactName, carOwnerPhone: row.contactPhone, relation: row.relation,
        garages: row.garages, garageNumbers: row.garageNumbers, remark: `收银台扫码登记 #${row.id}`,
      }, row.files.map((f) => ({ ...f, source: 'owner' as const })), note || '收银台已审核业主扫码资料', user, access);
      row.familyCarId = (car as { id: number }).id;
    }
    row.status = 'approved';
    row.reviewedBy = user.id;
    row.reviewedAt = new Date();
    row.reviewNote = note;
    row.expiresAt = new Date(Math.min(row.expiresAt.getTime(), Date.now()));
    row.log = [...row.log, await this.entry(user, row.kind === 'family' ? '资料审核通过，转亲情车登记（待物业经理审核）' : '资料审核通过', note || undefined)];
    row.updatedBy = user.id;
    await this.repo.save(row);
    if (row.kind === 'paid') {
      await this.tagPlate(row, user).catch((e) => this.logger.warn(`车牌分类保存失败：${e?.message || e}`));
      await this.releasePayment(row, user);
    }
    return this.view(row);
  }

  // ---------------- 与收款流水衔接（付费车） ----------------

  /** 收银台收款时校验并占用办理单；返回流水应处的状态与车牌 */
  async claimForPayment(intakeId: number, houseId: number | null | undefined, user: AuthUser) {
    const tenantId = this.tenant(user);
    const row = await this.repo.findOne({ where: { id: intakeId, tenantId } });
    if (!row || row.kind !== 'paid') throw new BadRequestException('新办车牌登记不存在');
    if (houseId && row.houseId !== houseId) throw new BadRequestException('新办车牌登记不属于这一户');
    if (row.status === 'void') throw new BadRequestException('这条新办车牌登记已作废');
    if (row.transactionId) throw new BadRequestException('这辆新车已经收过款了，请到「待处理」查看');
    return { row, approved: row.status === 'approved', plate: row.plate };
  }

  async attachPayment(row: VehicleIntake, txn: BusinessTransaction, user: AuthUser) {
    row.transactionId = txn.id;
    row.log = [...row.log, await this.entry(user, `已收款 ¥${(txn.amountCents / 100).toFixed(2)}`,
      txn.externalSyncStatus === 'awaiting_docs' ? '资料未齐，收款挂「待处理」，业主提交并审核通过后自动办理' : `流水 ${txn.txnNo}`)];
    await this.repo.save(row);
  }

  /** 物业经理通过非标准金额后：资料还没过的继续等资料 */
  async isApproved(intakeId: number, tenantId: number) {
    const row = await this.repo.findOne({ where: { id: intakeId, tenantId } });
    return row?.status === 'approved';
  }

  /** 资料通过 → 已收款且在等资料的流水进入执行 */
  private async releasePayment(row: VehicleIntake, user: AuthUser) {
    if (!row.transactionId) return;
    const txn = await this.txnRepo.findOne({ where: { id: row.transactionId, tenantId: row.tenantId } });
    if (!txn || txn.externalSyncStatus !== 'awaiting_docs') return;
    const exec = this.execution.initialFor(BusinessServiceType.PARKING_MONTHLY);
    const snapshot = {
      ...(txn.snapshot || {}),
      vehicle: { ...((txn.snapshot?.vehicle as object) || {}), plateNo: row.plate },
      parking: { ...((txn.snapshot?.parking as object) || {}), plate: row.plate },
      ...(exec.execution ? { execution: exec.execution } : {}),
    };
    const done = await this.txnRepo.createQueryBuilder().update(BusinessTransaction)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ externalSyncStatus: exec.status, snapshot: snapshot as any, updatedBy: user.id })
      .where('id = :id AND external_sync_status = :st', { id: txn.id, st: 'awaiting_docs' }).execute();
    if (!done.affected) return;
    await this.logRepo.save(this.logRepo.create({ tenantId: row.tenantId, transactionId: txn.id, action: 'docs_approved', detail: { intakeId: row.id, plate: row.plate }, createdBy: user.id, updatedBy: user.id }));
    if (exec.status === 'queued') this.execution.kick(txn.id);
  }

  /** 作废时已收的款转人工（退款或重办），不静默丢掉 */
  private async onVoid(row: VehicleIntake, note: string, user: AuthUser) {
    if (!row.transactionId) return;
    const txn = await this.txnRepo.findOne({ where: { id: row.transactionId, tenantId: row.tenantId } });
    if (!txn || !['awaiting_docs', 'review'].includes(txn.externalSyncStatus)) return;
    const execution = { ...((txn.snapshot?.execution as object) || {}), lastError: `新办车牌登记已作废：${note}；已收款请按原因退款或重办` };
    await this.txnRepo.update({ id: txn.id }, { externalSyncStatus: 'manual', snapshot: { ...(txn.snapshot || {}), execution } as never, updatedBy: user.id });
    await this.logRepo.save(this.logRepo.create({ tenantId: row.tenantId, transactionId: txn.id, action: 'docs_voided', detail: { intakeId: row.id, note }, createdBy: user.id, updatedBy: user.id }));
  }

  // ---------------- 业主手机（无登录，凭链接里的随机码） ----------------

  async publicSession(token: string) {
    const row = await this.byToken(token);
    if (!row.openedAt) {
      row.openedAt = new Date();
      row.log = [...row.log, { at: new Date().toISOString(), userId: null, userName: '业主手机', action: '扫码打开填写页' }];
      await this.repo.save(row);
    }
    return this.publicView(row);
  }

  async publicSubmit(token: string, input: Express.Multer.File[] | undefined, body: Record<string, unknown> | undefined) {
    const row = await this.byToken(token);
    if (!['waiting', 'reupload'].includes(row.status)) throw new BadRequestException(row.status === 'submitted' ? '资料已经提交，请等待物业办公室审核' : '这条登记已经办理，无需再提交');
    const read = (key: string, max: number) => String(body?.[key] ?? '').trim().slice(0, max);
    const plate = normalizeFamilyPlate(read('plate', 12));
    const contactName = read('contactName', 50);
    const contactPhone = read('contactPhone', 30).replace(/\D/g, '');
    const relation = read('relation', 20);
    if (!isValidFamilyPlate(plate)) throw new BadRequestException('车牌格式不正确，例如 豫GQ3N07');
    if (!contactName) throw new BadRequestException('请填写车主姓名');
    if (!PHONE.test(contactPhone)) throw new BadRequestException('请填写 11 位手机号，方便物业联系');
    if (row.kind === 'family' && !(FAMILY_RELATIONS as readonly string[]).includes(relation)) throw new BadRequestException('请选择车主与业主的关系');
    const files = input ?? [];
    const keep = row.status === 'reupload' && body?.keepFiles === '1' ? row.files : [];
    if (!files.length && !keep.length) throw new BadRequestException('请上传资料照片（行驶证、驾驶证等）');
    if (files.length + keep.length > 10) throw new BadRequestException('资料最多 10 份');
    const types = files.map((file) => detectUploadContentType(file.buffer));
    if (types.some((t) => !t || (!t.startsWith('image/') && t !== 'application/pdf'))) throw new BadRequestException('只支持照片（JPG、PNG、HEIC 等）或 PDF');
    const stored: VehicleIntakeFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const put = await this.storage.putBuffer(files[i].buffer, types[i]!, 'vehicle-intakes', files[i].originalname);
      stored.push({ objectKey: put.objectKey, fileName: files[i].originalname.slice(0, 255), contentType: types[i]!, uploadedAt: new Date().toISOString() });
    }
    // 并发提交只认第一次
    const done = await this.repo.createQueryBuilder().update(VehicleIntake)
      .set({
        plate, contactName, contactPhone, relation: row.kind === 'family' ? relation : '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        files: [...keep, ...stored] as any, status: 'submitted', submittedAt: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        log: [...row.log, { at: new Date().toISOString(), userId: null, userName: '业主手机', action: row.status === 'reupload' ? '业主重新提交资料' : '业主提交车牌和资料', note: `${plate} · ${contactName} ${contactPhone} · ${stored.length + keep.length} 份资料` }] as any,
      })
      .where('id = :id AND status IN (:...st)', { id: row.id, st: ['waiting', 'reupload'] }).execute();
    if (!done.affected) throw new BadRequestException('资料已经提交，请等待物业办公室审核');
    await this.notify(row, `${row.houseLabel} 业主已提交${row.kind === 'family' ? '亲情车' : '新办车牌'} ${plate}，请审核资料`);
    return this.publicView((await this.repo.findOne({ where: { id: row.id } }))!);
  }

  // ---------------- 内部 ----------------

  /** 新办付费车审核通过：车牌记下分类，下次续期自动按这一类收费 */
  private async tagPlate(row: VehicleIntake, user: AuthUser) {
    if (!row.vehicleClass || !row.plate) return;
    const tags = this.repo.manager.getRepository(ParkingPlateTag);
    const old = await tags.findOne({ where: { tenantId: row.tenantId, plate: row.plate } });
    if (old) { old.vehicleClass = row.vehicleClass; old.houseId = row.houseId; old.updatedBy = user.id; await tags.save(old); return; }
    await tags.save(tags.create({ tenantId: row.tenantId, plate: row.plate, vehicleClass: row.vehicleClass, houseId: row.houseId, createdBy: user.id, updatedBy: user.id }));
  }

  private cls(value: unknown) {
    try { return normalizeVehicleClass(value); } catch (e) { throw new BadRequestException((e as Error).message); }
  }

  private async notify(row: VehicleIntake, title: string) {
    const ids = [...new Set([row.createdBy, row.updatedBy].filter((x): x is number => !!x))];
    if (!ids.length) return;
    await this.repo.manager.save(Notification, ids.map((receiverId) => this.repo.manager.create(Notification, {
      tenantId: row.tenantId, receiverId, channel: NotifyChannel.IN_APP, eventKey: 'vehicle_intake.submitted', title,
      payload: { intakeId: row.id, page: '/plates' }, status: NotifyStatus.SENT, readAt: null, createdBy: receiverId, updatedBy: receiverId,
    }))).catch((e) => this.logger.warn(`通知失败：${e?.message || e}`));
  }

  private async view(row: VehicleIntake, withLog = false) {
    const txn = row.transactionId ? await this.txnRepo.findOne({ where: { id: row.transactionId, tenantId: row.tenantId } }) : null;
    const now = Date.now();
    return {
      id: row.id, kind: row.kind, status: row.status, houseId: row.houseId, houseLabel: row.houseLabel,
      ownerName: row.ownerName, ownerPhone: row.ownerPhone,
      plate: row.plate, contactName: row.contactName, contactPhone: row.contactPhone, relation: row.relation, vehicleClass: row.vehicleClass,
      garages: row.garages, garageNumbers: row.garageNumbers,
      expiresAt: row.expiresAt.toISOString(), qrValid: ['waiting', 'reupload'].includes(row.status) && row.expiresAt.getTime() > now,
      openedAt: row.openedAt?.toISOString() ?? null, submittedAt: row.submittedAt?.toISOString() ?? null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null, reviewNote: row.reviewNote,
      files: row.files.map((f, index) => ({ index, fileName: f.fileName, contentType: f.contentType, uploadedAt: f.uploadedAt, fileUrl: `/api/v1/upload/file?key=${encodeURIComponent(f.objectKey)}` })),
      transaction: txn ? { id: txn.id, txnNo: txn.txnNo, amountCents: txn.amountCents, startDate: txn.startDate, endDate: txn.endDate, externalSyncStatus: txn.externalSyncStatus, execution: txn.snapshot?.execution ?? null } : null,
      familyCarId: row.familyCarId,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      ...(withLog ? { log: row.log } : {}),
    };
  }

  private publicView(row: VehicleIntake) {
    return {
      kind: row.kind, status: row.status, houseLabel: row.houseLabel,
      ownerName: row.ownerName ? `${row.ownerName.slice(0, 1)}**` : '',
      expiresAt: row.expiresAt.toISOString(), reviewNote: row.status === 'reupload' ? row.reviewNote : '',
      plate: row.plate, contactName: row.contactName, contactPhone: row.contactPhone ? row.contactPhone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : '', relation: row.relation,
      fileCount: row.files.length, relations: [...FAMILY_RELATIONS],
    };
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token || '')) throw new BadRequestException('链接无效');
    const row = await this.repo.findOne({ where: { tokenHash: this.hash(token) } });
    if (!row) throw new NotFoundException('链接无效，请联系物业办公室重新生成二维码');
    const editable = ['waiting', 'reupload'].includes(row.status);
    if (editable && row.expiresAt.getTime() <= Date.now()) throw new GoneException('二维码已过期（1 小时内有效），请联系物业办公室重新生成');
    return row;
  }

  private async load(id: number, user: AuthUser, access?: ResolvedAccess) {
    const tenantId = this.tenant(user);
    const row = await this.repo.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('登记不存在');
    const scope = scopeCommunityIds(access);
    if (scope && (row.communityId == null || !scope.includes(row.communityId))) throw new ForbiddenException('不在你的管理范围内');
    return row;
  }

  private async resolveHouse(houseId: number, tenantId: number, access?: ResolvedAccess) {
    if (!Number.isSafeInteger(houseId) || houseId <= 0) throw new BadRequestException('请先选房号');
    const house = await this.houseRepo.findOne({ where: { id: houseId, tenantId } });
    if (!house) throw new NotFoundException('房号不存在');
    const building = await this.buildingRepo.findOne({ where: { id: house.buildingId, tenantId } });
    const community = building ? await this.communityRepo.findOne({ where: { id: building.communityId, tenantId } }) : null;
    const scope = scopeCommunityIds(access);
    if (scope && (!community || !scope.includes(community.id))) throw new ForbiddenException('该房号不在你的管理范围内');
    const owner = await this.userRepo.findOne({ where: { tenantId, houseId: house.id, role: UserRole.OWNER }, order: { id: 'ASC' } });
    const strip = (v?: string | null) => (v || '').trim().replace(/^0+(?=\d)/, '');
    const label = `${community?.name ?? ''}/${[strip(building?.lane) && `${strip(building?.lane)}弄`, strip(building?.buildingNo) && `${strip(building?.buildingNo)}号`, strip(house.roomNo)].filter(Boolean).join('')}`;
    return { id: house.id, communityId: community?.id ?? null, label: label.slice(0, 120), ownerName: owner?.name ?? '', ownerPhone: owner?.phone ?? '' };
  }

  private checkFormBase(value: string) {
    const base = String(this.config.get('APP_PUBLIC_BASE_URL') || '').replace(/\/+$/, '');
    let url: URL;
    try { url = new URL(String(value || '')); } catch { throw new BadRequestException('填写页地址无效'); }
    if (url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) throw new BadRequestException('填写页必须是 https 地址');
    if (base && new URL(base).host !== url.host) throw new BadRequestException('填写页地址不属于本系统');
    return url.toString().replace(/\/+$/, '');
  }

  private async qr(base: string, token: string, expiresAt: Date) {
    const url = `${base}/${token}`;
    return { url, expiresAt: expiresAt.toISOString(), dataUrl: await QRCode.toDataURL(url, { width: 520, margin: 1, errorCorrectionLevel: 'M' }) };
  }

  private async entry(user: AuthUser, action: string, note?: string) {
    const actor = user.id ? await this.userRepo.findOne({ where: { id: user.id }, select: ['id', 'name', 'loginAccount'] as (keyof User)[] }) : null;
    return { at: new Date().toISOString(), userId: user.id || null, userName: actor?.name || (actor as { loginAccount?: string } | null)?.loginAccount || '系统', action, ...(note ? { note } : {}) };
  }

  private cleanList(value: unknown) {
    return Array.isArray(value) ? [...new Set(value.map((x) => String(x).trim()).filter(Boolean))].slice(0, 10) : [];
  }

  private cleanNumbers(value: unknown) {
    const out: Record<string, string> = {};
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) { const t = String(v ?? '').trim().slice(0, 20); if (t) out[k.slice(0, 20)] = t; }
    return out;
  }

  private hm(d: Date) {
    return d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }

  private tenant(user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('当前账号没有物业公司范围');
    return user.tenantId;
  }

}
