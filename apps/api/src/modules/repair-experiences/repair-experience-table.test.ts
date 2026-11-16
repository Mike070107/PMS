import assert from 'node:assert/strict';
import test from 'node:test';
import { RepairExperiencesService } from './repair-experiences.service';
import { EXPERIENCE_DOCUMENT_LIMITS } from './repair-experience-document-html';

test('API与共享前端的经验表格安全上限完全一致', () => {
  // Runtime require avoids pulling a workspace sibling into the API production rootDir.
  const shared = require('../../../../../packages/shared-types/src/repair-experience');
  assert.deepEqual(EXPERIENCE_DOCUMENT_LIMITS, shared.REPAIR_EXPERIENCE_TABLE_LIMITS);
});

const service: any = Object.create(RepairExperiencesService.prototype);
const clean = (html: string) => service.cleanDocumentHtml(html);
const table = (rows = 1, columns = 1) => `<table><tbody>${Array.from({ length: rows }, () => `<tr>${'<td>x</td>'.repeat(columns)}</tr>`).join('')}</tbody></table>`;
const document = (html: string, id = 'table') => ({ id, type: 'document', html });

test('TipTap表格结构、合法合并单元格和安全富文原样保留', () => {
  const html = '<table><thead><tr><th colspan="2"><p>电压</p></th></tr></thead><tbody><tr><td rowspan="2"><p><strong>220V</strong></p></td><td><p>绝缘</p></td></tr><tr><td><em>合格</em></td></tr></tbody><tfoot><tr><td colspan="2">已复核</td></tr></tfoot></table>';
  assert.equal(clean(html), html);
});

test('表格属性零信任：移除脚本、事件、CSS、列宽，非法span退为1而不扩大网格', () => {
  const html = clean('<table style="width:999999px" onclick="alert(1)"><colgroup><col width="999999"></colgroup><tbody><tr><th colspan="999999999999" rowspan="0" style="background:url(javascript:x)" colwidth="100" data-colwidth="100" onmouseover="x()">设备</th><td colspan="2.5" rowspan="-1"><script>alert(1)</script><a href="javascript:x" onclick="x()">检查</a><img src="javascript:x" onerror="x()"></td></tr></tbody></table>');
  assert.match(html, /<table><tbody><tr><th>设备<\/th><td>/);
  assert.doesNotMatch(html, /script|onclick|onmouseover|onerror|style=|colwidth|<col\b|colspan|rowspan|javascript:/i);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('span仅接受1..20的十进制整数，上限20保留且展开列不会超过20', () => {
  assert.match(clean('<table><tr><td colspan="20">全部</td></tr></table>'), /colspan="20"/);
  assert.match(clean('<table><tr><td rowspan="20">纵向</td><td>x</td></tr>' + '<tr><td>x</td></tr>'.repeat(19) + '</table>'), /rowspan="20"/);
  for (const value of ['21', '0', '-1', '1.5', '1e1', '+2', 'Infinity', '0002', ' 2 ']) {
    assert.doesNotMatch(clean(`<table><tr><td colspan="${value}" rowspan="${value}">x</td></tr></table>`), /(?:colspan|rowspan)=/);
  }
});

test('空表格仍是可保存的结构化正文，不回退成空文档', () => {
  const html = '<table><tbody><tr><td><p></p></td></tr></tbody></table>';
  assert.equal(service.cleanBlocks([document(html)])[0].html, html);
  assert.throws(() => service.cleanBlocks([document('<p></p>')]), /正文还是空/);
});

test('服务端正文提取以空格隔开各单元格，搜索和摘要不粘连', () => {
  assert.equal(service.documentText('<table><tr><td>设备</td><td>型号</td></tr><tr><td>水泵</td><td>Q20</td></tr></table>'), '设备 型号 水泵 Q20');
});

test('每表边界100行20展开列可保存，101行或21列明确拒绝', () => {
  assert.equal(clean(table(100, 20)), table(100, 20));
  assert.throws(() => clean(table(101)), /100行/);
  assert.throws(() => clean(table(1, 21)), /20列/);
  assert.throws(() => clean('<table><tr><td colspan="20">x</td><td>x</td></tr></table>'), /20列/);
});

test('rowspan必须计入后续行占用，合并越行、重叠与嵌套表格拒绝', () => {
  assert.throws(() => clean('<table><tr><td rowspan="2">x</td></tr></table>'), /超出实际行/);
  assert.throws(() => clean('<table><tr><td>x</td><td rowspan="2">x</td></tr><tr><td colspan="2">x</td></tr></table>'), /重叠/);
  assert.throws(() => clean('<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>'), /嵌套/);
  assert.throws(() => clean('<td>无表格</td>'), /结构/);
  assert.throws(() => clean('<table><p>无行</p></table>'), /结构/);
});

test('整篇所有document块共享10表、2000展开格预算，不能分块绕过', () => {
  assert.equal(service.cleanBlocks(Array.from({ length: 10 }, (_, i) => document(table(), String(i)))).length, 10);
  assert.throws(() => service.cleanBlocks(Array.from({ length: 11 }, (_, i) => document(table(), String(i)))), /10张表/);
  assert.throws(() => service.cleanBlocks([document(table(100, 20)), document(table(), 'more')]), /2000/);
  const mergedTable = '<table><tr><td rowspan="20" colspan="20">x</td></tr>' + '<tr></tr>'.repeat(19) + '</table>';
  assert.equal(service.cleanBlocks(Array.from({ length: 5 }, (_, i) => document(mergedTable, String(i)))).length, 5);
  assert.throws(() => service.cleanBlocks(Array.from({ length: 6 }, (_, i) => document(mergedTable, String(i)))), /2000/);
  assert.throws(() => clean('<table><tr><td colspan="20" rowspan="20">x</td></tr><tr><td colspan="20">overflow</td></tr></table>'), /20列/);
});

test('整篇HTML字符、节点与深度都有界，过大拒绝而不是静默截断', () => {
  assert.throws(() => clean('<p>' + 'x'.repeat(120000) + '</p>'), /120000/);
  assert.throws(() => service.cleanBlocks([document('<p>' + 'x'.repeat(61000) + '</p>'), document('<p>' + 'x'.repeat(61000) + '</p>', 'more')]), /120000/);
  assert.throws(() => clean('<strong>x</strong>'.repeat(5001)), /5000/);
  assert.throws(() => clean('<div>'.repeat(51) + 'x' + '</div>'.repeat(51)), /50层/);
});
