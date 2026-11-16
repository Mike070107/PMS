const https=require('node:https'),dns=require('node:dns/promises'),fs=require('node:fs'),assert=require('node:assert/strict');
const out='outputs/repair-learning-deploy-20261116';
async function get(fixed){return await new Promise((resolve,reject)=>{
 const req=https.get('https://prsznh.cn/api/v1/health?preflight='+Date.now(),{agent:false,...(fixed?{family:4,lookup:(host,opts,cb)=>cb(null,'124.223.179.214',4)}:{})},res=>{
  const socket=res.socket;let data='';res.setEncoding('utf8');res.on('data',s=>data+=s);res.on('end',()=>{try {assert.equal(res.statusCode,200);assert(socket.authorized);if(fixed)assert.equal(socket.remoteAddress,'124.223.179.214'); const body=JSON.parse(data);assert.equal(body.status,'ok');assert.equal(body.db,'up');resolve({remoteAddress:socket.remoteAddress,tlsAuthorized:socket.authorized,status:res.statusCode,body});}catch(e){reject(e)}});
 });req.setTimeout(20000,()=>req.destroy(new Error('preflight timeout')));req.on('error',reject);
});}
(async()=>{fs.mkdirSync(out,{recursive:true});const result={checkedAt:new Date().toISOString(),node:process.version,dns:await dns.resolve4('prsznh.cn'),sshIdentity:{host:'VM-4-8-ubuntu',privateIP:'10.0.4.8',instanceId:'ins-2s08wnpd',directory:'/opt/pms-repair/apps/api',service:'pms-api',state:'online',scope:'observed by BatchMode/StrictHostKeyChecking SSH read-only preflight before this capture'},domain:await get(false),fixedIP:await get(true)};fs.writeFileSync(out+'/preflight.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));})().catch(e=>{console.error(e);process.exitCode=1});
