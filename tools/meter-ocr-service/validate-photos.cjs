// Run from repo root: node tools/meter-ocr-service/validate-photos.cjs [full|crop|known]
// Requires a local sidecar and the supplied manifest.json in METER_VALIDATION_DIR.
// Expected readings are used ONLY after recognize() returns. No LLM or business storage is connected.
// crop mode is a MANUAL region diagnostic, not automatic detection accuracy.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const root=process.cwd();
process.env.TS_NODE_PROJECT=path.join(root,'apps/api/tsconfig.json');
require(path.join(root,'apps/api/node_modules/ts-node/register'));
const axios=require(path.join(root,'apps/api/node_modules/axios')).default;
const {MeterOcrService}=require(path.join(root,'apps/api/src/modules/meters/meter-ocr.service.ts'));
const {formatReadingValue}=require(path.join(root,'apps/api/src/modules/meters/meter-ocr.util.ts'));
const out=path.resolve(process.env.METER_VALIDATION_DIR || path.join(root,'outputs/meter-photo-validation-20261030'));
const endpoint=process.env.METER_VALIDATION_URL || 'http://127.0.0.1:18100/ocr';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+\/ocr$/.test(endpoint)) throw new Error('Validation requires an isolated local OCR service');
const cases=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
const mode=process.argv[2] || 'full';
if (!['full','crop','known'].includes(mode)) throw new Error('mode: full | crop | known');
const crops=[{x:.38,y:.57,w:.18,h:.05},{x:.59,y:.34,w:.18,h:.05},{x:.15,y:.42,w:.45,h:.08},{x:.23,y:.30,w:.20,h:.055},{x:.36,y:.61,w:.08,h:.16},{x:.50,y:.40,w:.12,h:.075}];
let current=0, calls=[];
axios.interceptors.response.use(response=>{
 if(response.config.url===endpoint) {
 const req=JSON.parse(response.config.data);
 calls.push({orientation:req.rotate,enhance:req.enhance,data:response.data});
 fs.writeFileSync(path.join(out,`raw-${mode}-${current}.json`),JSON.stringify(calls,null,2));
 }
 return response;
});
(async()=>{
const results=[];
for(const c of cases){
 if(mode==='known' && c.id!==3) continue;
 current=c.id;calls=[];
 const buffer=fs.readFileSync(c.path);
 const service=new MeterOcrService({get:k=>k==='METER_OCR_URL'?endpoint:''},
 {getObject:async()=>({stream:Readable.from([buffer])}),fileUrl:k=>k}, {isReady:async()=>false});
 const start=Date.now();
 const result=await service.recognize({id:c.id,integerDigits:c.integerDigits,decimalDigits:c.decimalDigits,meterNo:mode==='known'?'20054564':''},'uploads/isolated-test.jpg',mode==='crop'?crops[c.id-1]:undefined,{tenantId:0});
 const actual=formatReadingValue(result.value,c.integerDigits,c.decimalDigits);
 const row={id:c.id,expected:c.expected,actual,correct:actual===c.expected,elapsedMs:Date.now()-start,result};
 results.push(row);fs.writeFileSync(path.join(out,`results-${mode}.json`),JSON.stringify(results,null,2));
 console.log(JSON.stringify({...row,result:undefined,confidence:result.confidence,orientation:result.orientation,needsReview:result.needsReview,calls:calls.length}));
}
})().catch(e=>{console.error(e);process.exitCode=1});
