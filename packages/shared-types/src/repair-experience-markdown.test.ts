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

test('表格document转换与展示保留HTML，纯文本导出隔开单元格和行', () => {
  const html = '<table><thead><tr><th>设备</th><th>型号</th></tr></thead><tbody><tr><td>水泵</td><td>Q20<br/>合格</td></tr></tbody></table>';
  const blocks = [{ id: 'table', type: 'document' as const, html }];
  assert.equal(repairExperienceBlocksToDocumentHtml(blocks), html);
  assert.equal(repairExperienceRenderBlocks(blocks)[0].html, html);
  assert.equal(repairExperienceDocumentPlainText(html), '设备 型号 水泵 Q20 合格');
  assert.equal(repairExperienceBlocksToMarkdown(blocks), '设备 型号 水泵 Q20 合格');
});

test('编辑保存输入保留多个document和legacy段落图片的原顺序，不仅取第一份document', () => {
  const tableHtml = '<table><tbody><tr><td>第二文档表格</td></tr></tbody></table>';
  const blocks = [
    { id: 'old-text', type: 'paragraph' as const, text: '旧段落 **保留**' },
    { id: 'document-one', type: 'document' as const, html: '<p>第一文档</p>' },
    { id: 'document-two', type: 'document' as const, html: tableHtml },
    { id: 'old-image', type: 'image' as const, url: 'https://safe.invalid/image?key=1&signature=abc', caption: '旧图片&说明' },
  ];
  const expected = '<p>旧段落 <strong>保留</strong></p><p>第一文档</p>' + tableHtml
    + '<figure><img src="https://safe.invalid/image?key=1&amp;signature=abc" alt="旧图片&amp;说明"><figcaption>旧图片&amp;说明</figcaption></figure>';
  const html = repairExperienceBlocksToDocumentHtml(blocks);
  assert.equal(html, expected);
  // Existing editors consolidate the input into one document block on save.
  const saveInput = { blocks: [{ id: 'merged-document', type: 'document' as const, html }] };
  assert.equal(repairExperienceBlocksToDocumentHtml(saveInput.blocks), expected);
  assert.equal(repairExperienceRenderBlocks(saveInput.blocks)[0].html, expected);
});

test('document插入legacy列表之间时先闭合列表，后续列表重新打开且顺序不变', () => {
  const blocks = [
    { id: 'a', type: 'ordered' as const, text: '步骤前' },
    { id: 'doc', type: 'document' as const, html: '<table><tr><td>中间表</td></tr></table>' },
    { id: 'b', type: 'ordered' as const, text: '步骤后' },
    { id: 'c', type: 'bullet' as const, text: '列表前' },
    { id: 'doc-two', type: 'document' as const, html: '<p>文档尾</p>' },
    { id: 'd', type: 'bullet' as const, text: '列表后' },
  ];
  assert.equal(repairExperienceBlocksToDocumentHtml(blocks), '<ol><li>步骤前</li></ol><table><tr><td>中间表</td></tr></table><ol><li>步骤后</li></ol><ul><li>列表前</li></ul><p>文档尾</p><ul><li>列表后</li></ul>');
});

test('连续编号步骤生成正确显示序号，遇到其他块后重新计数', () => {
  const blocks = repairExperienceMarkdownToBlocks('1. 一\n\n2. 二\n\n正文\n\n1. 三');
  assert.deepEqual(repairExperienceRenderBlocks(blocks).map((block) => block.order || 0), [1, 2, 0, 1]);
});
