import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, ILike, In, IsNull, Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { UserRole } from '../../common/enums';
import { User } from '../../entities';
import { AccessService } from '../access/access.service';
import { FinanceEntry, FinanceInvoice, FinanceProject, FinanceReimbursement } from './finance.entities';

const NAME_ALLOWLIST = new Set(['叶双']);

@Injectable()
export class FinanceService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(FinanceProject, 'finance') private readonly projectRepo: Repository<FinanceProject>,
    @InjectRepository(FinanceEntry, 'finance') private readonly entryRepo: Repository<FinanceEntry>,
    @InjectRepository(FinanceInvoice, 'finance') private readonly invoiceRepo: Repository<FinanceInvoice>,
    @InjectRepository(FinanceReimbursement, 'finance') private readonly reimbursementRepo: Repository<FinanceReimbursement>,
    private readonly accessService: AccessService,
  ) {}

  async access(user: AuthUser) {
    const allowed = await this.isAllowed(user);
    return { allowed, canConfigureMailbox: allowed, reason: allowed ? null : '仅管理员或指定财务人员可使用' };
  }

  async assertAllowed(user: AuthUser): Promise<number> {
    if (!(await this.isAllowed(user))) throw new ForbiddenException('仅管理员或指定财务人员可使用财务记账');
    if (!user.tenantId) throw new BadRequestException('请先选择要管理的公司');
    return user.tenantId;
  }

  private async isAllowed(user: AuthUser): Promise<boolean> {
    if (user.role === UserRole.SUPERADMIN) return Boolean(user.tenantId);
    const access = await this.accessService.getAccess(user);
    if (access.isTenantAdmin) return true;
    const profile = await this.userRepo.findOne({ where: { id: user.id, tenantId: user.tenantId ?? -1 } });
    if (!profile?.name || !NAME_ALLOWLIST.has(profile.name.trim())) return false;
    // 姓名只在当前租户内唯一时才作为白名单依据，防止同名员工误获财务权限。
    return (await this.userRepo.count({ where: { tenantId: user.tenantId ?? -1, name: profile.name.trim() } })) === 1;
  }

  async dashboard(user: AuthUser) {
    const tenantId = await this.assertAllowed(user);
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);
    const entries = await this.entryRepo.find({ where: { tenantId, businessDate: Between(start, end) } });
    const income = entries.filter((e) => e.flowType === 'income').reduce((s, e) => s + Number(e.amount), 0);
    const expense = entries.filter((e) => e.flowType === 'expense').reduce((s, e) => s + Number(e.amount), 0);
    return {
      month: { income: income.toFixed(2), expense: expense.toFixed(2), balance: (income - expense).toFixed(2) },
      pendingReimbursement: entries.filter((e) => e.reimbursementStatus === 'pending').length,
      invoiceInbox: await this.invoiceRepo.count({ where: { tenantId, status: 'inbox' } }),
      projects: await this.projectRepo.count({ where: { tenantId, status: 'active' } }),
    };
  }

  async listProjects(user: AuthUser) {
    const tenantId = await this.assertAllowed(user);
    return this.projectRepo.find({ where: { tenantId }, order: { parentId: 'ASC', createdAt: 'DESC' } });
  }

  async createProject(user: AuthUser, dto: any) {
    const tenantId = await this.assertAllowed(user);
    const name = String(dto.name ?? '').trim();
    if (!name) throw new BadRequestException('请填写项目名称');
    const parentId = dto.parentId ? Number(dto.parentId) : null;
    if (parentId) {
      const parent = await this.projectRepo.findOne({ where: { id: parentId, tenantId, parentId: IsNull() } });
      if (!parent) throw new BadRequestException('所选父项目不存在或不是一级项目');
    }
    return this.projectRepo.save(this.projectRepo.create({
      tenantId, name: name.slice(0, 120), parentId, description: String(dto.description ?? '').trim() || null,
      attachments: Array.isArray(dto.attachments) ? dto.attachments : [], status: 'active', createdBy: user.id, updatedBy: user.id,
    }));
  }

  async listEntries(user: AuthUser, query: any) {
    const tenantId = await this.assertAllowed(user);
    const where: any = { tenantId };
    if (query.flowType) where.flowType = query.flowType;
    if (query.reimbursementStatus) where.reimbursementStatus = query.reimbursementStatus;
    if (query.projectId) where.projectId = Number(query.projectId);
    if (query.q) where.reason = ILike(`%${String(query.q).slice(0, 100)}%`);
    return this.entryRepo.find({ where, order: { businessDate: 'DESC', id: 'DESC' }, take: 300 });
  }

  async createEntry(user: AuthUser, dto: any) {
    const tenantId = await this.assertAllowed(user);
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99_999_999_999) throw new BadRequestException('金额必须大于 0，且不超过 99999999999');
    const reason = String(dto.reason ?? '').trim();
    if (!reason) throw new BadRequestException('请填写事由');
    const flowType = dto.flowType === 'income' ? 'income' : dto.flowType === 'expense' ? 'expense' : null;
    if (!flowType) throw new BadRequestException('请选择收入或支出');
    const owner = ['osiris', 'pruis', 'personal'].includes(dto.owner) ? dto.owner : null;
    if (!owner) throw new BadRequestException('请选择归属');
    const paymentMethod = ['wechat', 'alipay', 'bank', 'cash'].includes(dto.paymentMethod) ? dto.paymentMethod : null;
    if (!paymentMethod) throw new BadRequestException('请选择支付方式');
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.entryRepo.create({
      tenantId,
      entryNo: `LS${today.replace(/-/g, '')}${String(Date.now()).slice(-7)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`,
      businessDate: /^20\d{2}-\d{2}-\d{2}$/.test(dto.businessDate) ? dto.businessDate : today,
      owner, reason: reason.slice(0, 500), amount: amount.toFixed(2), flowType, paymentMethod,
      projectId: dto.projectId ? Number(dto.projectId) : null, subProjectId: dto.subProjectId ? Number(dto.subProjectId) : null,
      voucherAttachments: Array.isArray(dto.voucherAttachments) ? dto.voucherAttachments : [],
      reimbursementRequired: Boolean(dto.reimbursementRequired),
      reimbursementStatus: dto.reimbursementRequired ? 'pending' : 'not_required',
      reimbursedAt: null, createdBy: user.id, updatedBy: user.id,
    });
    return this.entryRepo.save(entry);
  }

  async updateEntry(user: AuthUser, id: number, dto: any) {
    const tenantId = await this.assertAllowed(user);
    const entry = await this.entryRepo.findOne({ where: { id, tenantId } });
    if (!entry) throw new NotFoundException('流水不存在');
    if (dto.projectId !== undefined) entry.projectId = dto.projectId ? Number(dto.projectId) : null;
    if (dto.subProjectId !== undefined) entry.subProjectId = dto.subProjectId ? Number(dto.subProjectId) : null;
    if (dto.reason !== undefined && String(dto.reason).trim()) entry.reason = String(dto.reason).trim().slice(0, 500);
    entry.updatedBy = user.id;
    return this.entryRepo.save(entry);
  }

  async listInvoices(user: AuthUser, status?: string) {
    const tenantId = await this.assertAllowed(user);
    const where: any = { tenantId };
    if (status) where.status = status;
    return this.invoiceRepo.find({ where, order: { createdAt: 'DESC' }, take: 300 });
  }

  async invoiceCandidates(user: AuthUser, invoiceId: number) {
    const tenantId = await this.assertAllowed(user);
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId, tenantId } });
    if (!invoice) throw new NotFoundException('发票不存在');
    const entries = await this.entryRepo.find({ where: { tenantId, flowType: 'expense' }, order: { businessDate: 'DESC' }, take: 200 });
    return entries.map((entry) => ({ ...entry, score: (invoice.amount && Number(entry.amount) === Number(invoice.amount) ? 50 : 0) + (invoice.invoiceDate === entry.businessDate ? 30 : 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 30);
  }

  async matchInvoice(user: AuthUser, invoiceId: number, entryId: number) {
    const tenantId = await this.assertAllowed(user);
    const [invoice, entry] = await Promise.all([
      this.invoiceRepo.findOne({ where: { id: invoiceId, tenantId } }),
      this.entryRepo.findOne({ where: { id: entryId, tenantId } }),
    ]);
    if (!invoice || !entry) throw new NotFoundException('发票或流水不存在');
    invoice.entryId = entry.id; invoice.status = 'matched'; invoice.matchReason = '人工确认匹配'; invoice.discardReason = null; invoice.updatedBy = user.id;
    return this.invoiceRepo.save(invoice);
  }

  async discardInvoice(user: AuthUser, invoiceId: number, reason?: string) {
    const tenantId = await this.assertAllowed(user);
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId, tenantId } });
    if (!invoice) throw new NotFoundException('发票不存在');
    invoice.status = 'discarded'; invoice.discardReason = String(reason ?? '人工丢弃').slice(0, 500); invoice.updatedBy = user.id;
    return this.invoiceRepo.save(invoice);
  }

  async restoreInvoice(user: AuthUser, invoiceId: number) {
    const tenantId = await this.assertAllowed(user);
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId, tenantId } });
    if (!invoice) throw new NotFoundException('发票不存在');
    invoice.status = 'inbox'; invoice.discardReason = null; invoice.updatedBy = user.id;
    return this.invoiceRepo.save(invoice);
  }

  async listReimbursements(user: AuthUser) {
    const tenantId = await this.assertAllowed(user);
    return this.reimbursementRepo.find({ where: { tenantId }, order: { createdAt: 'DESC' }, take: 200 });
  }

  async createReimbursement(user: AuthUser, dto: any) {
    const tenantId = await this.assertAllowed(user);
    const entryIds: number[] = [...new Set<number>((Array.isArray(dto.entryIds) ? dto.entryIds : []).map(Number).filter((value: number) => Number.isInteger(value)))];
    if (!entryIds.length) throw new BadRequestException('请至少选择一笔待报销流水');
    const entries = await this.entryRepo.find({ where: { tenantId, id: In(entryIds), reimbursementStatus: 'pending' } });
    if (entries.length !== entryIds.length) throw new BadRequestException('所选流水中包含不存在、无需报销或已报销的记录，请刷新后重选');
    const openApplications = await this.reimbursementRepo.find({ where: { tenantId, status: 'submitted' } });
    const alreadySubmitted = new Set(openApplications.flatMap((item) => item.entryIds));
    if (entryIds.some((id) => alreadySubmitted.has(id))) throw new BadRequestException('所选流水中包含已提交的报销，请刷新后重选');
    const required: Array<[string, string]> = [['claimantName', '报销人姓名'], ['phone', '电话'], ['bankName', '开户行'], ['bankAccount', '银行账号'], ['reason', '报销事由']];
    for (const [key, label] of required) if (!String(dto[key] ?? '').trim()) throw new BadRequestException(`请填写${label}`);
    const today = new Date().toISOString().slice(0, 10);
    return this.reimbursementRepo.save(this.reimbursementRepo.create({
      tenantId, applicationNo: `BX${today.replace(/-/g, '')}${String(Date.now()).slice(-8)}`,
      claimantName: String(dto.claimantName).trim().slice(0, 80), phone: String(dto.phone).trim().slice(0, 30),
      applicationDate: /^20\d{2}-\d{2}-\d{2}$/.test(dto.applicationDate) ? dto.applicationDate : today,
      bankName: String(dto.bankName).trim().slice(0, 120), bankAccount: String(dto.bankAccount).trim().slice(0, 80),
      reason: String(dto.reason).trim().slice(0, 500), entryIds,
      amount: entries.reduce((sum, entry) => sum + Number(entry.amount), 0).toFixed(2), status: 'submitted', paidAt: null,
      createdBy: user.id, updatedBy: user.id,
    }));
  }

  async markReimbursementPaid(user: AuthUser, id: number) {
    const tenantId = await this.assertAllowed(user);
    const application = await this.reimbursementRepo.findOne({ where: { id, tenantId } });
    if (!application) throw new NotFoundException('报销申请不存在');
    if (application.status === 'cancelled') throw new BadRequestException('已取消的报销申请不能标记为已报销');
    application.status = 'paid'; application.paidAt = new Date(); application.updatedBy = user.id;
    await this.entryRepo.update({ tenantId, id: In(application.entryIds) }, { reimbursementStatus: 'reimbursed', reimbursedAt: new Date(), updatedBy: user.id });
    return this.reimbursementRepo.save(application);
  }
}
