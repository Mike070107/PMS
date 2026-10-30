const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire}=require('node:module');
const apiRequire=createRequire(path.resolve(__dirname,'../../api/package.json'));
const ts=apiRequire('typescript');
const crop=apiRequire(path.resolve(__dirname,'../miniprogram/utils/crop.ts'));
const meter=apiRequire(path.resolve(__dirname,'../miniprogram/utils/meter.ts'));
function fixture({render=async()=>'/crop.png'}={}) {
 let definition, request, submission;
 const originalKey='uploads/original.jpg';
 const client={upload:{uploadTempFile:async()=>({objectKey:'uploads/crop.png'})},meters:{
   ocr:async(_id,data)=>{request=data;return {ok:true,provider:'llm',value:881,digits:'00881',confidence:80,needsReview:true,candidates:[{digits:'00881',value:881,score:.8}],texts:'raw'};},
   createReading:async(_id,data)=>{submission=data;return {reading:{readingValueText:'00881'}};},
 }};
 const wx={showToast:()=>{},pageScrollTo:()=>{},showModal:async()=>({confirm:true}),vibrateShort:()=>{},getFileSystemManager:()=>({unlink:()=>{}})};
 const source=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/meter-read/meter-read.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports:{},Page:config=>definition=config,wx,setTimeout,clearTimeout,console,require:name=>{
   if(name==='@pms/api-client')return client;
   if(name.endsWith('/crop'))return crop;
   if(name.endsWith('/meter'))return meter;
   if(name.endsWith('/meter-crop'))return {};
   if(name.endsWith('/meter-crop-canvas'))return {renderMeterCrop:render};
   if(name.endsWith('/session'))return {};
   throw Error(name);
 }});
 const page={...definition,data:{...definition.data},setData(change,callback){Object.assign(this.data,change);callback?.();}};
 Object.assign(page.data,{id:1,canSubmit:true,photoKey:originalKey,photoPath:'/original.jpg',photoWidth:1200,photoHeight:2000,photoDisplayWidth:300,photoDisplayHeight:500,
   meter:{meterNo:'W-1',integerDigits:5,decimalDigits:0,lastReadingValue:null,initialReading:null,unit:'m³'},cropOpen:true});
 return {page,get request(){return request;},get submission(){return submission;}};
}
test('空读数继续：字段错误、焦点，保留原图和弹层',()=>{
 const {page}=fixture();page.onUseCropResult();assert.match(page.data.valueError,/请填写/);assert.equal(page.data.cropValueFocus,true);assert.equal(page.data.cropOpen,true);assert.equal(page.data.photoKey,'uploads/original.jpg');
});
test('修正读数字段只清该字段错误，不清备注和识别失败信息',()=>{
 const {page}=fixture();Object.assign(page.data,{valueError:'必填',error:'AI未识别',note:'过渡字轮'});page.onCropValueInput({detail:{value:'00881'}});
 assert.equal(page.data.valueError,'');assert.equal(page.data.note,'过渡字轮');assert.equal(page.data.error,'AI未识别');assert.equal(page.data.valueText,'00881');
});
test('红框图独立识别，提交和留档保持全景原图',async()=>{
 const f=fixture();await f.page.recognizeRoi();assert.equal(f.request.imageKey,'uploads/original.jpg');assert.equal(f.request.recognitionImageKey,'uploads/crop.png');
 await f.page.submit();assert.equal(f.submission.photoKey,'uploads/original.jpg');assert.equal(f.submission.ocr.raw.recognitionImageKey,'uploads/crop.png');
});
test('取消裁切等待后，迟到结果不会触发上传识别或覆盖输入',async()=>{
 let resolve;const f=fixture({render:()=>new Promise(r=>resolve=r)});const pending=f.page.recognizeRoi();f.page.onCancelRecognition();f.page.onCropValueInput({detail:{value:'00999'}});resolve('/crop.png');await pending;
 assert.equal(f.request,undefined);assert.equal(f.page.data.valueText,'00999');assert.equal(f.page.data.recognizing,false);
});
