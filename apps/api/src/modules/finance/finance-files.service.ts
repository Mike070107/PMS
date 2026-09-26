import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ObjectStorageService } from '../upload/object-storage.service';
import { FinanceInvoice } from './finance.entities';
import { FinanceRecognitionService } from './finance-recognition.service';
import { FinanceService } from './finance.service';
import { isInvoiceAttachment, sha256 } from './finance.util';

@Injectable()
export class FinanceFilesService {
  constructor(
    @InjectRepository(FinanceInvoice, 'finance') private readonly invoiceRepo: Repository<FinanceInvoice>,
    private readonly finance: FinanceService,
    private readonly storage: ObjectStorageService,
    private readonly recognition: FinanceRecognitionService,
  ) {}

  async uploadAttachment(user: AuthUser, file?: Express.Multer.File) {
    const tenantId = await this.finance.assertAllowed(user);
    if (!file) throw new BadRequestException('请选择要上传的文件');
    if (file.size > 30 * 1024 * 1024) throw new BadRequestException('单个附件不能超过 30MB');
    const stored = await this.storage.putBuffer(file.buffer, file.mimetype || 'application/octet-stream', `finance-attachments/t${tenantId}`, file.originalname);
    return { name: file.originalname, objectKey: stored.objectKey, contentType: file.mimetype, size: file.size };
  }

  async uploadInvoice(user: AuthUser, file?: Express.Multer.File) {
    const tenantId = await this.finance.assertAllowed(user);
    if (!file) throw new BadRequestException('请选择发票文件');
    if (!isInvoiceAttachment(file.originalname, file.mimetype)) throw new BadRequestException('发票支持 PDF、OFD、XML、图片或 ZIP 文件');
    if (file.size > 30 * 1024 * 1024) throw new BadRequestException('单个发票文件不能超过 30MB');
    const hash = sha256(file.buffer);
    const duplicate = await this.invoiceRepo.findOne({ where: { tenantId, sha256: hash } });
    if (duplicate) return { duplicate: true, invoice: duplicate };
    const recognized = await this.recognition.recognize(tenantId, file.originalname, file.mimetype, file.buffer);
    const sameIdentity = recognized.invoiceCode && recognized.invoiceNo
      ? await this.invoiceRepo.findOne({ where: { tenantId, invoiceCode: recognized.invoiceCode, invoiceNo: recognized.invoiceNo } })
      : null;
    const stored = await this.storage.putBuffer(file.buffer, file.mimetype || 'application/octet-stream', `finance-invoices/t${tenantId}`, file.originalname);
    const { status: recognitionStatus, source: recognitionSource, confidence: recognitionConfidence, raw: recognitionRaw, ...fields } = recognized;
    const invoice = await this.invoiceRepo.save(this.invoiceRepo.create({ tenantId, source: 'upload', originalName: file.originalname.slice(0, 255), objectKey: stored.objectKey, sha256: hash, status: sameIdentity ? 'duplicate' : 'inbox', ...fields, entryId: null, sourceMessageId: null, matchReason: sameIdentity ? `与发票 #${sameIdentity.id} 的代码和号码重复` : null, discardReason: null, recognitionRaw, recognitionStatus, recognitionSource, recognitionConfidence, verificationStatus: 'unverified', verifiedAt: null, verificationSource: null, verificationMessage: null, createdBy: user.id, updatedBy: user.id }));
    return { duplicate: Boolean(sameIdentity), invoice };
  }

  async read(user: AuthUser, key: string) {
    const tenantId = await this.finance.assertAllowed(user);
    const normalized = String(key ?? '').replace(/^\/+/, '');
    if (!/^finance-(attachments|invoices)\//.test(normalized)) throw new BadRequestException('无效的财务附件地址');
    const invoice = normalized.startsWith('finance-invoices/')
      ? await this.invoiceRepo.findOne({ where: { tenantId, objectKey: normalized } })
      : normalized.startsWith(`finance-attachments/t${tenantId}/`);
    if (!invoice) throw new NotFoundException('附件不存在');
    return this.storage.getObject(normalized);
  }
}
