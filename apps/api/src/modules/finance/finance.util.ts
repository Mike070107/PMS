import { createHash } from 'crypto';

export const ALLOWED_INVOICE_EXTENSIONS = ['.pdf', '.ofd', '.xml', '.jpg', '.jpeg', '.png', '.webp', '.zip'];

export function isInvoiceAttachment(filename: string, contentType = ''): boolean {
  const lower = filename.toLowerCase();
  return ALLOWED_INVOICE_EXTENSIONS.some((ext) => lower.endsWith(ext)) || /pdf|xml|image\//i.test(contentType);
}

export function isPdfAttachment(filename: string, contentType = ''): boolean {
  return filename.toLowerCase().endsWith('.pdf') || /^application\/pdf(?:\s*;|$)/i.test(contentType);
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function extractInvoiceHints(filename: string, content?: Buffer) {
  const text = content && /\.xml$/i.test(filename) ? content.toString('utf8').slice(0, 2_000_000) : filename;
  const amount = text.match(/(?:价税合计|TotalAmount|Amount|金额)[^\d]{0,30}(\d{1,10}(?:\.\d{1,2})?)/i)?.[1]
    ?? filename.match(/(?:￥|¥|RMB|CNY)[ _-]?(\d{1,10}(?:\.\d{1,2})?)/i)?.[1]
    ?? null;
  const invoiceNo = text.match(/(?:InvoiceNo|发票号码|票据号码)[^0-9A-Za-z]{0,20}([0-9A-Za-z]{8,30})/i)?.[1] ?? null;
  const invoiceCode = text.match(/(?:InvoiceCode|发票代码)[^0-9A-Za-z]{0,20}([0-9A-Za-z]{8,30})/i)?.[1] ?? null;
  const dateRaw = text.match(/(?:InvoiceDate|开票日期)[^0-9]{0,20}(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/i);
  return {
    amount: amount ? Number(amount).toFixed(2) : null,
    invoiceNo,
    invoiceCode,
    invoiceDate: dateRaw ? `${dateRaw[1]}-${dateRaw[2].padStart(2, '0')}-${dateRaw[3].padStart(2, '0')}` : null,
  };
}

export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain ?? ''}`;
}
