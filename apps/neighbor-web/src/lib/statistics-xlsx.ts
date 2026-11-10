/** Current-result DOM export only. No report queries, React state, or catalogue traversal.
 * OOXML is written directly because the legacy SheetJS community writer drops styles.
 * Hidden responsive desktop tables intentionally remain exportable; cards are never read.
 */
export interface StatisticsXlsxMetadata {
  title: string;
  subtitle?: string;
  dataAsOf?: string | null;
  note?: string;
}

type Kind = 'text' | 'number' | 'currency' | 'percent' | 'area';
type Value = { value: string | number; kind: Kind };
type Cell = { row: number; col: number; rows: number; cols: number; element: HTMLTableCellElement; text: string; header: boolean };
type Table = { cells: Cell[]; layout: Array<Array<Cell | undefined>>; rows: HTMLTableRowElement[]; width: number; headers: number; labels: string[]; keep: number[] };
type Line = { cells: string[]; height: number };
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IGNORE = '[data-xlsx-ignore],script,style,svg,img,input,select,textarea,[role="img"],.icon,.anticon';

function xml(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** textContent alone leaks sort icons, UI controls, and inaccessible duplicate labels. */
function text(node: Node): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  if (el.matches(IGNORE) || el.getAttribute('aria-hidden') === 'true') return '';
  if (el.tagName === 'BR') return ' ';
  const content = Array.from(el.childNodes).map(text).join('');
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
    // Money drilldowns (and identifier drilldowns styled as cell links) are report data.
    if (!el.matches('.stats-money-btn,.stats-cell-link,[data-xlsx-value]') && !/^[\s¥￥+−\-\d,.()%㎡元]+$/.test(content)) return '';
    return content.replace(/\s*[·•]\s*(?:明细|查看详情)\s*$/, '');
  }
  return content;
}
const cleanText = (el: Node) => text(el).replace(/\s+/g, ' ').trim();
const columnName = (index: number): string => {
  let result = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
};
const ref = (row: number, col: number) => `${columnName(col)}${row + 1}`;

function readTable(element: HTMLTableElement): Table {
  const rows = Array.from(element.rows).filter(row => row.closest('table') === element && !row.closest('[data-xlsx-ignore]'));
  const cells: Cell[] = [];
  const layout: Array<Array<Cell | undefined>> = [];
  let width = 0;
  let headers = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const header = row.parentElement?.tagName === 'THEAD' || (r === headers && Array.from(row.cells).every(cell => cell.tagName === 'TH'));
    if (header && r === headers) headers++;
    let col = 0;
    for (const element of Array.from(row.cells)) {
      while (layout[r]?.[col]) col++;
      // rowspan=0 means the remainder of its row group, not just this row.
      const remaining = rows.slice(r).findIndex(next => next.parentElement !== row.parentElement);
      const groupRows = remaining < 0 ? rows.length - r : remaining;
      const rowSpan = Math.min(element.rowSpan === 0 ? groupRows : Math.max(1, element.rowSpan), rows.length - r);
      const colSpan = Math.max(1, element.colSpan);
      const cell = { row: r, col, rows: rowSpan, cols: colSpan, element, text: cleanText(element), header };
      cells.push(cell);
      for (let y = r; y < r + rowSpan; y++) {
        layout[y] ??= [];
        for (let x = col; x < col + colSpan; x++) layout[y][x] = cell;
      }
      col += colSpan;
      width = Math.max(width, col);
    }
  }
  const labels = Array.from({ length: width }, (_, col) => cells.filter(c => c.header && c.col <= col && col < c.col + c.cols).map(c => c.text).join(' '));
  // UI action columns do not belong in the workbook. Preserve layout of all data merges.
  const keep = labels.map((_, col) => col).filter(col => {
    const leaf = cells.filter(c => c.header && c.col <= col && col < c.col + c.cols).slice(-1)[0]?.text || '';
    return !/^(?:操作|查看|详情|明细|操作\/查看)$/.test(leaf);
  });
  return { cells, layout, rows, width, headers, labels, keep };
}

function valueOf(cell: Cell, label: string): Value {
  const original = cell.text;
  const forced = cell.element.getAttribute('data-xlsx-type');
  const plain: Value = { value: original, kind: 'text' };
  if (cell.header || forced === 'text' || !original || /^[—–-]+$/.test(original)) return plain;
  // Identifiers, phone numbers, dates, and period labels stay exact, including leading zeroes.
  if (!forced && /编号|编码|代码|房号|楼号|弄\/号|手机|电话|文号|发票号|日期|年月|年度|期间|地址|姓名|业主|住户|管理处|收费项目|收款人|付款人|经办人|标题|备注|说明|性质|状态|方式/.test(label)) return plain;
  const compact = original.replace(/\s/g, '').replace(/−/g, '-');
  const percent = /%$/.test(compact) || forced === 'percent';
  const area = /㎡|m²|平方米/i.test(compact) || /面积/.test(label) || forced === 'area';
  const count = /数量|户数|楼栋数|房屋数|业主数|张数|行数|笔数|月份数|次数|序号/.test(label);
  const currency = /[¥￥]|元$/.test(compact) || (!count && /金额|税额|收入|收款|退款|调整|净额|应收|已收|实收|欠收|欠费|溢收|预缴|预收/.test(label)) || forced === 'currency';
  // Never reinterpret arbitrary formula-like text, even in numeric columns.
  if (/^[=@+]/.test(compact)) return plain;
  let numeric = compact.replace(/[¥￥]/g, '').replace(/(?:元|㎡|m²|平方米|%)$/i, '');
  if (/^\(.+\)$/.test(numeric)) numeric = '-' + numeric.slice(1, -1);
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(numeric)) return plain;
  const digits = numeric.replace(/^-/, '').replace(/,/g, '');
  if (/^0\d/.test(digits) || digits.replace(/\D/g, '').length > 15) return plain;
  const semanticNumber = forced === 'number' || count || cell.element.classList.contains('num');
  if (!percent && !area && !currency && !semanticNumber) return plain;
  const value = Number(numeric.replace(/,/g, '')) / (percent ? 100 : 1);
  if (!Number.isFinite(value)) return plain;
  return { value, kind: percent ? 'percent' : area ? 'area' : currency ? 'currency' : 'number' };
}

// 0 title, 1 subtitle, 2 watermark/note, 3 section, 4 blue header, 5 teal subheader.
// Then four row bands (normal, alternate, totals, alternate bold) × five value kinds.
const KINDS: Kind[] = ['text', 'number', 'currency', 'percent', 'area'];
function stylesXml(): string {
  const xfs = [
    '<xf fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>',
    '<xf fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    '<xf fontId="3" fillId="4" borderId="1" xfId="0" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>',
    ...[2, 3].map(fill => `<xf fontId="4" fillId="${fill}" borderId="1" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`),
  ];
  for (let band = 0; band < 4; band++) for (const kind of KINDS) {
    const format = { text: 49, number: 3, currency: 164, percent: 165, area: 166 }[kind];
    xfs.push(`<xf numFmtId="${format}" fontId="${band >= 2 ? 3 : 0}" fillId="${band === 2 ? 5 : band === 1 || band === 3 ? 4 : 0}" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyAlignment="1"><alignment horizontal="${kind === 'text' ? 'left' : 'right'}" vertical="center" wrapText="1"/></xf>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><numFmts count="3"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00;[Red]-&quot;¥&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="#,##0.00&quot; ㎡&quot;"/></numFmts><fonts count="5"><font><sz val="11"/><color rgb="FF1E293B"/><name val="Microsoft YaHei"/></font><font><b/><sz val="20"/><color rgb="FF164E63"/><name val="Microsoft YaHei"/></font><font><sz val="10"/><color rgb="FF64748B"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FF134E4A"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${['164E63', '0F766E', 'F0F9FA', 'CCFBF1'].map(color => `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${['left', 'right', 'top', 'bottom'].map(side => `<${side} style="thin"><color rgb="FFD8E5EA"/></${side}>`).join('')}<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

function cellXml(row: number, col: number, value: Value, style: number): string {
  const attrs = `r="${ref(row, col)}" s="${style}"`;
  return typeof value.value === 'number'
    ? `<c ${attrs}><v>${value.value}</v></c>`
    : `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${xml(value.value)}</t></is></c>`;
}

/** Pure serializer: snapshots only the supplied DOM, with no download or browser side effects. */
export function serializeStatisticsXlsx(root: HTMLElement, metadata: StatisticsXlsxMetadata): Uint8Array {
  const blocks: Array<{ title: string } | { table: Table }> = [];
  function walk(el: Element): void {
    if (el.matches('[data-xlsx-ignore],script,style,.stats-annual-cards,.stats-mobile-cards')) return;
    if (el.tagName === 'TABLE') {
      const table = readTable(el as HTMLTableElement);
      if (table.rows.length && table.keep.length) {
        const caption = (el as HTMLTableElement).caption;
        if (caption && cleanText(caption)) blocks.push({ title: cleanText(caption) });
        blocks.push({ table });
      }
      return; // never traverse duplicate cards or nested table data as another report
    }
    if (el.matches('h1,h2,h3,h4,h5,h6,[data-xlsx-section],.panelHd')) {
      const title = el.matches('.panelHd')
        ? Array.from(el.children).map(child => cleanText(child)).filter(Boolean).join(' · ') || cleanText(el)
        : cleanText(el);
      if (title && title !== metadata.title) blocks.push({ title });
      return;
    }
    for (const child of Array.from(el.children)) walk(child);
  }
  walk(root);
  const tables = blocks.filter((block): block is { table: Table } => 'table' in block);
  if (!tables.length) throw new Error('当前结果没有可导出的表格');
  const width = Math.max(2, ...tables.map(block => block.table.keep.length));
  if (width > 16384) throw new Error('当前结果超出 Excel 列数限制');
  const lines: Line[] = [];
  const merges: string[] = [];
  const widths = Array.from({ length: width }, () => 12);
  const fullLine = (value: string, style: number, height: number) => {
    const row = lines.length;
    const units = Array.from(value).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
    const wrappedLines = Math.max(1, Math.ceil(units / Math.max(24, width * 12 - 4)));
    lines.push({ cells: [cellXml(row, 0, { value, kind: 'text' }, style)], height: Math.max(height, Math.min(240, wrappedLines * 15 + 8)) });
    if (width > 1) merges.push(`${ref(row, 0)}:${ref(row, width - 1)}`);
  };
  fullLine(metadata.title || '统计汇总', 0, 34);
  if (metadata.subtitle) for (const line of metadata.subtitle.split('\n').filter(Boolean)) fullLine(line, 1, 28);
  fullLine(`数据截至：${metadata.dataAsOf || '未提供'} · 当前报表结果 · 金额单位：元`, 2, 26);
  if (metadata.note) fullLine(metadata.note, 2, 32);
  lines.push({ cells: [], height: 10 });
  let freeze = 0;
  for (const block of blocks) {
    if ('title' in block) { fullLine(block.title, 3, 28); continue; }
    const table = block.table;
    const offset = lines.length;
    const grid = table.rows.map(() => Array.from({ length: table.keep.length }, () => ''));
    let bodyIndex = 0;
    for (let r = 0; r < table.rows.length; r++) {
      const row = table.rows[r];
      const first = table.layout[r]?.find(cell => cell?.row === r)?.text || '';
      const total = /(?:^|\s)(?:stats-)?(?:sub)?total(?:-row)?(?:\s|$)/.test(row.className)
        || row.parentElement?.tagName === 'TFOOT' || /^(?:合计|小计|总计|独立去重合计)(?:\s|$)/.test(first);
      const band = total ? 2 : bodyIndex % 2;
      if (r >= table.headers) bodyIndex++;
      for (let c = 0; c < table.keep.length; c++) {
        const originalCol = table.keep[c];
        const cell = table.layout[r]?.[originalCol];
        const isOrigin = cell && cell.row === r && table.keep.filter(col => col >= cell.col && col < cell.col + cell.cols)[0] === originalCol;
        const value = cell && isOrigin ? valueOf(cell, table.labels[originalCol]) : { value: '', kind: 'text' as Kind };
        const bold = cell?.element.querySelector('b,strong') != null;
        const style = r < table.headers ? (r === 0 ? 4 : 5) : 6 + (total ? 2 : bold && band === 1 ? 3 : band) * KINDS.length + KINDS.indexOf(value.kind);
        grid[r][c] = cellXml(offset + r, c, value, style);
        if (cell && isOrigin) {
          const span = table.keep.filter(col => col >= cell.col && col < cell.col + cell.cols).length;
          if (span > 1 || cell.rows > 1) merges.push(`${ref(offset + r, c)}:${ref(offset + r + cell.rows - 1, c + span - 1)}`);
          if (span === 1) {
            const length = Array.from(cell.text).reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
            widths[c] = Math.min(42, Math.max(widths[c], length + 3));
          }
        }
      }
      lines.push({ cells: grid[r], height: r < table.headers ? 30 : 26 });
    }
    if (!freeze) freeze = offset + table.headers;
    lines.push({ cells: [], height: 12 });
  }
  if (lines.length > 1048576) throw new Error('当前结果超出 Excel 行数限制');
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><dimension ref="A1:${ref(lines.length - 1, width - 1)}"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="${freeze}" topLeftCell="B${freeze + 1}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="B${freeze + 1}" sqref="B${freeze + 1}"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="26"/><cols>${widths.map((w, col) => `<col min="${col + 1}" max="${col + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${lines.map((line, row) => `<row r="${row + 1}" ht="${line.height}" customHeight="1">${line.cells.join('')}</row>`).join('')}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.map(range => `<mergeCell ref="${range}"/>`).join('')}</mergeCells>` : ''}<printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape"/><headerFooter><oddFooter>${xml('&L当前报表结果&R第 &P 页 / 共 &N 页')}</oddFooter></headerFooter></worksheet>`;
  const name = (metadata.title || '统计汇总').replace(/[:\\/?*\[\]]/g, ' ').replace(/^'+|'+$/g, '').slice(0, 31) || '统计汇总';
  return zipStore({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml': stylesXml(),
    'xl/worksheets/sheet1.xml': worksheet,
  });
}

/** ZIP method 0 + CRC32, UTF-8 paths. No compression library or vendor-specific styles. */
function zipStore(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const data = encoder.encode(content);
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true); view.setUint32(14, crc, true); view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true); view.setUint16(26, name.length, true); local.set(name, 30);
    parts.push(local, data);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
    cv.setUint16(14, 33, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    directory.push(central); offset += local.length + data.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, directory.length, true); ev.setUint16(10, directory.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  const result = new Uint8Array(offset + size + end.length);
  let position = 0;
  for (const part of [...parts, ...directory, end]) { result.set(part, position); position += part.length; }
  return result;
}

/** Exactly one workbook, object URL and anchor click per invocation. */
export async function downloadStatisticsXlsx(root: HTMLElement, metadata: StatisticsXlsxMetadata): Promise<void> {
  const bytes = serializeStatisticsXlsx(root, metadata);
  const doc = root.ownerDocument;
  const urlApi = doc.defaultView?.URL || URL;
  const url = urlApi.createObjectURL(new Blob([bytes], { type: MIME }));
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = `${(metadata.title || '统计汇总').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.xlsx$/i, '')}.xlsx`;
  anchor.style.display = 'none';
  try {
    doc.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Browsers may consume the blob after click returns; do not revoke synchronously.
    setTimeout(() => urlApi.revokeObjectURL(url), 1000);
  }
}
