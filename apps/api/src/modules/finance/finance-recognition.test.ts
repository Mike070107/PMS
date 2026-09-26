import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { extractInvoiceFieldsFromText, extractOfdText, extractXmlText } from './finance-recognition.service';
import { parseTaxRow } from './finance-tax-import.service';

test('XML 发票提取号码、日期、价税、税额和购销双方', () => {
  const xml = Buffer.from(`<?xml version="1.0"?><Invoice>
    <InvoiceCode>031002100411</InvoiceCode><InvoiceNo>24512000000012345678</InvoiceNo><InvoiceDate>2026-09-20</InvoiceDate>
    <TotalAmount>128.50</TotalAmount><TaxAmount>7.27</TaxAmount>
    <SellerName>上海示例科技有限公司</SellerName><SellerTaxNo>91310000MA1234567X</SellerTaxNo>
    <BuyerName>上海普睿斯物业有限公司</BuyerName><BuyerTaxNo>91310000MA7654321Y</BuyerTaxNo>
  </Invoice>`);
  const fields = extractInvoiceFieldsFromText(extractXmlText(xml));
  assert.equal(fields.invoiceNo, '24512000000012345678');
  assert.equal(fields.invoiceDate, '2026-09-20');
  assert.equal(fields.amount, '128.50');
  assert.equal(fields.taxAmount, '7.27');
  assert.equal(fields.sellerTaxNo, '91310000MA1234567X');
  assert.equal(fields.buyerName, '上海普睿斯物业有限公司');
});

test('OFD 解包后可读取页面文字', async () => {
  const zip = new JSZip();
  zip.file('OFD.xml', '<ofd:OFD xmlns:ofd="x"><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:OFD>');
  zip.file('Doc_0/Pages/Page_0/Content.xml', '<ofd:Page xmlns:ofd="x"><ofd:TextCode>发票号码:24512000000012345678 价税合计:88.00</ofd:TextCode></ofd:Page>');
  const text = await extractOfdText(await zip.generateAsync({ type: 'nodebuffer' }));
  const fields = extractInvoiceFieldsFromText(text);
  assert.equal(fields.invoiceNo, '24512000000012345678');
  assert.equal(fields.amount, '88.00');
});

test('税务数字账户常见中文列名被规范化', () => {
  const fields = parseTaxRow({
    发票号码: '24512000000012345678', 开票日期: '2026年09月21日', '价税合计（元）': '1,280.50',
    销售方名称: '示例供应商有限公司', 销方税号: '91310000MA1234567X', 购买方名称: '普睿斯物业',
  });
  assert.equal(fields.invoiceNo, '24512000000012345678');
  assert.equal(fields.invoiceDate, '2026-09-21');
  assert.equal(fields.amount, '1280.50');
  assert.equal(fields.sellerName, '示例供应商有限公司');
});
