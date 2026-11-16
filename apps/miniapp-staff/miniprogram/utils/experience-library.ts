import type { RepairExperienceBlock, RepairExperienceNoteSummary, RepairExperienceSharingOptions } from '@pms/shared-types';

export type ExperienceCommunity = RepairExperienceSharingOptions['communities'][number];
export function experienceScope(note: RepairExperienceNoteSummary): string {
  if (note.visibility === 'private') return '仅我可见';
  if (!note.visibility || note.visibility === 'legacy') return '旧版共享';
  const names = note.communityNames || [];
  const communities = names.slice(0, 2).join('、') + (names.length > 2 ? ` +${names.length - 2}` : '');
  const types = note.repairTypeLabels || [];
  return `${communities || '已发布'} · ${types.length ? types.slice(0, 2).join('、') + (types.length > 2 ? ` +${types.length - 2}` : '') : '不限工种'}`;
}
export function experienceTypes(communities: ExperienceCommunity[]) {
  const types = new Map<string, { value: string; label: string }>();
  for (const community of communities) for (const type of community.repairTypes) types.set(type.value, type);
  return Array.from(types.values());
}
export function experienceRow(note: RepairExperienceNoteSummary) {
  return { ...note, scopeText: experienceScope(note), authorText: note.createdByName || note.updatedByName || '作者', updatedText: (note.updatedAt || '').slice(0, 16).replace('T', ' ') };
}
export function experienceError(error: any, fallback: string): string {
  return String(error?.message || error?.errMsg || fallback);
}
export function experienceCancelled(error: any): boolean { return /cancel/i.test(String(error?.errMsg || error?.message || '')); }

/** 不限document类型：旧段落HTML同样不能交给原生editor扁平化。 */
export function experienceHasTable(blocks: RepairExperienceBlock[]): boolean {
  return blocks.some((block) => /<table\b/i.test(String(block.html || '')));
}

/** 仅阅读副本添加展示样式；原始blocks完全不变，ACL保存仍用原始HTML。安全HTML由服务端统一清洗。 */
export function experienceTablePresentation(source: string): { html: string; tableMinWidth: string } {
  let maxWidth = 260;
  const html = source.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table) => {
    let columns = 1;
    for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi) || []) {
      let count = 0;
      for (const cell of row.match(/<t[dh]\b[^>]*>/gi) || []) {
        const span = cell.match(/\bcolspan\s*=\s*["']?(\d+)/i);
        count += span ? Math.min(20, Math.max(1, Number(span[1]))) : 1;
      }
      columns = Math.max(columns, Math.min(20, count));
    }
    const width = Math.max(260, columns * 120); maxWidth = Math.max(maxWidth, width);
    return table.replace(/<table\b[^>]*>/i, `<table style="border-collapse:collapse;table-layout:auto;min-width:${width}px;font-size:16px;color:#1f334a;">`)
      .replace(/<(th|td)\b([^>]*)>/gi, (_match, tag: string, attrs: string) => {
        const safeAttrs = attrs.replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        const header = tag.toLowerCase() === 'th' ? 'background:#edf4fa;font-weight:700;' : '';
        return `<${tag}${safeAttrs} style="border:1px solid #d6e1ec;padding:10px 12px;vertical-align:top;min-width:96px;white-space:normal;word-break:break-word;${header}">`;
      });
  });
  return { html, tableMinWidth: `${maxWidth}px` };
}
