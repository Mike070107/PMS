const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const esbuild=createRequire(require.resolve('vite/package.json'))('esbuild'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
test('new vehicle registration renders the structured API QR image, not the QR object',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/pages/Vehicles.tsx'),'utf8');
 const line=source.split(/\r?\n/).find(x=>x.includes('alt="登记二维码"'));
 assert.ok(line,'test must exercise the actual registration QR markup');
 const code=esbuild.transformSync('module.exports=(newQr)=>(<>'+line.trim()+'</>);',{loader:'tsx',jsx:'transform',format:'cjs'}).code;
 const module={exports:{}};new Function('module','exports','React','ErrorNote',code)(module,module.exports,React,({children})=>React.createElement('div',{role:'alert'},children));
 const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/GmQAAAAASUVORK5CYII=';
 const response={id:71,qr:{url:'https://example.invalid/m/plate/fixture-only',dataUrl,expiresAt:'2030-01-01T00:00:00.000Z'}};
 const html=renderToStaticMarkup(module.exports(response));
 assert.ok(html.includes('src="'+dataUrl+'"'),html);assert.ok(!html.includes('[object Object]'));
});
