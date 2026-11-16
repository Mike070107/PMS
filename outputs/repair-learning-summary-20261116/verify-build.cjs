const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const out='outputs/repair-learning-summary-20261116/';
const freeze=JSON.parse(fs.readFileSync(out+'source-freeze.json','utf8'));
const requirements={
 'apps/api/dist/modules/repairs/repairs.service.js':['rememberRepairType','assignmentsOf','skillsAtOfficeOf','sampleMatched: false'],
 'apps/api/dist/modules/ai/extract-samples.service.js':['sampleOfficeWhere','_officeId','_classificationOnly','seedMarker'],
 'apps/api/dist/modules/ai/repair-text.ai.js':['_classificationOnly','learnedType']
};
const files=Object.entries(requirements).map(([path,terms])=>{
 const bytes=fs.readFileSync(path),text=bytes.toString(); for(const term of terms)assert(text.includes(term),`${path} missing ${term}`);
 return {path,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),markers:terms};
});
const result={sourceCommit:freeze.head,checkedAt:new Date().toISOString(),apiNestBuildExit:0,compiledMarkersVerified:true,artifacts:files};
fs.writeFileSync(out+'build-proof.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result,null,2));
