import assert from 'node:assert/strict';
import test from 'node:test';
import {
  repairExperienceBlocksToDocumentHtml,
  repairExperienceBlocksToMarkdown,
  repairExperienceDocumentPlainText,
  repairExperienceInlineHtml,
  repairExperienceMarkdownToBlocks,
  repairExperienceRenderBlocks,
} from './repair-experience-markdown';

test('旧内容块可转换为富文本文档继续编辑', () => {
  const html = repairExperienceBlocksToDocumentHtml([
    { id: 'h', type: 'heading', text: '排查方法' },
    { id: 'p', type: 'paragraph', text: '先检查 **电源**' },
    { id: 'l', type: 'bullet', text: '查看指示灯' },
  ]);
  assert.match(html, /<h2>排查方法<\/h2>/);
  assert.match(html, /<strong>电源<\/strong>/);
  assert.match(html, /<ul><li>查看指示灯<\/li><\/ul>/);
  assert.equal(repairExperienceDocumentPlainText(html), '排查方法 先检查 电源 查看指示灯');
});

test('维修经验 Markdown 可在结构化内容间往返', () => {
  const source = [
    '## 排查方法', '', '先检查 **电源**。', '', '- 断电', '', '1. 拆开面板', '',
    '- [x] 已拍照', '', '> 这是引用', '', '> [!WARNING]', '> 操作前必须断电', '',
    '![接线照片](https://example.com/a.jpg)', '', '---',
  ].join('\n');
  const blocks = repairExperienceMarkdownToBlocks(source);
  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'paragraph', 'bullet', 'ordered', 'checklist', 'quote', 'warning', 'image', 'divider',
  ]);
  assert.equal(blocks[4].checked, true);
  assert.match(repairExperienceBlocksToMarkdown(blocks), /\- \[x\] 已拍照/);
});

test('行内 Markdown 先转义再渲染，链接只接受 http(s)', () => {
  assert.equal(repairExperienceInlineHtml('<script> **重点**'), '&lt;script&gt; <strong>重点</strong>');
  assert.match(repairExperienceInlineHtml('[说明](https://example.com)'), /^<a href=/);
  assert.equal(repairExperienceInlineHtml('[危险](javascript:alert(1))'), '[危险](javascript:alert(1))');
});

test('连续编号步骤生成正确显示序号，遇到其他块后重新计数', () => {
  const blocks = repairExperienceMarkdownToBlocks('1. 一\n\n2. 二\n\n正文\n\n1. 三');
  assert.deepEqual(repairExperienceRenderBlocks(blocks).map((block) => block.order || 0), [1, 2, 0, 1]);
});
