import { BadRequestException } from '@nestjs/common';

export interface MisFeeQuery {
 communityId?:number; houseId?:number; q?:string; feeCode?:string;
 periodFrom?:string; periodTo?:string; paidFrom?:string; paidTo?:string;
 status?:'paid'|'unpaid'|'refunded'|'adjustment'; page?:number;pageSize?:number;
}
export interface MisHouseFilter {road:string;lane:string;buildingNo:string;roomNo:string;shop:boolean;}
export function validateMisFeeRange(q:MisFeeQuery){
 for(const value of [q.periodFrom,q.periodTo])if(value&&!/^\d{4}(0[1-9]|1[0-2])$/.test(value))throw new BadRequestException('账期格式应为YYYYMM');
 if(q.periodFrom&&q.periodTo&&q.periodFrom>q.periodTo)throw new BadRequestException('开始账期不能晚于结束账期');
 for(const value of [q.paidFrom,q.paidTo])if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))throw new BadRequestException('收款日期不合法');
 if(q.paidFrom&&q.paidTo&&q.paidFrom>q.paidTo)throw new BadRequestException('开始日期不能晚于结束日期');
 const maxSize=(q as any)._aging===false?20000:500;
 if((q.page!==undefined&&(!Number.isInteger(q.page)||q.page<1||q.page>1000000))||(q.pageSize!==undefined&&(!Number.isInteger(q.pageSize)||q.pageSize<1||q.pageSize>maxSize)))throw new BadRequestException('分页参数不合法');
}
export function misMoneyToCents(value:unknown):number{
 const match=/^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value??'0'));
 if(!match)throw new Error('MIS金额不合法');
 const decimals=(match[3]||'').padEnd(3,'0');
 const cents=BigInt(match[2])*100n+BigInt(decimals.slice(0,2))+(Number(decimals[2])>=5?1n:0n);
 const n=Number(match[1]? -cents:cents);if(!Number.isSafeInteger(n))throw new Error('MIS金额超出安全范围');return n;
}
export function misFeeStatus(row:{amountCents:number;paidAt?:string|null;refundedAt?:string|null}){
 return row.refundedAt?'refunded':row.amountCents<0?'adjustment':row.paidAt?'paid':'unpaid';
}
export function buildMisFeeFilter(q:MisFeeQuery,offices:string[],house?:MisHouseFilter){
 validateMisFeeRange(q);
 if(!offices.length||offices.some(x=>!['01','02','03','04'].includes(x)))throw new BadRequestException('MIS小区范围不合法');
 const params:Record<string,string|number>={};
 const where=[`l.管理处 IN (${offices.map((o,i)=>{params[`office${i}`]=o;return `@office${i}`;}).join(',')})`,`ISNULL(w.SC,N'0')=N'0'`];
 for(const [key,op,column] of [['periodFrom','>=','w.ZJ_CNY'],['periodTo','<=','w.ZJ_CNY']] as const)if(q[key]){params[key]=q[key]!;where.push(`${column}${op}@${key}`);}
 if(q.paidFrom){params.paidFrom=q.paidFrom;where.push("w.ZJ_SKRQ>=CONVERT(datetime,REPLACE(@paidFrom,'-',''),112)");}
 if(q.paidTo){params.paidTo=q.paidTo;where.push("w.ZJ_SKRQ<DATEADD(day,1,CONVERT(datetime,REPLACE(@paidTo,'-',''),112))");}
 if(q.feeCode){params.feeCode=q.feeCode;where.push('w.ZJ_LX=@feeCode');}
 if(q.status==='unpaid')where.push('w.ZJ_SKRQ IS NULL','w.ZJ_TKRQ IS NULL','w.ZJ_JE>=0');
 if(q.status==='paid')where.push('w.ZJ_SKRQ IS NOT NULL','w.ZJ_TKRQ IS NULL','w.ZJ_JE>=0');
 if(q.status==='refunded')where.push('w.ZJ_TKRQ IS NOT NULL');
 if(q.status==='adjustment')where.push('w.ZJ_JE<0','w.ZJ_TKRQ IS NULL');
 const address=`ISNULL(l.地址1,N'')+ISNULL(l.字1,N'')+ISNULL(l.地址2,N'')+ISNULL(l.字2,N'')+ISNULL(l.地址3,N'')+ISNULL(l.字3,N'')+ISNULL(l.地址4,N'')+ISNULL(l.字4,N'')+ISNULL(s.室,N'')+ISNULL(s.字,N'')`;
 if(q.q?.trim()){
  params.search='%'+q.q.trim().replace(/[\[\]%_]/g,c=>`[${c}]`)+'%';
  where.push(`(${address} LIKE @search OR z.姓名 LIKE @search OR z.移动电话 LIKE @search OR z.固定电话 LIKE @search OR z.联系方式 LIKE @search OR w.ZJ_HM LIKE @search OR w.凭证号码 LIKE @search OR w.发票号码 LIKE @search)`);
 }
 if(house){
  params.houseRoad=house.road;params.houseLane=house.lane;params.houseNumber=house.buildingNo;params.houseRoom=house.roomNo;
  where.push(`l.地址1=@houseRoad`);
  if(house.shop)where.push(`((ISNULL(l.地址2,N'')=N'' AND l.地址3=@houseNumber AND s.室=@houseNumber) OR (l.地址3=N'非居住' AND s.室=@houseNumber))`);
  else where.push(`ISNULL(l.地址2,N'')=@houseLane`,`l.地址3=@houseNumber`,`s.室=@houseRoom`);
 }
 const from=`FROM dbo.WYZJ w INNER JOIN dbo.业主表 z ON z.ZH_ID=w.ZH_ID INNER JOIN dbo.室表 s ON s.S_ID=z.S_ID INNER JOIN dbo.楼表 l ON l.L_ID=s.L_ID LEFT JOIN dbo.SETUPSFXM f ON f.DH=w.ZJ_LX LEFT JOIN dbo.收款方式列表 m ON m.id=w.收款方式ID WHERE ${where.join(' AND ')}`;
 return {from,params,address};
}
export function buildMisFeeQuery(q:MisFeeQuery,offices:string[],house?:MisHouseFilter){
 const {from,params,address}=buildMisFeeFilter(q,offices,house);
 const page=q.page??1,pageSize=q.pageSize??50;params.firstRow=(page-1)*pageSize+1;params.lastRow=page*pageSize;
 const sql=`SELECT COUNT_BIG(*) AS total,CONVERT(varchar(50),SUM(CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0 THEN w.ZJ_JE ELSE 0 END),2) AS receivableAmount,CONVERT(varchar(50),SUM(CASE WHEN w.ZJ_SKRQ IS NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0 THEN w.ZJ_JE ELSE 0 END),2) AS unpaidAmount,CONVERT(varchar(50),SUM(CASE WHEN w.ZJ_SKRQ IS NOT NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0 THEN w.ZJ_JE ELSE 0 END),2) AS paidAmount,SUM(CASE WHEN w.ZJ_TKRQ IS NOT NULL THEN 1 ELSE 0 END) AS refundedCount,CONVERT(varchar(19),MAX(w.updatedate),120) AS latestUpdatedAt ${from};
 WITH ranked AS (SELECT ROW_NUMBER() OVER(ORDER BY w.ZJ_CNY DESC,w.ZJ_ID DESC) AS rowNo,CONVERT(varchar(30),w.ZJ_ID) AS id,l.管理处 AS officeCode,${address} AS address,z.姓名 AS ownerName,w.ZJ_LX AS feeCode,f.XM AS feeName,w.ZJ_CNY AS period,CONVERT(varchar(50),w.ZJ_JE,2) AS amount,CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidAt,CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundedAt,w.ZJ_HM AS documentNo,CASE WHEN w.ZJ_SKRQ IS NOT NULL THEN w.凭证号码 ELSE NULL END AS receiptNo,CASE WHEN w.ZJ_SKRQ IS NOT NULL THEN w.发票号码 ELSE NULL END AS invoiceNo,CASE WHEN w.ZJ_SKRQ IS NOT NULL THEN COALESCE(NULLIF(w.收款方式,N''),m.收款方式) ELSE NULL END AS paymentMethod,w.收款人 AS cashier,w.备注 AS remark,CONVERT(varchar(19),w.updatedate,120) AS updatedAt ${from}) SELECT * FROM ranked WHERE rowNo BETWEEN @firstRow AND @lastRow ORDER BY rowNo;`;
 return {sql,params,page,pageSize};
}

export interface MisResidentialQuery extends MisFeeQuery {
 view?: 'dashboard'|'households'|'trend'|'detail'|'communities';
 category?: 'all'|'property'|'berth'|'other';
 houseKeys?: string[];
}
const categorySql = `CASE WHEN f.XM LIKE N'%泊位%' OR f.XM LIKE N'%车位%' THEN 'berth' WHEN f.XM LIKE N'%物业%' THEN 'property' ELSE 'other' END`;
/** No DDL/DML; same source joins/filter as existing MIS bill reader; SQL Server 2008 compatible. */
export function buildMisResidentialQuery(q:MisResidentialQuery,offices:string[]){
 if(q.status!==undefined&&!['paid','unpaid'].includes(q.status))throw new BadRequestException('住宅账单状态仅支持paid或unpaid');
 const view=q.view||'dashboard';
 if(!['dashboard','households','trend','detail','communities'].includes(view))throw new BadRequestException('报表视图不合法');
 if(q.category&&!['all','property','berth','other'].includes(q.category))throw new BadRequestException('收费分类不合法');
 validateMisFeeRange(q);
 if(view==='trend'&&(!q.paidFrom||!q.paidTo))throw new BadRequestException('趋势需指定收款日期范围');
 if(view==='trend'&&(Date.parse(q.paidTo!)-Date.parse(q.paidFrom!))/86400000>366)throw new BadRequestException('收款日期范围不能超过一年');
 const filter:MisFeeQuery={...q,status:undefined,paidFrom:undefined,paidTo:undefined};
 if(view==='trend'){delete filter.periodFrom;delete filter.periodTo;}
 const compiled=buildMisFeeFilter(filter,offices);let from=compiled.from;
 const params=compiled.params,address=compiled.address;
 if(q.category&&q.category!=='all'){params.category=q.category;from+=` AND (${categorySql})=@category`;}
 const houseKey=`CONVERT(varchar(10),l.管理处)+':'+CONVERT(varchar(30),s.S_ID)+':'+CONVERT(varchar(30),z.ZH_ID)`;
 if(q.houseKeys?.length){
  if(q.houseKeys.length>200)throw new BadRequestException('每批最多200户，请按楼栋分批');
  const keys=[...new Set(q.houseKeys)];
  const predicates=keys.map((key,i)=>{const m=/^(0[1-4]):([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(key);if(!m||!offices.includes(m[1]))throw new BadRequestException('所选住户不在查询范围');params[`keyOffice${i}`]=m[1];params[`room${i}`]=m[2];params[`owner${i}`]=m[3];return `(l.管理处=@keyOffice${i} AND s.S_ID=@room${i} AND z.ZH_ID=@owner${i})`;});
  from+=` AND (${predicates.join(' OR ')})`;
 }
 if(view==='detail'){
  if(!q.houseKeys?.length)throw new BadRequestException('请先选择住户');
  return {sql:`SELECT TOP (10001) ${houseKey} AS houseKey,CONVERT(varchar(30),w.ZJ_ID) AS id,l.管理处 AS officeCode,${address} AS address,z.姓名 AS ownerName,z.移动电话 AS phone,w.ZJ_LX AS feeCode,f.XM AS feeName,w.ZJ_CNY AS period,CONVERT(varchar(50),w.ZJ_JE,2) AS amount,CONVERT(varchar(19),w.updatedate,120) AS updatedAt,CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidAt ${from} AND w.ZJ_SKRQ IS ${q.status==='paid'?'NOT ':''}NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0 ORDER BY l.管理处,l.地址2,l.地址3,s.室,z.ZH_ID,w.ZJ_CNY,w.ZJ_LX,w.ZJ_ID;`,params};
 }
 if(view==='trend'){
  params.paidFrom=q.paidFrom!;params.paidTo=q.paidTo!;
  const dateFilter=(column:string)=>`${column}>=CONVERT(datetime,REPLACE(@paidFrom,'-',''),112) AND ${column}<DATEADD(day,1,CONVERT(datetime,REPLACE(@paidTo,'-',''),112))`;
  const safePaid="CASE WHEN ISDATE(w.ZJ_SKRQ)=1 THEN CONVERT(datetime,w.ZJ_SKRQ) ELSE NULL END";
  const safeRefund="CASE WHEN ISDATE(w.ZJ_TKRQ)=1 THEN CONVERT(datetime,w.ZJ_TKRQ) ELSE NULL END";
  return {sql:`WITH flows AS (SELECT CONVERT(varchar(10),${safePaid},23) AS day,w.ZJ_JE AS amount,0 AS refund ${from} AND w.ZJ_JE>=0 AND ${dateFilter(safePaid)} UNION ALL SELECT CONVERT(varchar(10),${safeRefund},23) AS day,-w.ZJ_JE AS amount,1 AS refund ${from} AND w.ZJ_JE>=0 AND w.ZJ_SKRQ IS NOT NULL AND ${dateFilter(safeRefund)}) SELECT day,CONVERT(varchar(50),SUM(amount),2) AS netAmount,CONVERT(varchar(50),SUM(CASE WHEN refund=0 THEN amount ELSE 0 END),2) AS chargedAmount,CONVERT(varchar(50),SUM(CASE WHEN refund=1 THEN -amount ELSE 0 END),2) AS refundedAmount FROM flows GROUP BY day ORDER BY day; SELECT COUNT_BIG(*) AS invalidDateCount ${from} AND ((w.ZJ_SKRQ IS NOT NULL AND ISDATE(w.ZJ_SKRQ)=0) OR (w.ZJ_TKRQ IS NOT NULL AND ISDATE(w.ZJ_TKRQ)=0));`,params};
 }
 const receivable=`CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0 THEN w.ZJ_JE ELSE 0 END`;
 const paid=`CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0 AND w.ZJ_SKRQ IS NOT NULL THEN w.ZJ_JE ELSE 0 END`;
 const unpaid=`CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0 AND w.ZJ_SKRQ IS NULL THEN w.ZJ_JE ELSE 0 END`;
 const amounts=`CONVERT(varchar(50),SUM(${receivable}),2) AS receivableAmount,CONVERT(varchar(50),SUM(${paid}),2) AS paidAmount,CONVERT(varchar(50),SUM(${unpaid}),2) AS unpaidAmount`;
 if(view==='dashboard')return {sql:`SELECT COUNT_BIG(*) AS total,${amounts},COUNT(DISTINCT CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_SKRQ IS NULL AND w.ZJ_JE>0 THEN CONVERT(varchar(10),l.管理处)+':'+CONVERT(varchar(30),s.S_ID) END) AS unpaidHouses,SUM(CASE WHEN w.ZJ_JE<0 THEN 1 ELSE 0 END) AS adjustmentCount ${from}; SELECT w.ZJ_LX AS feeCode,f.XM AS feeName,${categorySql} AS category,${amounts},COUNT(DISTINCT CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_SKRQ IS NULL AND w.ZJ_JE>0 THEN CONVERT(varchar(10),l.管理处)+':'+CONVERT(varchar(30),s.S_ID) END) AS unpaidHouses ${from} GROUP BY w.ZJ_LX,f.XM ORDER BY w.ZJ_LX;`,params};
 if(q.status==='paid')from+=' AND w.ZJ_SKRQ IS NOT NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0';
 else from+=' AND w.ZJ_SKRQ IS NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0';
 const group=`l.管理处,s.S_ID,z.ZH_ID,${address},z.姓名,z.移动电话,l.地址2,l.地址3,s.室`;
 const natural=(col:string)=>`CASE WHEN ${col}<>N'' AND ${col} NOT LIKE '%[^0-9]%' AND LEN(${col})<10 THEN CONVERT(bigint,${col}) ELSE 2147483647 END`;
 const base=`SELECT ${houseKey} AS houseKey,l.管理处 AS officeCode,${address} AS address,z.姓名 AS ownerName,z.移动电话 AS phone,COUNT_BIG(*) AS billCount,CONVERT(varchar(50),SUM(w.ZJ_JE),2) AS amount,MIN(w.ZJ_CNY) AS periodFrom,MAX(w.ZJ_CNY) AS periodTo,ROW_NUMBER() OVER(ORDER BY l.管理处,${natural('l.地址2')},l.地址2,${natural('l.地址3')},l.地址3,${natural('s.室')},s.室,z.ZH_ID) AS rowNo ${from} GROUP BY ${group}`;
 const page=q.page??1,pageSize=q.pageSize??20;params.firstRow=(page-1)*pageSize+1;params.lastRow=page*pageSize;
 return {sql:`SELECT COUNT_BIG(*) AS total,CONVERT(varchar(50),SUM(g.amount),2) AS amount FROM (SELECT SUM(w.ZJ_JE) AS amount ${from} GROUP BY l.管理处,s.S_ID,z.ZH_ID) g; WITH ranked AS (${base}) SELECT * FROM ranked WHERE rowNo BETWEEN @firstRow AND @lastRow ORDER BY rowNo;`,params};
}
