export interface MisPostingCommand {
  ownerId: string;
  officeCodes: string[];
  receiptNo: string;
  paidDate: string; // Asia/Shanghai YYYYMMDD, captured by the server when PMS records collection.
  paymentMethodId: number;
  paymentMethod: string;
  collectorId: string;
  collectorName: string;
  bills: { id: string; feeCode: string; period: string; amountCents: number }[];
}
export interface MisPostingRow {
  id: string; ownerId: string; officeCode: string; propertyType: string;
  feeCode: string; period: string; amount: string | number;
  paidAt: string | null; refundedAt: string | null; receiptNo: string | null;
  paymentMethodId: number | null; collectorId: string | null;
  paymentMethod: string | null; collectorName: string | null;
  merchantOrder: string | null; tradeOrder: string | null; locked: boolean;
}

function sourceId(id: unknown): id is string {
  // SQL numeric(18,0) must never pass through a JS Number.
  return typeof id === 'string' && /^[1-9]\d{0,17}$/.test(id);
}
function cents(value: string | number) {
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(String(value));
  if (!m) throw new Error('账单金额非法，不支持负数或未知金额');
  const fraction = (m[2] || '').padEnd(4, '0');
  if (!fraction.endsWith('00')) throw new Error('MIS账单金额不是整分，请核实后办理');
  return BigInt(m[1]) * 100n + BigInt(fraction.slice(0, 2));
}
function validDate(value: string) {
  if (!/^\d{8}$/.test(value) || value < '19000101' || value > '20790606') return false;
  const d = new Date(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10).replace(/-/g,'') === value;
}
export function validateMisPosting(command: MisPostingCommand) {
  if (!sourceId(command.ownerId)) throw new Error('MIS住户标识非法');
  if (!Array.isArray(command.officeCodes) || !command.officeCodes.length || command.officeCodes.length > 4 || command.officeCodes.some(c => !['01','02','03','04'].includes(c)) || new Set(command.officeCodes).size !== command.officeCodes.length) throw new Error('缺少明确的MIS管理处授权');
  if (!/^PMS:[A-Za-z0-9-]{1,46}$/.test(command.receiptNo)) throw new Error('PMS收款凭证标识非法');
  if (!validDate(command.paidDate)) throw new Error('收款日期非法');
  if (!Number.isInteger(command.paymentMethodId) || command.paymentMethodId < 1 || command.paymentMethodId > 2147483647) throw new Error('MIS收款方式映射缺失');
  for (const [label,value] of [['收款方式',command.paymentMethod],['收款人编号',command.collectorId],['收款人',command.collectorName]]) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 50 || /[\x00-\x1f]/.test(value)) throw new Error(`${label}映射非法`);
  }
  if (!Array.isArray(command.bills) || !command.bills.length || command.bills.length > 120) throw new Error('请选择1至120条账单');
  const ids = new Set<string>();
  let total = 0;
  for (const b of command.bills) {
    if (!sourceId(b.id) || ids.has(b.id)) throw new Error('账单标识非法或重复');
    ids.add(b.id);
    if (!['01','04','14','16'].includes(b.feeCode)) throw new Error('该收费项目尚未确认写入协议');
    if (!/^\d{4}(0[1-9]|1[0-2])$/.test(b.period)) throw new Error('账单年月非法');
    if (!Number.isSafeInteger(b.amountCents) || b.amountCents < 0 || b.amountCents > 2147483647) throw new Error('账单金额非法');
    total += b.amountCents;
  }
  if (!Number.isSafeInteger(total) || total > 2147483647) throw new Error('收款合计超出安全范围');
  const property = command.bills[0].feeCode === '01';
  if (command.bills.some(b => (b.feeCode === '01') !== property)) throw new Error('物业费与泊位费应分别收款');
  return total;
}

/** Pure decision over rows re-read UNDER transaction locks; it never trusts a browser quote. */
export function planMisPosting(command: MisPostingCommand, rows: MisPostingRow[]) {
  const amountCents = validateMisPosting(command);
  const found = new Map(rows.map(r => [r.id,r]));
  if (rows.length !== command.bills.length || found.size !== rows.length) throw new Error('账单已变化或包含范围外账单，请重新核对');
  let paid = 0;
  for (const expected of command.bills) {
    const r = found.get(expected.id);
    if (!r || r.ownerId !== command.ownerId || !command.officeCodes.includes(r.officeCode) || !['01','04'].includes(r.propertyType)) throw new Error('账单不属于本次住户或授权管理处/房屋性质');
    if (r.feeCode !== expected.feeCode || r.period !== expected.period) throw new Error('账单项目或年月已变化');
    if (cents(r.amount) !== BigInt(expected.amountCents)) throw new Error('MIS账单金额已变化，请重新核对');
    if (r.refundedAt) throw new Error('账单已有退款记录，不能重复销账');
    if (r.paidAt) {
      if (r.receiptNo !== command.receiptNo || r.paidAt !== command.paidDate || r.paymentMethodId !== command.paymentMethodId || r.collectorId !== command.collectorId || r.paymentMethod !== command.paymentMethod || r.collectorName !== command.collectorName) throw new Error('账单已由其他收款或不同信息销账，需人工核实');
      paid++;
    } else if (r.merchantOrder || r.tradeOrder || r.locked || r.receiptNo) {
      throw new Error('账单已被其他支付渠道占用，不能覆盖');
    }
  }
  if (paid && paid !== rows.length) throw new Error('仅部分账单已销账，需人工核对，不自动补写');
  return { action: paid ? 'already_posted' as const : 'post' as const, amountCents };
}

/** Fixed SQL templates only. Neither SQL nor collector identity comes from an HTTP payload. */
export function buildMisPostingSql(command: MisPostingCommand) {
  validateMisPosting(command);
  const params: Record<string,string|number> = {
    ownerId:command.ownerId,receiptNo:command.receiptNo,paidDate:command.paidDate,
    methodId:command.paymentMethodId,methodName:command.paymentMethod,
    collectorId:command.collectorId,collectorName:command.collectorName,
  };
  const offices = command.officeCodes.map((v,i)=>{params[`office${i}`]=v;return `@office${i}`;}).join(',');
  const bills = command.bills.map((v,i)=>{params[`bill${i}`]=v.id;params[`amount${i}`]=v.amountCents;return `@bill${i}`;}).join(',');
  const scope = `FROM dbo.WYZJ w INNER JOIN dbo.[业主表] z ON z.ZH_ID=w.ZH_ID INNER JOIN dbo.[室表] s ON s.S_ID=z.S_ID INNER JOIN dbo.[楼表] l ON l.L_ID=s.L_ID`;
  const where = `w.ZH_ID=@ownerId AND w.ZJ_ID IN (${bills}) AND l.管理处 IN (${offices}) AND s.房屋性质 IN (N'01',N'04') AND ISNULL(w.SC,N'0')=N'0'`;
  const select = `SELECT CONVERT(varchar(30),w.ZJ_ID) AS id,CONVERT(varchar(30),w.ZH_ID) AS ownerId,l.管理处 AS officeCode,s.房屋性质 AS propertyType,w.ZJ_LX AS feeCode,w.ZJ_CNY AS period,CONVERT(varchar(50),w.ZJ_JE,2) AS amount,CONVERT(varchar(8),w.ZJ_SKRQ,112) AS paidAt,CONVERT(varchar(8),w.ZJ_TKRQ,112) AS refundedAt,w.凭证号码 AS receiptNo,w.收款方式ID AS paymentMethodId,w.收款人ID AS collectorId,w.收款方式 AS paymentMethod,w.收款人 AS collectorName,w.商户订单号 AS merchantOrder,w.交易订单号 AS tradeOrder,CAST(CASE WHEN w.锁定截止时间>GETDATE() THEN 1 ELSE 0 END AS bit) AS locked ${scope.replace('dbo.WYZJ w','dbo.WYZJ w WITH (UPDLOCK,HOLDLOCK)')} WHERE ${where} ORDER BY w.ZJ_ID;`;
  const guard = `SELECT g.GYD_DH AS officeCode,g.对应部门代号 AS department,CONVERT(varchar(8),MAX(c.封帐日期),112) AS closedDate,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.[收款方式列表] m WHERE m.id=@methodId AND m.收款方式=@methodName) THEN 1 ELSE 0 END AS bit) AS methodMatches,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.[员工档案] e WHERE e.工号=@collectorId AND e.姓名=@collectorName AND (e.离职日期 IS NULL OR e.离职日期>CONVERT(datetime,@paidDate,112))) THEN 1 ELSE 0 END AS bit) AS collectorMatches FROM dbo.[设置管理处] g WITH(HOLDLOCK) LEFT JOIN dbo.[封帐] c WITH(HOLDLOCK) ON g.对应部门代号=c.职能部门代号 OR LEFT(g.对应部门代号,LEN(c.职能部门代号)+1)=c.职能部门代号+N'-' WHERE g.GYD_DH IN (${offices}) AND ISNULL(g.取消,0)=0 AND (g.终止日期 IS NULL OR g.终止日期>CONVERT(datetime,@paidDate,112)) GROUP BY g.GYD_DH,g.对应部门代号;`;
  const unchanged = command.bills.map((_,i)=>`(w.ZJ_ID=@bill${i} AND w.ZJ_JE=CONVERT(money,@amount${i})/100)`).join(' OR ');
  const update = `UPDATE w SET ZJ_SKRQ=CONVERT(datetime,@paidDate,112),收款方式ID=@methodId,收款方式=@methodName,收款人ID=@collectorId,收款人=@collectorName,凭证号码=@receiptNo,updatedate=GETDATE() ${scope} WHERE ${where} AND w.ZJ_SKRQ IS NULL AND w.ZJ_TKRQ IS NULL AND w.凭证号码 IS NULL AND w.商户订单号 IS NULL AND w.交易订单号 IS NULL AND (w.锁定截止时间 IS NULL OR w.锁定截止时间<=GETDATE()) AND (${unchanged});`;
  return {select,guard,update,params};
}

export interface MisPostingTransaction {
  query(text:string,params:Record<string,string|number>): Promise<{recordset?: any[];rowsAffected?:number[]}>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
export interface MisPostingDriver { begin(isolation:'SERIALIZABLE'):Promise<MisPostingTransaction>; }

/** Pool ownership/lifetime remains with the server connector; importing this module never connects. */
export function createMssqlPostingDriver(pool:unknown,sql:any=require('mssql')):MisPostingDriver {
  return {async begin(){
    const tx=new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    try {await new sql.Request(tx).query('SET XACT_ABORT ON;');}
    catch(e){try{await tx.rollback();}catch{}throw e;}
    return {
      async query(text,params){
        const req=new sql.Request(tx);
        for(const [key,value] of Object.entries(params)) req.input(key,typeof value==='number'?sql.Int:sql.NVarChar(4000),value);
        return req.query(text);
      },
      commit:()=>tx.commit(),rollback:()=>tx.rollback(),
    };
  }};
}
export async function inspectMisPosting(command:MisPostingCommand,driver:MisPostingDriver):Promise<{state:'synced'|'unpaid'}>{
 const built=buildMisPostingSql(command);let tx:MisPostingTransaction|undefined;
 try{
  tx=await driver.begin('SERIALIZABLE');const rows=(await tx.query(built.select,built.params)).recordset||[];const plan=planMisPosting(command,rows);
  if(plan.action==='post'){
   const guards=(await tx.query(built.guard,built.params)).recordset||[];
   for(const office of new Set(rows.map(r=>r.officeCode))){const matches=guards.filter(g=>g.officeCode===office);if(matches.length!==1||!matches[0].department||matches[0].methodMatches!==true||matches[0].collectorMatches!==true)throw new MisPostingError('MIS收款人、方式或财务部门映射未核实，未写入','refused');const g=matches[0];if(g.closedDate&&(!/^\d{8}$/.test(g.closedDate)||command.paidDate<=g.closedDate))throw new MisPostingError('收款日期已封帐，不能销账','refused');}
  }
  await tx.commit();return{state:plan.action==='already_posted'?'synced':'unpaid'};
 }catch(e){if(tx)try{await tx.rollback()}catch{}if(e instanceof MisPostingError)throw e;throw new MisPostingError('原凭证只读核验未完成，请稍后在原单核查；未重复销账','unknown');}
}
export class MisPostingError extends Error {
  constructor(message:string,public readonly state:'refused'|'not_posted'|'unknown') {super(message);this.name='MisPostingError';}
}

/** The adapter is intentionally opt-in. A PMS durable handling row must exist BEFORE invoking it. */
export async function executeMisPosting(command:MisPostingCommand,driver:MisPostingDriver,enabled=false) {
  if (!enabled) throw new MisPostingError('MIS写入未启用；尚未修改源库','refused');
  const sql=buildMisPostingSql(command);
  let tx:MisPostingTransaction|undefined;
  let attemptedWrite=false,attemptedCommit=false;
  const refuse=(message:string):never=>{throw new MisPostingError(message,'refused');};
  try {
    tx=await driver.begin('SERIALIZABLE');
    const rows=(await tx.query(sql.select,sql.params)).recordset||[];
    let plan:ReturnType<typeof planMisPosting>;
    try {plan=planMisPosting(command,rows);}catch(e){refuse((e as Error).message);}
    if (plan!.action==='post') {
      const guards=(await tx.query(sql.guard,sql.params)).recordset||[];
      for (const office of new Set(rows.map(r=>r.officeCode))) {
        const matches=guards.filter(g=>g.officeCode===office);
        if (matches.length!==1 || !matches[0].department) refuse('管理处/财务部门映射缺失或重复，未销账');
        const g=matches[0];
        if (g.methodMatches!==true || g.collectorMatches!==true) refuse('MIS收款方式或实际收款人映射已变化，未销账');
        if (g.closedDate && (!/^\d{8}$/.test(g.closedDate) || command.paidDate<=g.closedDate)) refuse('收款日期已封帐，不能销账');
      }
      attemptedWrite=true;
      const affected=await tx.query(sql.update,sql.params);
      if ((affected.rowsAffected||[]).reduce((a,b)=>a+b,0)!==command.bills.length) refuse('账单写入行数不符，整笔回滚，不保留部分销账');
      const after=(await tx.query(sql.select,sql.params)).recordset||[];
      try {if(planMisPosting(command,after).action!=='already_posted')refuse('MIS销账回读不一致，整笔回滚');}
      catch(e){refuse((e as Error).message);}
    }
    attemptedCommit=true;
    await tx.commit();
    return {state:'synced' as const,alreadyPosted:plan!.action==='already_posted',receiptNo:command.receiptNo,amountCents:plan!.amountCents,billIds:command.bills.map(b=>b.id)};
  } catch(e) {
    let rolledBack=false;
    if(tx)try{await tx.rollback();rolledBack=true;}catch{/* A failed COMMIT is never safe to repeat blindly. */}
    if(attemptedCommit || (attemptedWrite&&!rolledBack)) throw new MisPostingError('MIS销账结果未知：先按原PMS凭证回读核实，禁止重新收款或换单重试','unknown');
    if(e instanceof MisPostingError)throw e;
    // Do not surface driver errors: they may contain SQL, connection strings or credentials.
    throw new MisPostingError('MIS销账未完成，事务未提交；请在原办理单核查后重试','not_posted');
  }
}
