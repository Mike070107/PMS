/** Isolated A/B benchmark. No production configuration, storage or database access.
 * Expected readings are used only after the provider response, never in prompts.
 * Import createBenchmark() and pass the API key in memory, or use DASHSCOPE_API_KEY.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROMPT = `请读取照片中主体水表或电表的当前累计读数。多表同框时选择画面中最完整、最突出的主体仪表，不读取旁边不完整的表。只读取实际计数窗口或液晶屏里的累计数字，不要把表号、条码、封签号、标准号、规格、年份、瞬时电流或电压当读数。
逐位保留前导零，字轮窗口内黑色和红色数字都要读取；红色本身不代表小数点，不要自行补小数点。液晶屏上明确存在的小数点须保留。遇到反光、遮挡、半转字轮或模糊数字而无法确定时，该位写?，不要根据上下文或常识猜数字。
只输出一个JSON对象：{"reading":"保留前导零的读数字符串，找不到则空字符串","uncertain":true或false,"reason":"不确定或选表依据的简短说明","meterNo":"可见表号，否则空字符串"}。`;

export async function createBenchmark({apiKey, baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1', directory='outputs/meter-photo-validation-20261030-vl', manifest='outputs/meter-photo-validation-20261030/manifest.json', imageMode='original full image bytes, no crop or rotation'}={}) {
  if (!apiKey) throw new Error('A test API key is required');
  if (baseUrl !== 'https://dashscope.aliyuncs.com/compatible-mode/v1') throw new Error('This run is scoped to the documented Beijing endpoint; confirm other endpoints separately');
  const cases=JSON.parse(await fs.readFile(manifest,'utf8'));
  const models=['qwen3-vl-plus','qwen-vl-ocr'];
  const dir=path.resolve(directory);
  await fs.mkdir(dir,{recursive:true});
  const results=[];
  let stopped=false;
  const redact=s=>String(s).split(apiKey).join('[REDACTED]');
  const write=async(file,data)=>fs.writeFile(path.join(dir,file),redact(JSON.stringify(data,null,2)),'utf8');
  await write('protocol.json',{createdAt:new Date().toISOString(),endpoint:baseUrl,models,prompt:PROMPT,imageMode,temperature:0,maxTokens:500,minPixels:65536,maxPixels:8388608,retries:0,expectedNeverSent:true});
  async function run(id,model) {
    if(stopped) return {skipped:true,reason:'Stopped after authorization failure'};
    if(!models.includes(model)) throw new Error('Unexpected model');
    const item=cases.find(c=>c.id===id);
    if(!item) throw new Error('Unknown sample');
    const buffer=await fs.readFile(item.path);
    const sha256=crypto.createHash('sha256').update(buffer).digest('hex');
    if(sha256!==item.sha256) throw new Error('Sample hash changed');
    const body={model,messages:[{role:'user',content:[
      {type:'image_url',image_url:{url:`data:${path.extname(item.path).toLowerCase()==='.png'?'image/png':'image/jpeg'};base64,${buffer.toString('base64')}`,detail:'high'},min_pixels:65536,max_pixels:8388608},
      {type:'text',text:PROMPT}
    ]}],temperature:0,max_tokens:500};
    if(model==='qwen3-vl-plus') body.enable_thinking=false;
    const started=Date.now();
    const row={id,model,startedAt:new Date().toISOString(),sha256,expected:item.expected};
    try {
      const response=await fetch(`${baseUrl}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
      row.status=response.status;
      const raw=redact(await response.text());
      let data;
      try {data=JSON.parse(raw);} catch {data={invalidJson:raw.slice(0,2000)};}
      await write(`raw-${model}-${id}.json`,data);
      row.requestId=response.headers.get('x-request-id')||data.request_id||data.id||null;
      row.elapsedMs=Date.now()-started;
      if(!response.ok) {
        row.error=data.error||data;
        row.correct=false;
        if([401,403].includes(response.status)) stopped=true;
      } else {
        row.returnedModel=data.model;
        row.usage=data.usage;
        row.finishReason=data.choices?.[0]?.finish_reason;
        row.content=data.choices?.[0]?.message?.content||'';
        const content=Array.isArray(row.content)?row.content.map(p=>p.text||'').join(''):row.content;
        let parsed;
        try { parsed=JSON.parse(content.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')); } catch {
          const a=content.indexOf('{'),b=content.lastIndexOf('}');
          if(a>=0&&b>a) {try {parsed=JSON.parse(content.slice(a,b+1));} catch {}}
        }
        row.actual=typeof parsed?.reading==='string'?parsed.reading.trim():null;
        row.uncertain=parsed?.uncertain??null;
        row.reason=parsed?.reason??null;
        // Strict string equality. Do not pad, truncate, move decimal points or substitute digits.
        row.correct=row.actual===item.expected;
        row.numericEquivalent=row.actual!==null && /^\d+(\.\d+)?$/.test(row.actual) && Number(row.actual)===Number(item.expected);
      }
    } catch(error) {
      row.elapsedMs=Date.now()-started;
      row.error=redact(error.name==='TimeoutError'?'Timed out; request result unknown, not retried':`${error.name}: ${error.message}`);
      row.correct=false;
    }
    results.push(row);
    await write(`result-${model}-${id}.json`,row);
    await write('results.json',[...results].sort((a,b)=>a.id-b.id||a.model.localeCompare(b.model)));
    return JSON.parse(redact(JSON.stringify(row)));
  }
  return {run,cases:cases.map(c=>({id:c.id})),models,get stopped(){return stopped;}};
}
