import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { FinanceInvoice, FinanceInvoiceVerification } from './finance.entities';
import { FinanceService } from './finance.service';

export interface InvoiceVerificationRequest {
  invoiceCode: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  amount: string | null;
  sellerTaxNo: string | null;
  buyerTaxNo: string | null;
}

export interface InvoiceVerificationResult {
  status: 'verified' | 'failed' | 'exception';
  source: string;
  checkedAt: Date;
  message?: string | null;
  raw?: Record<string, unknown> | null;
}

/** 后续税务局、乐企或合规第三方都实现这一份契约，不让业务层绑定某家接口。 */
export interface InvoiceVerificationProvider {
  readonly key: string;
  verify(request: InvoiceVerificationRequest): Promise<InvoiceVerificationResult>;
}

@Injectable()
export class FinanceVerificationService {
  private readonly providers = new Map<string, InvoiceVerificationProvider>();

  constructor(
    @InjectRepository(FinanceInvoice, 'finance') private readonly invoiceRepo: Repository<FinanceInvoice>,
    @InjectRepository(FinanceInvoiceVerification, 'finance') private readonly historyRepo: Repository<FinanceInvoiceVerification>,
    private readonly finance: FinanceService,
  ) {}

  registerProvider(provider: InvoiceVerificationProvider) { this.providers.set(provider.key, provider); }

  async history(user: AuthUser, invoiceId: number) {
    const tenantId = await this.finance.assertAllowed(user);
    await this.requireInvoice(tenantId, invoiceId);
    return this.historyRepo.find({ where: { tenantId, invoiceId }, order: { checkedAt: 'DESC', id: 'DESC' } });
  }

  async verify(user: AuthUser, invoiceId: number, providerKey: string) {
    const tenantId = await this.finance.assertAllowed(user);
    const invoice = await this.requireInvoice(tenantId, invoiceId);
    const provider = this.providers.get(providerKey);
    if (!provider) throw new BadRequestException('尚未配置可用的发票验真接口；可先导入税务数字账户查验结果');
    invoice.verificationStatus = 'pending';
    invoice.verificationSource = provider.key;
    invoice.verificationMessage = '正在查验';
    await this.invoiceRepo.save(invoice);
    try {
      const result = await provider.verify(this.snapshot(invoice));
      return this.recordResult(tenantId, invoice, result, user.id, { ...this.snapshot(invoice) });
    } catch (error) {
      return this.recordResult(tenantId, invoice, {
        status: 'exception', source: provider.key, checkedAt: new Date(),
        message: error instanceof Error ? error.message.slice(0, 1000) : '验真接口调用异常',
      }, user.id, { ...this.snapshot(invoice) });
    }
  }

  async recordImportedResult(
    tenantId: number,
    invoice: FinanceInvoice,
    result: InvoiceVerificationResult,
    actorId: number | null,
    raw?: Record<string, unknown> | null,
  ) {
    return this.recordResult(tenantId, invoice, result, actorId, { ...this.snapshot(invoice) }, raw);
  }

  private async recordResult(
    tenantId: number,
    invoice: FinanceInvoice,
    result: InvoiceVerificationResult,
    actorId: number | null,
    requestSnapshot: Record<string, unknown> | null,
    responseSnapshot: Record<string, unknown> | null = result.raw ?? null,
  ) {
    invoice.verificationStatus = result.status;
    invoice.verifiedAt = result.checkedAt;
    invoice.verificationSource = result.source.slice(0, 80);
    invoice.verificationMessage = result.message?.slice(0, 1000) ?? null;
    invoice.updatedBy = actorId;
    const saved = await this.invoiceRepo.save(invoice);
    await this.historyRepo.save(this.historyRepo.create({
      tenantId, invoiceId: invoice.id, status: result.status, source: result.source.slice(0, 80), checkedAt: result.checkedAt,
      message: result.message?.slice(0, 1000) ?? null, requestSnapshot, responseSnapshot,
      createdBy: actorId, updatedBy: actorId,
    }));
    return saved;
  }

  private snapshot(invoice: FinanceInvoice): InvoiceVerificationRequest {
    return { invoiceCode: invoice.invoiceCode, invoiceNo: invoice.invoiceNo, invoiceDate: invoice.invoiceDate, amount: invoice.amount, sellerTaxNo: invoice.sellerTaxNo, buyerTaxNo: invoice.buyerTaxNo };
  }

  private async requireInvoice(tenantId: number, invoiceId: number) {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId, tenantId } });
    if (!invoice) throw new NotFoundException('发票不存在');
    return invoice;
  }
}
