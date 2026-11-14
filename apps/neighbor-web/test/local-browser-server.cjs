'use strict';
async function listenBrowserLocal(server){
 // Windows的listen(0)可能分配Chrome禁用低端口；显式选择高位端口，占用/系统保留时有限重试。
 for(let attempt=0;attempt<32;attempt++){
  const port=require('node:crypto').randomInt(49152,65536);
  try{
   await new Promise((resolve,reject)=>{
    const clean=()=>{server.off('error',failed);server.off('listening',ready)};
    const failed=e=>{clean();reject(e)},ready=()=>{clean();resolve()};
    server.once('error',failed);server.once('listening',ready);
    try{server.listen(port,'127.0.0.1')}catch(e){failed(e)}
   });return;
  }catch(e){if(!['EADDRINUSE','EACCES'].includes(e.code))throw e}
 }
 throw Error('无法分配浏览器可用的本地测试端口');
}
module.exports={listenBrowserLocal};
