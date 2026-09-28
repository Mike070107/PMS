import type { RepairExperienceBlock, RepairExperienceBlockType } from './repair-experience';

const TEXT_BLOCK_TYPES = new Set<RepairExperienceBlockType>([
  'heading', 'paragraph', 'bullet', 'ordered', 'checklist', 'quote', 'warning',
]);

function blockId(index: number) {
  return `md-${Date.now()}-${index}-${Math.floor(Math.random() * 10000)}`;
}

function escapeImageCaption(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

/** 把安全的结构化经验笔记导出为通用 Markdown。 */
export function repairExperienceBlocksToMarkdown(blocks: RepairExperienceBlock[]): string {
  return blocks.map((block) => {
    const text = String(block.text || '').trim();
    switch (block.type) {
      case 'heading': return `## ${text}`;
      case 'bullet': return `- ${text}`;
      case 'ordered': return `1. ${text}`;
      case 'checklist': return `- [${block.checked ? 'x' : ' '}] ${text}`;
      case 'quote': return text.split('\n').map((line) => `> ${line}`).join('\n');
      case 'warning': return `> [!WARNING]\n${text.split('\n').map((line) => `> ${line}`).join('\n')}`;
      case 'divider': return '---';
      case 'image': return `![${escapeImageCaption(String(block.caption || '图片'))}](${String(block.url || '').trim()})`;
      case 'document': return repairExperienceDocumentPlainText(String(block.html || ''));
      default: return text;
    }
  }).filter(Boolean).join('\n\n');
}

function isBlockStart(line: string): boolean {
  return /^(#{1,6}\s+|[-*_]{3,}\s*$|-\s+\[[ xX]\]\s+|[-+*]\s+|\d+[.)]\s+|>\s*|!\[[^\]]*\]\([^\s)]+\)\s*$)/.test(line);
}

/**
 * 解析维修经验支持的 Markdown 子集。未知语法保留为普通正文，不静默丢内容。
 * 支持标题、无序/有序步骤、待办、引用、警示块、分隔线和图片。
 */
export function repairExperienceMarkdownToBlocks(source: string): RepairExperienceBlock[] {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: RepairExperienceBlock[] = [];
  let index = 0;
  const pushText = (type: RepairExperienceBlockType, text: string, checked?: boolean) => {
    const value = text.trim();
    if (!value && type !== 'divider') return;
    blocks.push({ id: blockId(index++), type, ...(type === 'divider' ? {} : { text: value }), ...(type === 'checklist' ? { checked: !!checked } : {}) });
  };

  for (let cursor = 0; cursor < lines.length;) {
    const line = lines[cursor];
    if (!line.trim()) { cursor += 1; continue; }

    if (/^>\s*\[!WARNING\]\s*$/i.test(line)) {
      const body: string[] = [];
      cursor += 1;
      while (cursor < lines.length && /^>/.test(lines[cursor])) {
        body.push(lines[cursor].replace(/^>\s?/, ''));
        cursor += 1;
      }
      pushText('warning', body.join('\n'));
      continue;
    }

    const image = line.match(/^!\[([^\]]*)\]\(([^\s)]+)\)\s*$/);
    if (image) {
      blocks.push({ id: blockId(index++), type: 'image', caption: image[1].replace(/\\]/g, ']'), url: image[2] });
      cursor += 1;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line)) { pushText('divider', ''); cursor += 1; continue; }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) { pushText('heading', heading[1]); cursor += 1; continue; }
    const checklist = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (checklist) { pushText('checklist', checklist[2], checklist[1].toLowerCase() === 'x'); cursor += 1; continue; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) { pushText('ordered', ordered[1]); cursor += 1; continue; }
    const bullet = line.match(/^\s*[-+*]\s+(.+)$/);
    if (bullet) { pushText('bullet', bullet[1]); cursor += 1; continue; }
    if (/^>/.test(line)) {
      const body: string[] = [];
      while (cursor < lines.length && /^>/.test(lines[cursor]) && !/^>\s*\[!WARNING\]/i.test(lines[cursor])) {
        body.push(lines[cursor].replace(/^>\s?/, ''));
        cursor += 1;
      }
      pushText('quote', body.join('\n'));
      continue;
    }

    const paragraph: string[] = [line];
    cursor += 1;
    while (cursor < lines.length && lines[cursor].trim() && !isBlockStart(lines[cursor])) {
      paragraph.push(lines[cursor]);
      cursor += 1;
    }
    pushText('paragraph', paragraph.join('\n'));
  }
  return blocks;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] as string);
}

/** 把旧版结构化内容转换成新富文本编辑器可直接继续编辑的安全 HTML。 */
export function repairExperienceBlocksToDocumentHtml(blocks: RepairExperienceBlock[]): string {
  const documentBlock = blocks.find((block) => block.type === 'document' && block.html);
  if (documentBlock?.html) return documentBlock.html;
  let orderedOpen = false;
  let bulletOpen = false;
  const output: string[] = [];
  const closeLists = () => {
    if (orderedOpen) output.push('</ol>');
    if (bulletOpen) output.push('</ul>');
    orderedOpen = false;
    bulletOpen = false;
  };
  for (const block of blocks) {
    const inline = repairExperienceInlineHtml(block.text || '');
    if (block.type === 'ordered') {
      if (!orderedOpen) { closeLists(); output.push('<ol>'); orderedOpen = true; }
      output.push(`<li>${inline}</li>`);
      continue;
    }
    if (block.type === 'bullet') {
      if (!bulletOpen) { closeLists(); output.push('<ul>'); bulletOpen = true; }
      output.push(`<li>${inline}</li>`);
      continue;
    }
    closeLists();
    if (block.type === 'heading') output.push(`<h2>${inline}</h2>`);
    else if (block.type === 'paragraph') output.push(`<p>${inline}</p>`);
    else if (block.type === 'quote') output.push(`<blockquote>${inline}</blockquote>`);
    else if (block.type === 'warning') output.push(`<aside>${inline}</aside>`);
    else if (block.type === 'checklist') output.push(`<ul data-type="taskList"><li data-type="taskItem" data-checked="${!!block.checked}"><label><input type="checkbox"${block.checked ? ' checked' : ''}></label><div><p>${inline}</p></div></li></ul>`);
    else if (block.type === 'divider') output.push('<hr>');
    else if (block.type === 'image' && block.url) output.push(`<figure><img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.caption || '')}">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`);
  }
  closeLists();
  return output.join('');
}

/** 用于搜索、卡片摘要与空内容判断；不把 HTML 标签暴露给用户。 */
export function repairExperienceDocumentPlainText(html: string): string {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/blockquote|\/aside|\/figcaption)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 只渲染明确支持的行内 Markdown；其余字符全部转义，供 Web 与小程序 rich-text 安全复用。 */
export function repairExperienceInlineHtml(value: string): string {
  const source = String(value || '');
  const token = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let output = '';
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    const start = match.index ?? 0;
    output += escapeHtml(source.slice(cursor, start));
    const raw = match[0];
    if (raw.startsWith('**')) output += `<strong>${escapeHtml(raw.slice(2, -2))}</strong>`;
    else if (raw.startsWith('*')) output += `<em>${escapeHtml(raw.slice(1, -1))}</em>`;
    else if (raw.startsWith('`')) output += `<code>${escapeHtml(raw.slice(1, -1))}</code>`;
    else {
      const link = raw.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      output += link
        ? `<a href="${escapeHtml(link[2])}">${escapeHtml(link[1])}</a>`
        : escapeHtml(raw);
    }
    cursor = start + raw.length;
  }
  return `${output}${escapeHtml(source.slice(cursor))}`.replace(/\n/g, '<br/>');
}

export interface RepairExperienceRenderBlock extends RepairExperienceBlock {
  html?: string;
  order?: number;
}

export function repairExperienceRenderBlocks(blocks: RepairExperienceBlock[]): RepairExperienceRenderBlock[] {
  let ordered = 0;
  return blocks.map((block) => {
    ordered = block.type === 'ordered' ? ordered + 1 : 0;
    return {
      ...block,
      ...(block.type === 'document' ? { html: block.html || '' } : TEXT_BLOCK_TYPES.has(block.type) ? { html: repairExperienceInlineHtml(block.text || '') } : {}),
      ...(block.type === 'ordered' ? { order: ordered } : {}),
    };
  });
}
