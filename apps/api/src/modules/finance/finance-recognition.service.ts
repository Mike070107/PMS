import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import { LlmService } from '../ai/llm.service';

export interface RecognizedInvoiceFields {
  invoiceCode: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  amount: string | null;
  taxAmount: string | null;
  sellerName: string | null;
  sellerTaxNo: string | null;
  buyerName: string | null;
  buyerTaxNo: string | null;
}

export interface InvoiceRecognitionResult extends RecognizedInvoiceFields {
  status: 'recognized' | 'partial' | 'failed';
  source: 'xml' | 'ofd-xml' | 'pdf-text' | 'pdf-vision' | 'image-vision' | 'filename';
  confidence: string;
  raw: Record<string, unknown>;
}

const EMPTY_FIELDS: RecognizedInvoiceFields = {
  invoiceCode: null, invoiceNo: null, invoiceDate: null, amount: null, taxAmount: null,
  sellerName: null, sellerTaxNo: null, buyerName: null, buyerTaxNo: null,
};

@Injectable()
export class FinanceRecognitionService {
  private readonly logger = new Logger(FinanceRecognitionService.name);

  constructor(private readonly llm: LlmService) {}

  async recognize(tenantId: number, filename: string, contentType: string, buffer: Buffer): Promise<InvoiceRecognitionResult> {
    const lower = filename.toLowerCase();
    try {
      if (lower.endsWith('.xml') || /xml/i.test(contentType)) {
        return resultFromText(extractXmlText(buffer), 'xml');
      }
      if (lower.endsWith('.ofd')) {
        const text = await extractOfdText(buffer);
        return resultFromText(text, 'ofd-xml');
      }
      if (lower.endsWith('.pdf') || /pdf/i.test(contentType)) {
        return await this.recognizePdf(tenantId, filename, buffer);
      }
      if (/\.(jpe?g|png|webp|bmp)$/i.test(lower) || /^image\//i.test(contentType)) {
        return await this.recognizeImage(tenantId, filename, contentType || imageType(filename), buffer, 'image-vision');
      }
    } catch (error) {
      this.logger.warn(`发票识别失败（${filename}）：${error instanceof Error ? error.message : String(error)}`);
    }
    return resultFromText(filename, 'filename');
  }

  private async recognizePdf(tenantId: number, filename: string, buffer: Buffer): Promise<InvoiceRecognitionResult> {
    const parser = new PDFParse({ data: buffer });
    try {
      const text = (await parser.getText()).text.slice(0, 500_000);
      const textResult = resultFromText(text, 'pdf-text');
      if (textResult.invoiceNo && textResult.amount) return textResult;

      // 扫描版 PDF 没有文字层时只渲染第一页，交给现有租户视觉模型识别。
      const screenshots = await parser.getScreenshot({ first: 1, desiredWidth: 1800, imageBuffer: true });
      const first = screenshots.pages[0];
      if (first?.data) {
        const vision = await this.recognizeImage(tenantId, filename, 'image/png', Buffer.from(first.data), 'pdf-vision');
        if (vision.status !== 'failed') return vision;
      }
      return textResult;
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }

  private async recognizeImage(
    tenantId: number,
    filename: string,
    contentType: string,
    buffer: Buffer,
    source: 'pdf-vision' | 'image-vision',
  ): Promise<InvoiceRecognitionResult> {
    const parsed = await this.llm.askImageJson<Record<string, unknown>>(
      tenantId,
      '你是中国发票字段识别器。只输出 JSON，不推测看不清的字段；金额均为数字字符串。',
      '识别这张发票，返回 invoiceCode、invoiceNo、invoiceDate(YYYY-MM-DD)、amount(价税合计)、taxAmount、sellerName、sellerTaxNo、buyerName、buyerTaxNo、confidence(0-100)。',
      { contentType, buffer },
      { kind: 'finance_invoice_ocr' },
    );
    if (!parsed) return { ...EMPTY_FIELDS, status: 'failed', source, confidence: '0.00', raw: { filename, reason: '视觉识别服务未配置、模型不支持图片或调用失败' } };
    const fields = normalizeFields(parsed);
    return buildResult(fields, source, Number(parsed.confidence ?? 70), { provider: 'tenant_ai', response: parsed });
  }
}

export function extractXmlText(buffer: Buffer): string {
  const raw = decodeXml(buffer).slice(0, 2_000_000);
  // 先实际解析，拒绝畸形 XML；再保留标签名与值，便于兼容各地不同数电票 schema。
  new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(raw);
  return xmlToLabelledText(raw);
}

export async function extractOfdText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const xmlFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith('.xml')).slice(0, 200);
  if (!xmlFiles.length) throw new Error('OFD 中没有找到 XML 内容');
  const parts: string[] = [];
  for (const entry of xmlFiles) {
    const xml = await entry.async('string');
    parts.push(xmlToLabelledText(xml));
  }
  return parts.join('\n').slice(0, 2_000_000);
}

function decodeXml(buffer: Buffer): string {
  const head = buffer.subarray(0, 200).toString('ascii');
  if (/encoding=["'](?:gbk|gb2312|gb18030)["']/i.test(head)) {
    // TextDecoder 支持 gb18030，并覆盖常见国标编码。
    return new TextDecoder('gb18030').decode(buffer);
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

export function extractInvoiceFieldsFromText(input: string): RecognizedInvoiceFields {
  const text = String(input ?? '').replace(/\u3000/g, ' ').replace(/[：﹕]/g, ':').replace(/\s+/g, ' ');
  const pick = (labels: string[], pattern: string) => {
    const label = labels.map(escapeRegex).join('|');
    return text.match(new RegExp(`(?:${label})\\s*[:：]?\\s*(${pattern})`, 'i'))?.[1]?.trim() ?? null;
  };
  const invoiceNo = cleanId(pick(['发票号码', '数电票号码', '票据号码', 'InvoiceNo', 'InvoiceNumber', 'Fphm'], '[0-9A-Za-z]{8,30}'));
  const invoiceCode = cleanId(pick(['发票代码', 'InvoiceCode', 'Fpdm'], '[0-9A-Za-z]{8,30}'));
  const date = pick(['开票日期', 'InvoiceDate', 'Kprq'], '20\\d{2}(?:[-/.年]?\\d{1,2})(?:[-/.月]?\\d{1,2})日?');
  const amount = money(pick(['价税合计(?:\\(小写\\))?', '价税合计', 'TotalAmount', 'AmountWithTax', 'Jshj'], '[¥￥]?\\s*-?[0-9,]+(?:\\.\\d{1,2})?'));
  const taxAmount = money(pick(['税额合计', '合计税额', 'TotalTax', 'TaxAmount', 'Hjse'], '[¥￥]?\\s*-?[0-9,]+(?:\\.\\d{1,2})?'));
  return {
    invoiceCode,
    invoiceNo,
    invoiceDate: normalizeDate(date),
    amount,
    taxAmount,
    sellerName: cleanName(pick(['销售方名称', '销方名称', 'SellerName', 'XsfMc', 'Xfmc'], '.{2,100}?(?= (?:销售方纳税人识别号|销方纳税人识别号|SellerTaxNo|XsfNsrsbh|Xfsbh|纳税人识别号|统一社会信用代码|税号|购买方|买方|$))')),
    sellerTaxNo: cleanTaxNo(pick(['销售方纳税人识别号', '销方纳税人识别号', 'SellerTaxNo', 'XsfNsrsbh', 'Xfsbh'], '[0-9A-Z]{15,20}')),
    buyerName: cleanName(pick(['购买方名称', '购方名称', 'BuyerName', 'GmfMc', 'Gfmc'], '.{2,100}?(?= (?:购买方纳税人识别号|购方纳税人识别号|BuyerTaxNo|GmfNsrsbh|Gfsbh|纳税人识别号|统一社会信用代码|税号|销售方|卖方|$))')),
    buyerTaxNo: cleanTaxNo(pick(['购买方纳税人识别号', '购方纳税人识别号', 'BuyerTaxNo', 'GmfNsrsbh', 'Gfsbh'], '[0-9A-Z]{15,20}')),
  };
}

function resultFromText(text: string, source: InvoiceRecognitionResult['source']): InvoiceRecognitionResult {
  const fields = extractInvoiceFieldsFromText(text);
  const confidence = source === 'xml' ? 96 : source === 'ofd-xml' ? 92 : source === 'pdf-text' ? 86 : 35;
  return buildResult(fields, source, confidence, { textSample: text.slice(0, 4000) });
}

function buildResult(fields: RecognizedInvoiceFields, source: InvoiceRecognitionResult['source'], confidence: number, raw: Record<string, unknown>): InvoiceRecognitionResult {
  const core = [fields.invoiceNo, fields.invoiceDate, fields.amount].filter(Boolean).length;
  return { ...fields, status: core === 3 ? 'recognized' : core > 0 ? 'partial' : 'failed', source, confidence: Math.max(0, Math.min(100, confidence)).toFixed(2), raw };
}

function normalizeFields(value: Record<string, unknown>): RecognizedInvoiceFields {
  return {
    invoiceCode: cleanId(value.invoiceCode), invoiceNo: cleanId(value.invoiceNo), invoiceDate: normalizeDate(value.invoiceDate),
    amount: money(value.amount), taxAmount: money(value.taxAmount), sellerName: cleanName(value.sellerName), sellerTaxNo: cleanTaxNo(value.sellerTaxNo),
    buyerName: cleanName(value.buyerName), buyerTaxNo: cleanTaxNo(value.buyerTaxNo),
  };
}

function money(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).replace(/[¥￥,\s]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

function normalizeDate(value: unknown): string | null {
  const match = String(value ?? '').match(/(20\d{2})\D?(\d{1,2})\D?(\d{1,2})/);
  if (!match) return null;
  const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cleanId(value: unknown): string | null { const result = String(value ?? '').trim().replace(/\s/g, ''); return /^[0-9A-Za-z]{8,30}$/.test(result) ? result : null; }
function cleanTaxNo(value: unknown): string | null { const result = String(value ?? '').toUpperCase().replace(/\s/g, ''); return /^[0-9A-Z]{15,20}$/.test(result) ? result : null; }
function cleanName(value: unknown): string | null { const result = String(value ?? '').trim().replace(/[|<>{}]/g, '').slice(0, 200); return result.length >= 2 ? result : null; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function imageType(filename: string): string { if (/\.png$/i.test(filename)) return 'image/png'; if (/\.webp$/i.test(filename)) return 'image/webp'; return 'image/jpeg'; }
function xmlToLabelledText(xml: string): string {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<([\w:-]+)(?:\s[^>]*)?>\s*(?=[^<])/g, (_all, tag: string) => `${tag.split(':').pop()}:`)
    .replace(/<[^>]+>/g, ' ');
}
