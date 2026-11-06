const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
test('分类与子菜单均显式使用22px官方图标，折叠箭头保留14px',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../src/components/Shell.tsx'),'utf8');
 const tree=ts.createSourceFile('Shell.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const icons=new Map();
 function visit(n){if((ts.isJsxSelfClosingElement(n)||ts.isJsxOpeningElement(n))&&n.tagName.getText(tree)==='Icon'){
  const p=Object.fromEntries(n.attributes.properties.filter(ts.isJsxAttribute).map(a=>[a.name.getText(tree),a.initializer]));
  if(p.name&&ts.isJsxExpression(p.name)&&p.name.expression){const key=p.name.expression.getText(tree);if(['g.icon','item.icon'].includes(key))icons.set(key,p.size&&ts.isJsxExpression(p.size)&&p.size.expression?Number(p.size.expression.getText(tree)):null);}
 }ts.forEachChild(n,visit);}visit(tree);
 assert.equal(icons.get('g.icon'),22,'主分类图标仍小于子菜单');assert.equal(icons.get('item.icon'),22,'子菜单未使用统一尺寸');assert.match(source,/<Icon name="chev" size=\{14\} className="navGroupChev"/);
});
