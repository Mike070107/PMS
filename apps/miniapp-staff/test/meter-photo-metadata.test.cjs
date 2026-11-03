const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {createRequire}=require('node:module');const req=createRequire(path.resolve(__dirname,'../../api/package.json'));const ts=req('typescript');
const vendor=path.resolve(__dirname,'../miniprogram/utils/vendor/exifr.js');
const bytes=name=>fs.readFileSync(path.resolve(__dirname,'fixtures/meter-exif',name));
function load(wx={}) {
 const library={exports:{}};vm.runInNewContext(fs.readFileSync(vendor,'utf8'),{exports:library.exports,module:library,Uint8Array,ArrayBuffer,DataView,URL,console},{timeout:3000});
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../miniprogram/utils/meter-photo-metadata.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,wx,Uint8Array,ArrayBuffer,DataView,Date,setTimeout,clearTimeout,require:()=>library.exports,console});return exports;
}
test('真实JPEG与PNG EXIF：在无Node/Buffer/浏览器全局环境中读取GPS、精度和拍摄时区',async()=>{
 for(const name of ['north-east.jpg','with-gps.png']){const result=await load().parsePhotoMetadata(bytes(name));assert.equal(result.status,'ready');assert.equal(result.latitude,31.2);assert.equal(result.longitude,121.4);assert.equal(result.accuracy,12);assert.equal(result.photoTakenAtIso,'2026-11-03T01:10:11.000Z');}
 const south=await load().parsePhotoMetadata(bytes('south-west.jpg'));assert.equal(south.latitude,-31.2);assert.equal(south.longitude,-121.4);
});
test('照片无GPS、缺少时区、畸形GPS和损坏文件不伪造位置/时间',async()=>{
 const noGps=await load().parsePhotoMetadata(bytes('without-gps.jpg'));assert.equal(noGps.status,'missing');assert.ok(noGps.photoTakenAt);
 assert.equal((await load().parsePhotoMetadata(bytes('stripped.jpg'))).status,'missing');
 const noZone=await load().parsePhotoMetadata(bytes('without-timezone.jpg'));assert.equal(noZone.photoTakenAtIso,null);assert.equal(noZone.photoTakenAt,'2026-11-03 09:10:11');
 const invalid=await load().parsePhotoMetadata(bytes('invalid-gps.jpg'));assert.equal(invalid.status,'unreadable');assert.equal(invalid.latitude,undefined);
 assert.notEqual((await load().parsePhotoMetadata(new Uint8Array([1,2,3]))).status,'ready');
});
test('元数据读取只读原图，有文件大小与超时限制，不把读取失败当无GPS',async()=>{
 let reads=0;const data=bytes('north-east.jpg');const wx={getFileSystemManager:()=>({stat:o=>o.success({stats:{size:data.length}}),readFile:o=>{reads++;assert.equal(o.filePath,'original.jpg');o.success({data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)});}})};
 assert.equal((await load(wx).readPhotoMetadata('original.jpg')).status,'ready');assert.equal(reads,1);
 const huge={getFileSystemManager:()=>({stat:o=>o.success({stats:{size:20*1024*1024}}),readFile:()=>{throw Error('must not read');}})};assert.equal((await load(huge).readPhotoMetadata('huge.jpg')).status,'unreadable');
 assert.equal((await load({getFileSystemManager:()=>({stat:()=>{}})}).readPhotoMetadata('stuck.jpg',10)).status,'unreadable');
});
