import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

// Keep in sync with the experience-only shared contract; the API does not import shared-types.
export const EXPERIENCE_DOCUMENT_LIMITS = {
  maxTables: 10, maxRows: 100, maxColumns: 20, maxSpan: 20,
  maxExpandedCells: 2000, maxNodes: 5000, maxDepth: 50, maxHtmlLength: 120000,
} as const;

export function experienceDocumentBudget() {
  return { htmlLength: 0, nodes: 0, tables: 0, expandedCells: 0 };
}
type DocumentBudget = ReturnType<typeof experienceDocumentBudget>;

function safeCellAttributes(attributes: Record<string, string>) {
  const result: Record<string, string> = {};
  for (const key of ['rowspan', 'colspan']) {
    const value = attributes[key];
    const number = Number(value);
    // No 0 (HTML's unlimited-row special case), exponents, whitespace or huge integers.
    if (Number.isInteger(number) && number >= 1 && number <= EXPERIENCE_DOCUMENT_LIMITS.maxSpan && String(number) === value) {
      result[key] = value;
    }
  }
  return result;
}

/** Sanitize first, then validate only the exact retained structure with the HTML parser. */
export function cleanExperienceDocumentHtml(value: string, budget = experienceDocumentBudget()): string {
  budget.htmlLength += value.length;
  if (budget.htmlLength > EXPERIENCE_DOCUMENT_LIMITS.maxHtmlLength) throw new BadRequestException('文档HTML总长度不能超过120000字符');
  let depth = 0;
  const html = sanitizeHtml(value, {
    allowedTags: ['p', 'br', 'h2', 'h3', 'strong', 'em', 's', 'code', 'pre', 'blockquote', 'aside', 'ul', 'ol', 'li', 'label', 'input', 'div', 'hr', 'figure', 'figcaption', 'img', 'a', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'], img: ['src', 'alt', 'title'],
      input: ['type', 'checked', 'disabled'], ul: ['data-type'], li: ['data-type', 'data-checked'],
      th: ['rowspan', 'colspan'], td: ['rowspan', 'colspan'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      input: sanitizeHtml.simpleTransform('input', { type: 'checkbox', disabled: 'disabled' }),
      th: (tagName, attributes) => ({ tagName, attribs: safeCellAttributes(attributes) }),
      td: (tagName, attributes) => ({ tagName, attribs: safeCellAttributes(attributes) }),
    },
    onOpenTag() {
      if (++budget.nodes > EXPERIENCE_DOCUMENT_LIMITS.maxNodes) throw new BadRequestException('文档HTML节点总数不能超过5000');
      if (++depth > EXPERIENCE_DOCUMENT_LIMITS.maxDepth) throw new BadRequestException('文档HTML嵌套不能超过50层');
    },
    onCloseTag() { depth -= 1; },
  }).trim();
  validateTables(html, budget);
  return html;
}

function validateTables(html: string, budget: DocumentBudget) {
  const sections = new Set(['thead', 'tbody', 'tfoot']);
  const stack: string[] = [];
  let table: { rows: number; cursor: number; occupiedUntil: number[] } | undefined;
  // Parser callbacks, not regular expressions or browser-only DOM. No second-pass output is stored.
  sanitizeHtml(html, {
    allowedTags: [], allowedAttributes: {},
    onOpenTag(name, attributes) {
      const parent = stack[stack.length - 1];
      if (name === 'table') {
        if (table) throw new BadRequestException('不支持嵌套表格');
        if (++budget.tables > EXPERIENCE_DOCUMENT_LIMITS.maxTables) throw new BadRequestException('文档最多包含10张表');
        table = { rows: 0, cursor: 0, occupiedUntil: [] };
      } else if (sections.has(name)) {
        if (!table || parent !== 'table') throw new BadRequestException('表格分区结构无效');
      } else if (name === 'tr') {
        if (!table || !(parent === 'table' || sections.has(parent))) throw new BadRequestException('表格行结构无效');
        if (++table.rows > EXPERIENCE_DOCUMENT_LIMITS.maxRows) throw new BadRequestException('每张表格最多100行');
        table.cursor = 0;
      } else if (name === 'td' || name === 'th') {
        if (!table || parent !== 'tr') throw new BadRequestException('表格单元格结构无效');
        const row = table.rows - 1;
        const rowspan = Number(attributes.rowspan || 1);
        const colspan = Number(attributes.colspan || 1);
        while ((table.occupiedUntil[table.cursor] || 0) > row) table.cursor += 1;
        const end = table.cursor + colspan;
        if (end > EXPERIENCE_DOCUMENT_LIMITS.maxColumns) throw new BadRequestException('每张表格最多20列（包含合并单元格）');
        for (let column = table.cursor; column < end; column++) {
          if ((table.occupiedUntil[column] || 0) > row) throw new BadRequestException('表格合并单元格不能重叠');
          table.occupiedUntil[column] = row + rowspan;
        }
        budget.expandedCells += rowspan * colspan;
        if (budget.expandedCells > EXPERIENCE_DOCUMENT_LIMITS.maxExpandedCells) throw new BadRequestException('文档所有表格展开后最多2000个单元格');
        table.cursor = end;
      } else if (table && (parent === 'table' || sections.has(parent) || parent === 'tr')) {
        throw new BadRequestException('表格结构无效，请把内容放入单元格');
      }
      stack.push(name);
    },
    onCloseTag(name) {
      if (name === 'table' && table) {
        if (!table.rows) throw new BadRequestException('表格结构无效，至少需要一行');
        if (table.occupiedUntil.some((until) => until > table!.rows)) throw new BadRequestException('表格合并单元格超出实际行');
        table = undefined;
      }
      stack.pop();
    },
  });
}
