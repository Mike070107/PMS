const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const postcss=require('postcss');
const root=path.resolve(__dirname,'..');
const cssPath=path.join(root,'src/styles/erp-reference.css');
const readCss=()=>fs.existsSync(cssPath)?fs.readFileSync(cssPath,'utf8'):'';
test('ERP neutral shell is imported after every existing entry stylesheet',()=>{
 const entry=fs.readFileSync(path.join(root,'src/main.tsx'),'utf8');
 const imports=[...entry.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)].map(m=>m[1]);
 assert.equal(imports.at(-1),'./styles/erp-reference.css');
 const css=readCss();
 assert.ok(css.length>0,'shared ERP shell stylesheet exists');
 const ast=postcss.parse(css);
 const side=[];ast.walkRules(r=>{if(r.selector==='#web .side')side.push(r.toString())});
 assert.ok(side.some(s=>/background:\s*(?:#fff(?:fff)?|var\(--erp-surface\))/.test(s)),'white sidebar, independent of personal sidebar tint');
 assert.doesNotMatch(css,/var\(--sidebar-bg/);
 assert.match(css,/--erp-chart-blue:\s*#3976d7/);
 assert.match(css,/--erp-chart-teal:\s*#24999c/);
});
test('operational layer preserves print, brand, status and responsive interaction contracts',()=>{
 const css=readCss(),ast=postcss.parse(css);
 const rules=[];
 ast.walkRules(rule=>{
  rules.push(rule);
  let parent=rule.parent,screen=false;
  while(parent){if(parent.type==='atrule'&&parent.name==='media'&&/screen/.test(parent.params))screen=true;parent=parent.parent;}
  assert.ok(screen,`screen-only rule: ${rule.selector}`);
  for(const selector of rule.selector.split(','))assert.match(selector.trim(),/^(?:#web(?:\s|$)|\.(?:ant-modal|ant-drawer|ant-select-dropdown|ant-picker-dropdown|ant-dropdown|ant-cascader-dropdown|appearance-panel)(?:\s|$|\.|:))/,'explicit app or operational portal scope');
 });
 ast.walkDecls(d=>assert.ok(!/^--(?:acc(?:-|$)|ok(?:-|$)|warn(?:-|$)|dang(?:-|$)|info(?:-|$)|sidebar-bg)/.test(d.prop),`leave semantic and personal theme token intact: ${d.prop}`));
 assert.doesNotMatch(css,/!important|\[data-style|display:\s*none|visibility:\s*hidden/);
 assert.doesNotMatch(css,/\.(?:pm-ic|pays|cashier-payment|s-pend|s-work|s-done|ant-tag-|ant-btn-dangerous)\b/);
 assert.ok(rules.some(r=>r.selector.includes('#web .btn.p')&&r.toString().includes('var(--acc)')),'primary action follows preference');
 assert.ok(rules.some(r=>r.selector.includes('#web .top > .ib')&&r.toString().includes('44px')),'mobile top icons retain 44px targets');
 assert.ok(rules.some(r=>r.selector.includes('#web .tabs button')&&r.toString().includes('44px')),'tabs retain 44px targets');
 assert.ok(rules.some(r=>r.selector.includes('#web .card')),'shared white cards');
 assert.ok(rules.some(r=>r.selector.includes('#web .migrated-surface .ant-table-thead')),'legacy table harmonisation');
 assert.match(css,/@media screen and \(max-width: 900px\)/);
 const nav=fs.readFileSync(path.join(root,'src/styles/ui-preferences.css'),'utf8');
 assert.match(nav,/width:22px!important;height:22px!important/,'existing 22px navigation scale remains');
});
