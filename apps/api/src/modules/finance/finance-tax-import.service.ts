import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as XLSX from 'xlsx';
import { AuthUser } from '../../common/current-user.decorator';
import { FinanceInvoice, FinanceTaxImportBatch } from './finance.entities';
import { FinanceService } from './finance.service';
import { FinanceVerificationService } from './finance-verification.service';
import { extractInvoiceFieldsFromText, RecognizedInvoiceFields } from './finance-recognition.service';
import { sha256 } from './finance.util';

type Row = Record<string, unknown>;

@Injectable()
export class FinanceTaxImportService {
  constructor(
    @InjectRepository(FinanceInvoice, 'finance') private readonly invoiceRepo: Repository<FinanceInvoice>,
    @InjectRepository(FinanceTaxImportBatch, 'finance') private readonly batchRepo: Repository<FinanceTaxImportBatch>,
    private readonly finance: FinanceService,
    private readonly verification: FinanceVerificationService,
  ) {}

  async listBatches(user: AuthUser) {
    const tenantId = await this.finance.assertAllowed(user);
    return this.batchRepo.find({ where: { tenantId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  async importExport(user: AuthUser, file?: Express.Multer.File) {
    const tenantId = await this.finance.assertAllowed(user);
    if (!file) throw new BadRequestException('请选择税务数字账户导出的 Excel 或 CSV 文件');
    if (!/\.(xlsx?|csv)$/i.test(file.originalname)) throw new BadRequestException('仅支持税务数字账户导出的 XLSX、XLS 或 CSV 文件');
    if (file.size > 30 * 1024 * 1024) throw new BadRequestException('导入文件不能超过 30MB');

    let workbook: XLSX.WorkBook;
    try { workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: false, raw: false }); }
    catch { throw new BadRequestException('文件无法读取，请直接上传税务数字账户导出的原始 Excel 或 CSV'); }

    const rows = workbook.SheetNames.flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      return XLSX.utils.sheet_to_json<Row>(sheet, { defval: '', raw: false }).map((row) => ({ ...row, __sheet: sheetName }));
    }).filter((row) => Object.keys(row).some((key) => key !== '__sheet' && String(row[key] ?? '').trim()));
    if (!rows.length) throw new BadRequestException('文件中没有可导入的数据行');

    const batch = await this.batchRepo.save(this.batchRepo.create({ tenantId, originalName: file.originalname.slice(0, 255), status: 'completed', totalRows: rows.length, importedRows: 0, updatedRows: 0, skippedRows: 0, failedRows: 0, errors: [], createdBy: user.id, updatedBy: user.id }));
    for (let index = 0; index < rows.length; index += 1) {
      try {
        const parsed = parseTaxRow(rows[index]);
        if (!parsed.invoiceNo) throw new Error('缺少发票号码');
        const existing = await this.findExisting(tenantId, parsed);
        const verification = parseVerification(rows[index]);
        if (existing) {
          applyNonEmpty(existing, parsed);
          existing.updatedBy = user.id;
          existing.recognitionStatus = recognitionStatus(parsed);
          existing.recognitionSource = 'tax-account-export';
          existing.recognitionConfidence = '100.00';
          existing.recognitionRaw = { ...(existing.recognitionRaw ?? {}), taxImport: sanitizeRow(rows[index]), batchId: batch.id };
          await this.invoiceRepo.save(existing);
          if (verification) await this.verification.recordImportedResult(tenantId, existing, verification, user.id, sanitizeRow(rows[index]));
          batch.updatedRows += 1;
        } else {
          const identity = sha256(Buffer.from(JSON.stringify({ tenantId, no: parsed.invoiceNo, code: parsed.invoiceCode, date: parsed.invoiceDate, amount: parsed.amount })));
          const invoice = await this.invoiceRepo.save(this.invoiceRepo.create({
            tenantId, source: 'tax_account', originalName: `税务数字账户-${parsed.invoiceNo}`, objectKey: null, sha256: identity, status: 'inbox',
            ...parsed, entryId: null, sourceMessageId: null, matchReason: null, discardReason: null,
            recognitionRaw: { taxImport: sanitizeRow(rows[index]), batchId: batch.id }, recognitionStatus: recognitionStatus(parsed),
            recognitionSource: 'tax-account-export', recognitionConfidence: '100.00', verificationStatus: 'unverified', verifiedAt: null,
            verificationSource: null, verificationMessage: null, createdBy: user.id, updatedBy: user.id,
          }));
          if (verification) await this.verification.recordImportedResult(tenantId, invoice, verification, user.id, sanitizeRow(rows[index]));
          batch.importedRows += 1;
        }
      } catch (error) {
        batch.failedRows += 1;
        batch.errors.push({ row: index + 2, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
    batch.status = batch.failedRows === 0 ? 'completed' : batch.failedRows === batch.totalRows ? 'failed' : 'partial';
    await this.batchRepo.save(batch);
    return batch;
  }

  private async findExisting(tenantId: number, fields: RecognizedInvoiceFields) {
    if (fields.invoiceCode) return this.invoiceRepo.findOne({ where: { tenantId, invoiceCode: fields.invoiceCode, invoiceNo: fields.invoiceNo! } });
    return this.invoiceRepo.findOne({ where: { tenantId, invoiceNo: fields.invoiceNo! } });
  }
}

const FIELD_ALIASES: Record<keyof RecognizedInvoiceFields, string[]> = {
  invoiceCode: ['发票代码', '发票代码（数电票为空）'], invoiceNo: ['发票号码', '数电票号码'], invoiceDate: ['开票日期', '发票日期'],
  amount: ['价税合计', '价税合计（元）', '合计金额'], taxAmount: ['税额', '合计税额', '税额（元）'],
  sellerName: ['销售方名称', '销方名称'], sellerTaxNo: ['销售方纳税人识别号', '销方识别号', '销方税号'],
  buyerName: ['购买方名称', '购方名称'], buyerTaxNo: ['购买方纳税人识别号', '购方识别号', '购方税号'],
};

export function parseTaxRow(row: Row): RecognizedInvoiceFields {
  const values: Record<string, unknown> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) values[field] = firstValue(row, aliases);
  // 复用统一的日期、金额、税号规范化逻辑，避免网页上传和税务导入口径分叉。
  const labelled = Object.entries(values).map(([key, value]) => `${key}:${String(value ?? '')}`).join(' ')
    .replace('invoiceCode:', '发票代码:').replace('invoiceNo:', '发票号码:').replace('invoiceDate:', '开票日期:')
    .replace('amount:', '价税合计:').replace('taxAmount:', '税额合计:').replace('sellerName:', '销售方名称:')
    .replace('sellerTaxNo:', '销售方纳税人识别号:').replace('buyerName:', '购买方名称:').replace('buyerTaxNo:', '购买方纳税人识别号:');
  return extractInvoiceFieldsFromText(labelled);
}

function parseVerification(row: Row) {
  const rawStatus = String(firstValue(row, ['查验结果', '验真结果', '发票状态', '查验状态']) ?? '').trim();
  if (!rawStatus) return null;
  const status = /正常|一致|通过|有效/.test(rawStatus) ? 'verified' as const : /异常|作废|红冲|失控|不一致/.test(rawStatus) ? 'failed' as const : 'exception' as const;
  const checkedAtValue = firstValue(row, ['查验时间', '验真时间', '查询时间']);
  const checkedAt = checkedAtValue && !Number.isNaN(new Date(String(checkedAtValue)).getTime()) ? new Date(String(checkedAtValue)) : new Date();
  return { status, source: 'tax-account-import', checkedAt, message: rawStatus, raw: sanitizeRow(row) };
}

function firstValue(row: Row, aliases: string[]) {
  const entry = Object.entries(row).find(([key, value]) => aliases.some((alias) => normalizeHeader(key) === normalizeHeader(alias)) && String(value ?? '').trim());
  return entry?.[1] ?? null;
}
function normalizeHeader(value: string) { return value.replace(/[\s\r\n（）()]/g, '').toLowerCase(); }
function recognitionStatus(fields: RecognizedInvoiceFields): 'recognized' | 'partial' { return fields.invoiceNo && fields.invoiceDate && fields.amount ? 'recognized' : 'partial'; }
function sanitizeRow(row: Row): Record<string, unknown> { return Object.fromEntries(Object.entries(row).slice(0, 100).map(([key, value]) => [String(key).slice(0, 100), String(value ?? '').slice(0, 1000)])); }
function applyNonEmpty(invoice: FinanceInvoice, fields: RecognizedInvoiceFields) { for (const [key, value] of Object.entries(fields)) if (value !== null && value !== '') (invoice as unknown as Record<string, unknown>)[key] = value; }
