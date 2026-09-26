import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import * as ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { AuthUser } from '../../common/current-user.decorator';
import { Tenant } from '../../entities/tenant.entity';
import {
  FinanceAccount, FinanceAccountingPeriod, FinanceAccountSet, FinanceEntry, FinanceOpeningBalance, FinanceOpeningImport, FinanceProject,
  FinanceVoucher, FinanceVoucherAudit, FinanceVoucherLine,
} from './finance.entities';
import { SMALL_ENTERPRISE_ACCOUNTS, round2, validateBalanced, validateOpeningEquation } from './finance-accounting.util';
import {
  BalanceSourceRow, buildBalanceSheet, buildCashFlowStatement, buildProfitStatement, CashFlowAmounts,
  classifyCashFlow, ProfitSourceRow, StatementRow,
} from './finance-reporting.util';

@Injectable()
export class FinanceAccountingService {
  constructor(
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(FinanceAccountSet, 'finance') private readonly setRepo: Repository<FinanceAccountSet>,
    @InjectRepository(FinanceAccount, 'finance') private readonly accountRepo: Repository<FinanceAccount>,
    @InjectRepository(FinanceOpeningImport, 'finance') private readonly openingImportRepo: Repository<FinanceOpeningImport>,
    @InjectRepository(FinanceOpeningBalance, 'finance') private readonly openingRepo: Repository<FinanceOpeningBalance>,
    @InjectRepository(FinanceVoucher, 'finance') private readonly voucherRepo: Repository<FinanceVoucher>,
    @InjectRepository(FinanceVoucherLine, 'finance') private readonly lineRepo: Repository<FinanceVoucherLine>,
    @InjectRepository(FinanceVoucherAudit, 'finance') private readonly auditRepo: Repository<FinanceVoucherAudit>,
    @InjectRepository(FinanceAccountingPeriod, 'finance') private readonly periodRepo: Repository<FinanceAccountingPeriod>,
    @InjectRepository(FinanceEntry, 'finance') private readonly entryRepo: Repository<FinanceEntry>,
    @InjectRepository(FinanceProject, 'finance') private readonly projectRepo: Repository<FinanceProject>,
  ) {}

  private tenant(user: AuthUser) {
    if (!user.tenantId) throw new BadRequestException('请先选择要管理的公司');
    return user.tenantId;
  }

  async ensureAccountSet(user: AuthUser) {
    const tenantId = this.tenant(user);
    let accountSet = await this.setRepo.findOne({ where: { tenantId } });
    if (!accountSet) {
      const period = new Date().toISOString().slice(0, 7);
      const seed = this.setRepo.create({
        tenantId, name: '上海企业账套', accountingStandard: 'small_enterprise', taxJurisdiction: 'shanghai',
        reportingProfile: 'shanghai_small_enterprise', taxFilingFrequency: 'quarterly_annual',
        requiredReports: ['balance_sheet','profit_statement','cash_flow_statement'], currentPeriod: period, closedThrough: null, currency: 'CNY',
        createdBy: user.id, updatedBy: user.id,
      });
      // The finance page loads several panels in parallel. Let PostgreSQL arbitrate
      // first-time initialization so concurrent requests cannot both insert the tenant row.
      await this.setRepo.createQueryBuilder().insert().into(FinanceAccountSet).values(seed).orIgnore().execute();
      accountSet = await this.setRepo.findOne({ where: { tenantId } });
      if (!accountSet) throw new Error('账套初始化失败');
    }
    const existing = new Set((await this.accountRepo.find({ where: { tenantId } })).map((a) => a.code));
    const missing = SMALL_ENTERPRISE_ACCOUNTS.filter((a) => !existing.has(a.code));
    if (missing.length) {
      const seeds = missing.map((a) => this.accountRepo.create({
        tenantId, code: a.code, name: a.name, level: 1, parentId: null, category: a.category,
        balanceDirection: a.direction, isSystem: true, allowPosting: true, isActive: true,
        statementMapping: a.mapping || {}, createdBy: user.id, updatedBy: user.id,
      }));
      await this.accountRepo.createQueryBuilder().insert().into(FinanceAccount).values(seeds).orIgnore().execute();
    }
    return accountSet;
  }

  async overview(user: AuthUser, period?: string) {
    const tenantId = this.tenant(user);
    const accountSet = await this.ensureAccountSet(user);
    const [accounts, draft, reviewed, posted, periods] = await Promise.all([
      this.accountRepo.find({ where: { tenantId }, order: { code: 'ASC' } }),
      this.voucherRepo.count({ where: { tenantId, status: 'draft', ...(period ? { period } : {}) } }),
      this.voucherRepo.count({ where: { tenantId, status: 'reviewed', ...(period ? { period } : {}) } }),
      this.voucherRepo.count({ where: { tenantId, status: 'posted', ...(period ? { period } : {}) } }),
      this.periodRepo.find({ where: { tenantId }, order: { period: 'DESC' }, take: 24 }),
    ]);
    return { accountSet, accounts, voucherCounts: { draft, reviewed, posted }, periods };
  }

  async createDetailAccount(user: AuthUser, dto: any) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const parent = await this.accountRepo.findOne({ where: { tenantId, id: Number(dto.parentId), isActive: true } });
    if (!parent) throw new BadRequestException('请选择有效的上级科目');
    const code = String(dto.code || '').trim(); const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('请填写明细科目名称');
    if (!/^\d{5,32}$/.test(code) || !code.startsWith(parent.code)) throw new BadRequestException(`明细科目编码必须以 ${parent.code} 开头，且长度至少 5 位`);
    if (await this.accountRepo.exist({ where: { tenantId, code } })) throw new BadRequestException(`科目编码 ${code} 已存在`);
    if (parent.level >= 8) throw new BadRequestException('明细科目层级不能超过 8 级');
    parent.allowPosting = false; parent.updatedBy = user.id; await this.accountRepo.save(parent);
    return this.accountRepo.save(this.accountRepo.create({
      tenantId, code, name: name.slice(0, 120), level: parent.level + 1, parentId: parent.id,
      category: parent.category, balanceDirection: parent.balanceDirection, isSystem: false, allowPosting: true,
      isActive: true, statementMapping: parent.statementMapping, createdBy: user.id, updatedBy: user.id,
    }));
  }

  async openingBalances(user: AuthUser, period: string) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const accounts = await this.accountRepo.find({ where: { tenantId, isActive: true }, order: { code: 'ASC' } });
    const balances = await this.openingRepo.find({ where: { tenantId, period } });
    const byAccount = new Map(balances.map((b) => [b.accountId, b]));
    const rows = accounts.map((account) => ({ account, debitAmount: byAccount.get(account.id)?.debitAmount || '0.00', creditAmount: byAccount.get(account.id)?.creditAmount || '0.00' }));
    const validation = validateOpeningEquation(rows.map((r) => ({ category: r.account.category, debit: Number(r.debitAmount), credit: Number(r.creditAmount) })));
    return { period, rows, validation };
  }

  async openingTemplate(user: AuthUser) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const accounts = await this.accountRepo.find({ where: { tenantId, isActive: true }, order: { code: 'ASC' } });
    const sheet = XLSX.utils.json_to_sheet(accounts.map((a) => ({ 科目编码: a.code, 科目名称: a.name, 期初借方: 0, 期初贷方: 0 })));
    sheet['!cols'] = [{ wch: 14 }, { wch: 28 }, { wch: 16 }, { wch: 16 }];
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '期初余额');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  async importOpening(user: AuthUser, period: string, file?: Express.Multer.File) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    if (!file?.buffer?.length) throw new BadRequestException('请选择科目余额表 Excel 文件');
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException('期初期间格式应为 YYYY-MM');
    await this.assertOpen(tenantId, period);
    let raw: any[];
    try { const wb = XLSX.read(file.buffer, { type: 'buffer' }); raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }); }
    catch { throw new BadRequestException('无法读取 Excel，请使用系统模板或标准 XLSX 文件'); }
    const accounts = await this.accountRepo.find({ where: { tenantId } }); const byCode = new Map(accounts.map((a) => [a.code, a]));
    const errors: string[] = []; const parsed: Array<{ account: FinanceAccount; debit: number; credit: number }> = [];
    raw.forEach((row: any, index) => {
      const code = String(row['科目编码'] ?? row['科目代码'] ?? row['code'] ?? '').trim();
      if (!code) return;
      const account = byCode.get(code); if (!account) { errors.push(`第 ${index + 2} 行：科目编码 ${code} 不存在`); return; }
      const debit = Number(row['期初借方'] ?? row['借方余额'] ?? row['debit'] ?? 0); const credit = Number(row['期初贷方'] ?? row['贷方余额'] ?? row['credit'] ?? 0);
      if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) { errors.push(`第 ${index + 2} 行：借贷金额必须是非负数字`); return; }
      if (debit > 0 && credit > 0) { errors.push(`第 ${index + 2} 行：同一科目不能同时填写借方和贷方余额`); return; }
      parsed.push({ account, debit: round2(debit), credit: round2(credit) });
    });
    const validation = validateOpeningEquation(parsed.map((r) => ({ category: r.account.category, debit: r.debit, credit: r.credit })));
    if (!validation.balanced) errors.push(`试算不平衡：借方合计 ${validation.debit.toFixed(2)}，贷方合计 ${validation.credit.toFixed(2)}，相差 ${Math.abs(validation.debit - validation.credit).toFixed(2)}`);
    if (!validation.equationBalanced) errors.push(`会计恒等式不成立：资产 ${validation.assets.toFixed(2)}，负债和所有者权益 ${validation.liabilitiesAndEquity.toFixed(2)}`);
    const batch = await this.openingImportRepo.save(this.openingImportRepo.create({ tenantId, period, originalName: file.originalname.slice(0,255), status: errors.length ? 'invalid' : 'valid', totalRows: raw.length, importedRows: errors.length ? 0 : parsed.length, debitTotal: validation.debit.toFixed(2), creditTotal: validation.credit.toFixed(2), errors, createdBy: user.id, updatedBy: user.id }));
    if (errors.length) return { batch, validation };
    await this.openingRepo.delete({ tenantId, period });
    await this.openingRepo.save(parsed.filter((r) => r.debit || r.credit).map((r) => this.openingRepo.create({ tenantId, period, accountId: r.account.id, debitAmount: r.debit.toFixed(2), creditAmount: r.credit.toFixed(2), importId: batch.id, createdBy: user.id, updatedBy: user.id })));
    return { batch, validation };
  }

  async autoVoucherFromEntry(user: AuthUser, entry: FinanceEntry) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const old = await this.voucherRepo.findOne({ where: { tenantId, sourceType: 'entry', sourceId: entry.id } });
    if (old) return old;
    const codes = entry.flowType === 'income'
      ? [entry.paymentMethod === 'cash' ? '1001' : '1002', '5051']
      : ['5602', entry.reimbursementRequired ? '2241' : entry.paymentMethod === 'cash' ? '1001' : '1002'];
    const accounts = await this.accountRepo.find({ where: { tenantId, code: In(codes) } }); const map = new Map(accounts.map((a) => [a.code, a]));
    const amount = Number(entry.amount); const lines = entry.flowType === 'income'
      ? [{ accountId: map.get(codes[0])!.id, debit: amount, credit: 0 }, { accountId: map.get(codes[1])!.id, debit: 0, credit: amount }]
      : [{ accountId: map.get(codes[0])!.id, debit: amount, credit: 0 }, { accountId: map.get(codes[1])!.id, debit: 0, credit: amount }];
    return this.saveVoucher(user, null, { voucherDate: entry.businessDate, summary: entry.reason, sourceType: 'entry', sourceId: entry.id, lines: lines.map((line) => ({ ...line, summary: entry.reason, projectId: entry.projectId, attachments: entry.voucherAttachments })) }, '自动生成');
  }

  async assertBusinessDateOpen(user: AuthUser, businessDate: string) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    await this.assertOpen(tenantId, businessDate.slice(0, 7));
  }

  async syncBusinessSources(user: AuthUser) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const entries = await this.entryRepo.find({ where: { tenantId }, order: { id: 'ASC' }, take: 5000 });
    const existing = await this.voucherRepo.find({ where: { tenantId, sourceType: 'entry' } });
    const done = new Set(existing.map((v) => v.sourceId)); let created = 0;
    for (const entry of entries) if (!done.has(entry.id)) { await this.autoVoucherFromEntry(user, entry); created += 1; }
    return { scanned: entries.length, created, skipped: entries.length - created };
  }

  async listVouchers(user: AuthUser, period?: string) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const where: any = { tenantId }; if (period) where.period = period;
    const vouchers = await this.voucherRepo.find({ where, order: { voucherDate: 'DESC', id: 'DESC' }, take: 500 });
    const lines = vouchers.length ? await this.lineRepo.find({ where: { tenantId, voucherId: In(vouchers.map((v) => v.id)) }, order: { lineNo: 'ASC' } }) : [];
    const accounts = await this.accountRepo.find({ where: { tenantId } }); const accountMap = new Map(accounts.map((a) => [a.id, a]));
    return vouchers.map((v) => ({ ...v, lines: lines.filter((l) => l.voucherId === v.id).map((l) => ({ ...l, account: accountMap.get(l.accountId) })) }));
  }

  async saveVoucher(user: AuthUser, id: number | null, dto: any, action = '人工保存') {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const date = /^20\d{2}-\d{2}-\d{2}$/.test(dto.voucherDate) ? dto.voucherDate : new Date().toISOString().slice(0,10); const period = date.slice(0,7);
    await this.assertOpen(tenantId, period);
    const input = Array.isArray(dto.lines) ? dto.lines : [];
    if (input.length < 2) throw new BadRequestException('凭证至少需要两条分录');
    const accountIds = input.map((l: any) => Number(l.accountId)); const accounts = await this.accountRepo.find({ where: { tenantId, id: In(accountIds), isActive: true } });
    if (new Set(accounts.map((a) => a.id)).size !== new Set(accountIds).size) throw new BadRequestException('凭证中包含不存在或停用的科目');
    if (accounts.some((a) => !a.allowPosting)) throw new BadRequestException('凭证不能记入含有明细科目的上级科目，请选择末级科目');
    const normalized = input.map((line: any) => ({ ...line, debit: round2(Number(line.debit || 0)), credit: round2(Number(line.credit || 0)) }));
    if (normalized.some((l: any) => l.debit < 0 || l.credit < 0 || (l.debit > 0 && l.credit > 0))) throw new BadRequestException('每条分录只能填写借方或贷方，金额不能为负数');
    const validation = validateBalanced(normalized); if (!validation.balanced) throw new BadRequestException(`凭证借贷不平：借方 ${validation.debit.toFixed(2)}，贷方 ${validation.credit.toFixed(2)}`);
    let voucher = id ? await this.voucherRepo.findOne({ where: { tenantId, id } }) : null;
    if (id && !voucher) throw new NotFoundException('凭证不存在');
    if (voucher?.status === 'posted') throw new BadRequestException('已过账凭证不能直接修改，请先反结账并取消过账');
    const count = await this.voucherRepo.count({ where: { tenantId, period } });
    voucher = this.voucherRepo.create({ ...(voucher || {}), tenantId, voucherNo: voucher?.voucherNo || `记-${String(count + 1).padStart(4,'0')}`, voucherDate: date, period, summary: String(dto.summary || '').trim().slice(0,500) || '未填写摘要', status: 'draft', sourceType: dto.sourceType || voucher?.sourceType || null, sourceId: dto.sourceId ? Number(dto.sourceId) : voucher?.sourceId || null, totalDebit: validation.debit.toFixed(2), totalCredit: validation.credit.toFixed(2), revision: (voucher?.revision || 0) + (id ? 1 : 0), reviewedBy: null, reviewedAt: null, postedBy: null, postedAt: null, createdBy: voucher?.createdBy || user.id, updatedBy: user.id });
    voucher = await this.voucherRepo.save(voucher); await this.lineRepo.delete({ tenantId, voucherId: voucher.id });
    await this.lineRepo.save(normalized.map((line: any, index: number) => this.lineRepo.create({ tenantId, voucherId: voucher!.id, lineNo: index + 1, accountId: Number(line.accountId), summary: String(line.summary || voucher!.summary).slice(0,500), debit: line.debit.toFixed(2), credit: line.credit.toFixed(2), projectId: line.projectId ? Number(line.projectId) : null, counterpartyName: String(line.counterpartyName || '').trim() || null, cashFlowItem: String(line.cashFlowItem || '').trim() || null, attachments: Array.isArray(line.attachments) ? line.attachments : [], createdBy: user.id, updatedBy: user.id })));
    await this.auditRepo.save(this.auditRepo.create({ tenantId, voucherId: voucher.id, action: id ? 'update' : 'create', description: action, snapshot: { revision: voucher.revision, totalDebit: voucher.totalDebit, totalCredit: voucher.totalCredit }, createdBy: user.id, updatedBy: user.id }));
    return voucher;
  }

  async changeVoucherStatus(user: AuthUser, id: number, action: 'review'|'post'|'unpost') {
    const tenantId = this.tenant(user); const voucher = await this.voucherRepo.findOne({ where: { tenantId, id } });
    if (!voucher) throw new NotFoundException('凭证不存在'); await this.assertOpen(tenantId, voucher.period);
    if (!['review','post','unpost'].includes(action)) throw new BadRequestException('不支持的凭证操作');
    if (action === 'review') { if (voucher.status !== 'draft') throw new BadRequestException('只有草稿凭证可以复核'); voucher.status = 'reviewed'; voucher.reviewedBy = user.id; voucher.reviewedAt = new Date(); }
    if (action === 'post') { if (voucher.status !== 'reviewed') throw new BadRequestException('凭证需要先复核才能过账'); voucher.status = 'posted'; voucher.postedBy = user.id; voucher.postedAt = new Date(); }
    if (action === 'unpost') { if (voucher.status !== 'posted') throw new BadRequestException('只有已过账凭证可以取消过账'); voucher.status = 'draft'; voucher.postedBy = null; voucher.postedAt = null; voucher.reviewedBy = null; voucher.reviewedAt = null; }
    voucher.updatedBy = user.id; await this.voucherRepo.save(voucher);
    await this.auditRepo.save(this.auditRepo.create({ tenantId, voucherId: id, action, description: {review:'复核凭证',post:'凭证过账',unpost:'取消过账'}[action], snapshot: { status: voucher.status }, createdBy: user.id, updatedBy: user.id })); return voucher;
  }

  async voucherHistory(user: AuthUser, id: number) { const tenantId = this.tenant(user); return this.auditRepo.find({ where: { tenantId, voucherId: id }, order: { createdAt: 'DESC' } }); }

  async ledger(user: AuthUser, period: string) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const accounts = await this.accountRepo.find({ where: { tenantId }, order: { code: 'ASC' } });
    const openings = await this.openingRepo.find({ where: { tenantId, period: LessThanOrEqual(period) } });
    const vouchers = await this.voucherRepo.find({ where: { tenantId, status: 'posted', period: LessThanOrEqual(period) } });
    const lines = vouchers.length ? await this.lineRepo.find({ where: { tenantId, voucherId: In(vouchers.map((v) => v.id)) } }) : [];
    const voucherMap = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
    const rows = accounts.map((account) => {
      const latestOpening = openings.filter((item) => item.accountId === account.id).sort((a,b) => b.period.localeCompare(a.period))[0];
      const priorLines = lines.filter((entry) => {
        const voucher = voucherMap.get(entry.voucherId); return entry.accountId === account.id && !!voucher && voucher.period < period && (!latestOpening || voucher.period >= latestOpening.period);
      });
      const opening = (latestOpening ? Number(latestOpening.debitAmount) - Number(latestOpening.creditAmount) : 0) + priorLines.reduce((amount, entry) => amount + Number(entry.debit) - Number(entry.credit), 0);
      const own = lines.filter((entry) => entry.accountId === account.id && voucherMap.get(entry.voucherId)?.period === period); const debit = round2(own.reduce((s,l)=>s+Number(l.debit),0)); const credit = round2(own.reduce((s,l)=>s+Number(l.credit),0));
      const rawClosing = round2(opening + debit - credit); const closingDebit = rawClosing > 0 ? rawClosing : 0; const closingCredit = rawClosing < 0 ? -rawClosing : 0;
      return { account, openingDebit: opening > 0 ? opening.toFixed(2) : '0.00', openingCredit: opening < 0 ? (-opening).toFixed(2) : '0.00', debit: debit.toFixed(2), credit: credit.toFixed(2), closingDebit: closingDebit.toFixed(2), closingCredit: closingCredit.toFixed(2) };
    }).filter((r) => [r.openingDebit,r.openingCredit,r.debit,r.credit].some((v)=>Number(v)!==0));
    return { period, rows, validation: { debit: round2(rows.reduce((s,r)=>s+Number(r.debit),0)), credit: round2(rows.reduce((s,r)=>s+Number(r.credit),0)) } };
  }

  async ledgerEntries(user: AuthUser, period: string) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user);
    const vouchers = await this.voucherRepo.find({ where: { tenantId, period, status: 'posted' }, order: { voucherDate: 'ASC', voucherNo: 'ASC' } });
    if (!vouchers.length) return { period, entries: [], projectSummary: [], counterpartySummary: [] };
    const [lines, accounts, projects] = await Promise.all([
      this.lineRepo.find({ where: { tenantId, voucherId: In(vouchers.map((v) => v.id)) }, order: { voucherId: 'ASC', lineNo: 'ASC' } }),
      this.accountRepo.find({ where: { tenantId } }), this.projectRepo.find({ where: { tenantId } }),
    ]);
    const voucherMap = new Map(vouchers.map((v) => [v.id,v])); const accountMap = new Map(accounts.map((a)=>[a.id,a])); const projectMap = new Map(projects.map((p)=>[p.id,p]));
    const entries = lines.map((line) => ({ ...line, voucher: voucherMap.get(line.voucherId), account: accountMap.get(line.accountId), projectName: line.projectId ? projectMap.get(line.projectId)?.name || `项目 #${line.projectId}` : null }));
    const summarize = (key: 'projectName'|'counterpartyName') => {
      const groups = new Map<string,{name:string;debit:number;credit:number;entries:number}>();
      for (const row of entries) { const name = row[key]; if (!name) continue; const old=groups.get(name)||{name,debit:0,credit:0,entries:0}; old.debit=round2(old.debit+Number(row.debit)); old.credit=round2(old.credit+Number(row.credit)); old.entries+=1; groups.set(name,old); }
      return [...groups.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
    };
    return { period, entries, projectSummary: summarize('projectName'), counterpartySummary: summarize('counterpartyName') };
  }

  async reports(user: AuthUser, period: string) {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestException('报表期间格式应为 YYYY-MM');
    const tenantId = this.tenant(user); const accountSet = await this.ensureAccountSet(user);
    const yearStart = `${period.slice(0, 4)}-01`;
    const [tenant, accounts, openings, vouchers] = await Promise.all([
      this.tenantRepo.findOne({ where: { id: tenantId } }),
      this.accountRepo.find({ where: { tenantId, isActive: true }, order: { code: 'ASC' } }),
      this.openingRepo.find({ where: { tenantId, period: LessThanOrEqual(period) } }),
      this.voucherRepo.find({ where: { tenantId, status: 'posted', period: LessThanOrEqual(period) }, order: { voucherDate: 'ASC', id: 'ASC' } }),
    ]);
    const lines = vouchers.length ? await this.lineRepo.find({ where: { tenantId, voucherId: In(vouchers.map((voucher) => voucher.id)) }, order: { voucherId: 'ASC', lineNo: 'ASC' } }) : [];
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    const voucherMap = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
    const snapshot = (boundary: string, includeBoundary: boolean) => {
      const result = new Map<number, number>();
      for (const account of accounts) {
        const available = openings.filter((opening) => opening.accountId === account.id && opening.period <= boundary).sort((a, b) => b.period.localeCompare(a.period));
        const opening = available[0]; let value = opening ? Number(opening.debitAmount) - Number(opening.creditAmount) : 0;
        for (const entry of lines.filter((entry) => entry.accountId === account.id)) {
          const voucher = voucherMap.get(entry.voucherId); if (!voucher) continue;
          if (opening && voucher.period < opening.period) continue;
          if (voucher.period < boundary || includeBoundary && voucher.period === boundary) value += Number(entry.debit) - Number(entry.credit);
        }
        result.set(account.id, round2(value));
      }
      return result;
    };
    const yearOpening = snapshot(yearStart, false); const currentOpening = snapshot(period, false); const closing = snapshot(period, true);
    const balanceRows: BalanceSourceRow[] = accounts.map((account) => ({
      code: account.code, name: account.name, category: account.category, item: account.statementMapping?.item || null,
      opening: yearOpening.get(account.id) || 0, closing: closing.get(account.id) || 0,
    }));
    const balanceSheet = buildBalanceSheet(balanceRows);
    const operatingVouchers = vouchers.filter((voucher) => voucher.sourceType !== 'profit_close');
    const operatingVoucherIds = new Set(operatingVouchers.map((voucher) => voucher.id));
    const profitRows: ProfitSourceRow[] = accounts.map((account) => {
      const own = lines.filter((entry) => entry.accountId === account.id && operatingVoucherIds.has(entry.voucherId));
      const total = (from: string, to: string, direction: 'debit' | 'credit') => round2(own.reduce((amount, entry) => {
        const voucher = voucherMap.get(entry.voucherId); if (!voucher || voucher.period < from || voucher.period > to) return amount;
        return amount + Number(entry[direction]);
      }, 0));
      return {
        code: account.code, name: account.name, item: account.statementMapping?.item || null,
        currentDebit: total(period, period, 'debit'), currentCredit: total(period, period, 'credit'),
        ytdDebit: total(yearStart, period, 'debit'), ytdCredit: total(yearStart, period, 'credit'),
      };
    });
    const profitStatement = buildProfitStatement(profitRows);
    const cashAmounts: CashFlowAmounts = {}; const classification = { explicit: 0, inferred: 0, pending: 0, pendingAmount: 0 };
    for (const voucher of operatingVouchers.filter((item) => item.period >= yearStart && item.period <= period)) {
      const voucherLines = lines.filter((entry) => entry.voucherId === voucher.id);
      const cashLines = voucherLines.filter((entry) => accountMap.get(entry.accountId)?.statementMapping?.item === 'cash');
      const cashDelta = round2(cashLines.reduce((amount, entry) => amount + Number(entry.debit) - Number(entry.credit), 0));
      if (!cashDelta) continue;
      const counterpart = voucherLines.filter((entry) => accountMap.get(entry.accountId)?.statementMapping?.item !== 'cash');
      const explicit = voucherLines.map((entry) => entry.cashFlowItem).find(Boolean) || null;
      const classified = classifyCashFlow(counterpart.map((entry) => accountMap.get(entry.accountId)?.code || ''), counterpart.map((entry) => accountMap.get(entry.accountId)?.statementMapping?.item || null), cashDelta, explicit);
      const amount = Math.abs(cashDelta); const target = cashAmounts[classified.line] || { current: 0, ytd: 0 };
      target.ytd = round2(target.ytd + amount); if (voucher.period === period) target.current = round2(target.current + amount); cashAmounts[classified.line] = target;
      classification[classified.source] += 1; if (classified.source === 'pending') classification.pendingAmount = round2(classification.pendingAmount + amount);
    }
    const cashBalance = (values: Map<number, number>) => round2(accounts.filter((account) => account.statementMapping?.item === 'cash').reduce((amount, account) => amount + (values.get(account.id) || 0), 0));
    const cashFlowStatement = buildCashFlowStatement(cashAmounts, cashBalance(currentOpening), cashBalance(yearOpening), classification);
    const ledgerValidation = validateBalanced(lines.filter((entry) => voucherMap.has(entry.voucherId)).map((entry) => ({ debit: Number(entry.debit), credit: Number(entry.credit) })));
    const cashFlowReconciled = round2(cashFlowStatement.endingCash) === round2(cashBalance(closing));
    const validations = [
      { key: 'voucher_balance', label: '已过账凭证借贷平衡', ok: ledgerValidation.balanced || !lines.length, detail: `借方 ${ledgerValidation.debit.toFixed(2)} / 贷方 ${ledgerValidation.credit.toFixed(2)}` },
      { key: 'opening_equation', label: '年初资产负债平衡', ok: balanceSheet.openingBalanced, detail: balanceSheet.openingBalanced ? '资产等于负债和所有者权益' : '年初余额不平，请核对期初余额导入' },
      { key: 'closing_equation', label: '期末资产负债平衡', ok: balanceSheet.balanced, detail: balanceSheet.balanced ? '资产等于负债和所有者权益' : '期末报表不平，请检查凭证和科目映射' },
      { key: 'cash_reconciliation', label: '现金流量表与货币资金衔接', ok: cashFlowReconciled, detail: `现金流量表期末 ${cashFlowStatement.endingCash.toFixed(2)} / 货币资金 ${cashBalance(closing).toFixed(2)}` },
      { key: 'cash_classification', label: '现金流分类完整', ok: classification.pending === 0, warning: true, detail: classification.pending ? `${classification.pending} 笔、${classification.pendingAmount.toFixed(2)} 元暂归“其他经营活动”，需在凭证中确认现金流项目` : '全部现金收支已明确或自动匹配现金流项目' },
    ];
    return {
      period, entityName: tenant?.name || accountSet.name, accountingStandard: '小企业会计准则', currency: 'CNY', unit: '元',
      balanceSheet, profitStatement, cashFlowStatement, validations, traceable: true, cashFlowReconciled,
    };
  }

  async reportWorkbook(user: AuthUser, period: string) {
    const [reports, ledger] = await Promise.all([this.reports(user, period), this.ledger(user, period)]);
    const book = new ExcelJS.Workbook(); book.creator = 'PMS 财务系统'; book.created = new Date(); book.modified = new Date();
    const colors = { navy: '173F67', blue: '2B6F9F', pale: 'EAF2F8', section: 'EFF6F4', total: 'DDECF5', border: 'AEBECD', white: 'FFFFFF', warning: 'FFF4D6' };
    const moneyFormat = '#,##0.00;[Red]-#,##0.00';
    const border = { top: { style: 'thin', color: { argb: colors.border } }, left: { style: 'thin', color: { argb: colors.border } }, bottom: { style: 'thin', color: { argb: colors.border } }, right: { style: 'thin', color: { argb: colors.border } } } as ExcelJS.Borders;
    const styleTitle = (sheet: ExcelJS.Worksheet, lastColumn: number, title: string, code: string) => {
      sheet.mergeCells(1, 1, 1, lastColumn); const titleCell = sheet.getCell(1, 1); titleCell.value = title; titleCell.font = { name: 'Microsoft YaHei', size: 18, bold: true, color: { argb: colors.navy } }; titleCell.alignment = { horizontal: 'center', vertical: 'middle' }; sheet.getRow(1).height = 32;
      sheet.mergeCells(2, 1, 2, Math.floor(lastColumn / 2)); sheet.getCell(2, 1).value = `编制单位：${reports.entityName}`;
      sheet.mergeCells(2, Math.floor(lastColumn / 2) + 1, 2, lastColumn); sheet.getCell(2, Math.floor(lastColumn / 2) + 1).value = code; sheet.getCell(2, Math.floor(lastColumn / 2) + 1).alignment = { horizontal: 'right' };
      sheet.mergeCells(3, 1, 3, Math.floor(lastColumn / 2)); sheet.getCell(3, 1).value = `报表期间：${period}`;
      sheet.mergeCells(3, Math.floor(lastColumn / 2) + 1, 3, lastColumn); sheet.getCell(3, Math.floor(lastColumn / 2) + 1).value = '单位：元'; sheet.getCell(3, Math.floor(lastColumn / 2) + 1).alignment = { horizontal: 'right' };
      for (let row = 1; row <= 3; row += 1) sheet.getRow(row).font = { ...sheet.getRow(row).font, name: 'Microsoft YaHei' };
    };
    const styleDataRow = (row: ExcelJS.Row, kind: StatementRow['kind'], amountColumns: number[]) => {
      row.eachCell((cell) => { cell.border = border; cell.font = { name: 'Microsoft YaHei', size: 10, bold: kind === 'subtotal' || kind === 'total' || kind === 'section' }; cell.alignment = { vertical: 'middle', wrapText: true }; });
      if (kind === 'section') row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.section } }; });
      if (kind === 'subtotal' || kind === 'total') row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: kind === 'total' ? colors.total : colors.pale } }; });
      for (const column of amountColumns) { row.getCell(column).numFmt = moneyFormat; row.getCell(column).alignment = { horizontal: 'right', vertical: 'middle' }; }
      row.height = kind === 'section' ? 23 : 26;
    };
    const balance = book.addWorksheet('资产负债表', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.25, right: 0.25, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 } } });
    styleTitle(balance, 8, '资产负债表（小企业会计准则）', reports.balanceSheet.formCode);
    balance.addRow(['资产','行次','期末余额','年初余额','负债和所有者权益','行次','期末余额','年初余额']);
    const balanceHeader = balance.getRow(4); balanceHeader.height = 30; balanceHeader.eachCell((cell) => { cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: colors.white } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } }; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; cell.border = border; });
    const maxRows = Math.max(reports.balanceSheet.assetRows.length, reports.balanceSheet.liabilityEquityRows.length);
    for (let index = 0; index < maxRows; index += 1) {
      const left = reports.balanceSheet.assetRows[index]; const right = reports.balanceSheet.liabilityEquityRows[index];
      const row = balance.addRow([left?.label || '', left?.line ?? '', left?.closing ?? null, left?.opening ?? null, right?.label || '', right?.line ?? '', right?.closing ?? null, right?.opening ?? null]);
      styleDataRow(row, left?.kind === 'total' || right?.kind === 'total' ? 'total' : left?.kind === 'subtotal' || right?.kind === 'subtotal' ? 'subtotal' : left?.kind === 'section' || right?.kind === 'section' ? 'section' : 'item', [3,4,7,8]);
      if (left?.kind === 'detail') row.getCell(1).alignment = { indent: 1, vertical: 'middle' }; if (right?.kind === 'detail') row.getCell(5).alignment = { indent: 1, vertical: 'middle' };
    }
    balance.columns = [{ width: 25 }, { width: 7 }, { width: 15 }, { width: 15 }, { width: 30 }, { width: 7 }, { width: 15 }, { width: 15 }]; balance.views = [{ state: 'frozen', ySplit: 4 }];
    const addVerticalStatement = (name: string, title: string, statement: { formCode: string; rows: StatementRow[] }) => {
      const sheet = book.addWorksheet(name, { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 } } });
      styleTitle(sheet, 4, title, statement.formCode); sheet.addRow(['项目','行次','本年累计金额','本月金额']);
      const header = sheet.getRow(4); header.height = 30; header.eachCell((cell) => { cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: colors.white } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } }; cell.alignment = { horizontal: 'center', vertical: 'middle' }; cell.border = border; });
      for (const item of statement.rows) { const row = sheet.addRow([item.label, item.line ?? '', item.ytd ?? null, item.current ?? null]); styleDataRow(row, item.kind, [3,4]); if (item.kind === 'detail') row.getCell(1).alignment = { indent: 1, vertical: 'middle' }; }
      sheet.columns = [{ width: 48 }, { width: 8 }, { width: 18 }, { width: 18 }]; sheet.views = [{ state: 'frozen', ySplit: 4 }]; return sheet;
    };
    addVerticalStatement('利润表', '利润表（小企业会计准则）', reports.profitStatement);
    addVerticalStatement('现金流量表', '现金流量表（小企业会计准则）', reports.cashFlowStatement);
    const checks = book.addWorksheet('报表校验'); checks.addRow(['校验项目','结果','说明']);
    checks.getRow(1).eachCell((cell) => { cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: colors.white } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } }; cell.border = border; });
    for (const check of reports.validations) { const row = checks.addRow([check.label, check.ok ? '通过' : check.warning ? '需确认' : '不通过', check.detail]); row.eachCell((cell) => { cell.font = { name: 'Microsoft YaHei' }; cell.border = border; cell.alignment = { vertical: 'middle', wrapText: true }; }); if (!check.ok) row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.warning } }; }); }
    checks.columns = [{ width: 32 }, { width: 12 }, { width: 72 }]; checks.views = [{ state: 'frozen', ySplit: 1 }];
    const balanceList = book.addWorksheet('科目余额表'); balanceList.addRow(['科目编码','科目名称','期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方']);
    balanceList.getRow(1).eachCell((cell) => { cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: colors.white } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } }; cell.border = border; cell.alignment = { horizontal: 'center' }; });
    for (const item of ledger.rows) { const row = balanceList.addRow([item.account.code,item.account.name,Number(item.openingDebit),Number(item.openingCredit),Number(item.debit),Number(item.credit),Number(item.closingDebit),Number(item.closingCredit)]); row.eachCell((cell, column) => { cell.font = { name: 'Microsoft YaHei' }; cell.border = border; if (column >= 3) cell.numFmt = moneyFormat; }); }
    balanceList.columns = [{ width: 14 },{ width: 28 },{ width: 16 },{ width: 16 },{ width: 16 },{ width: 16 },{ width: 16 },{ width: 16 }]; balanceList.views = [{ state: 'frozen', ySplit: 1 }]; balanceList.autoFilter = 'A1:H1';
    const output = await book.xlsx.writeBuffer(); return Buffer.from(output);
  }

  async generateProfitClosingVoucher(user: AuthUser, period: string) {
    const tenantId = this.tenant(user); await this.ensureAccountSet(user); await this.assertOpen(tenantId, period);
    const sourceId = Number(period.replace('-', ''));
    const existing = await this.voucherRepo.findOne({ where: { tenantId, sourceType: 'profit_close', sourceId } });
    if (existing) throw new BadRequestException(`${period} 已生成损益结转凭证 ${existing.voucherNo}，请勿重复生成`);
    const vouchers = await this.voucherRepo.find({ where: { tenantId, period, status: 'posted' } });
    if (!vouchers.length) throw new BadRequestException('本期没有已过账凭证，不能生成损益结转');
    const [lines, accounts] = await Promise.all([
      this.lineRepo.find({ where: { tenantId, voucherId: In(vouchers.map((v) => v.id)) } }),
      this.accountRepo.find({ where: { tenantId, isActive: true } }),
    ]);
    const closing: any[] = [];
    for (const account of accounts.filter((a) => a.category === 'profit_loss' && a.allowPosting)) {
      const own = lines.filter((l) => l.accountId === account.id); const balance = round2(own.reduce((s,l)=>s+Number(l.debit)-Number(l.credit),0));
      if (balance > 0) closing.push({ accountId: account.id, summary: `${period} 损益结转`, debit: 0, credit: balance });
      if (balance < 0) closing.push({ accountId: account.id, summary: `${period} 损益结转`, debit: -balance, credit: 0 });
    }
    if (!closing.length) throw new BadRequestException('本期损益科目余额为零，无需生成结转凭证');
    const result = validateBalanced(closing); const profit = accounts.find((a) => a.code === '3103');
    if (!profit) throw new BadRequestException('标准科目“3103 本年利润”不存在');
    if (result.debit > result.credit) closing.push({ accountId: profit.id, summary: `${period} 损益结转`, debit: 0, credit: round2(result.debit-result.credit) });
    if (result.credit > result.debit) closing.push({ accountId: profit.id, summary: `${period} 损益结转`, debit: round2(result.credit-result.debit), credit: 0 });
    return this.saveVoucher(user, null, { voucherDate: `${period}-${new Date(Number(period.slice(0,4)),Number(period.slice(5,7)),0).getDate()}`, summary: `${period} 损益结转`, sourceType: 'profit_close', sourceId, lines: closing }, '系统生成损益结转凭证');
  }

  async closePeriod(user: AuthUser, period: string) {
    const tenantId = this.tenant(user); const reports = await this.reports(user, period);
    const draftCount = await this.voucherRepo.count({ where: [{ tenantId, period, status: 'draft' }, { tenantId, period, status: 'reviewed' }] });
    if (draftCount) throw new BadRequestException(`本期还有 ${draftCount} 张凭证未过账，请处理后再结账`);
    if (!reports.balanceSheet.balanced) throw new BadRequestException(`资产负债表不平：资产 ${reports.balanceSheet.assets.toFixed(2)}，负债和所有者权益 ${reports.balanceSheet.liabilitiesAndEquity.toFixed(2)}`);
    let entity = await this.periodRepo.findOne({ where: { tenantId, period } }); entity = this.periodRepo.create({ ...(entity || {}), tenantId, period, status: 'closed', closedAt: new Date(), closedBy: user.id, validationSnapshot: reports, createdBy: entity?.createdBy || user.id, updatedBy: user.id }); await this.periodRepo.save(entity);
    const set = await this.ensureAccountSet(user); if (!set.closedThrough || set.closedThrough < period) { set.closedThrough = period; set.updatedBy = user.id; await this.setRepo.save(set); } return entity;
  }

  async reverseClose(user: AuthUser, period: string) {
    const tenantId = this.tenant(user); const entity = await this.periodRepo.findOne({ where: { tenantId, period } }); if (!entity || entity.status !== 'closed') throw new BadRequestException('该期间尚未结账');
    const later = await this.periodRepo.findOne({ where: { tenantId, status: 'closed' }, order: { period: 'DESC' } });
    if (later && later.period > period) throw new BadRequestException(`请先反结账较晚期间 ${later.period}，不能跨期反结账`);
    entity.status = 'open'; entity.closedAt = null; entity.closedBy = null; entity.updatedBy = user.id; await this.periodRepo.save(entity);
    const set = await this.ensureAccountSet(user); const latest = await this.periodRepo.findOne({ where: { tenantId, status: 'closed' }, order: { period: 'DESC' } }); set.closedThrough = latest?.period || null; set.updatedBy = user.id; await this.setRepo.save(set); return entity;
  }

  private async assertOpen(tenantId: number, period: string) {
    const record = await this.periodRepo.findOne({ where: { tenantId, period } }); if (record?.status === 'closed') throw new BadRequestException(`${period} 已结账，请先反结账再操作`);
  }
}
