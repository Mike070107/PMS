export async function request<T>(o:any):Promise<T>{
 const url=new URL(o.url,location.origin);for(const[k,v]of Object.entries(o.query||{}))if(v!==undefined)url.searchParams.set(k,String(v));
 const r=await fetch(url,{method:o.method||'GET',headers:{'content-type':'application/json','x-test-view':'yes','x-test-edit':(window as any).__screenReadOnly?'no':'yes','x-test-fail':(window as any).__screenFail?'yes':'no'},body:o.data?JSON.stringify(o.data):undefined});
 const data=await r.json();if(!r.ok)throw Error(Array.isArray(data.message)?data.message.join('；'):data.message||'读取失败');return data;
}
