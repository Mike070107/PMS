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
 if((q.page!==undefined&&(!Number.isInteger(q.page)||q.page<1||q.page>1000000))||(q.pageSize!==undefined&&(!Number.isInteger(q.pageSize)||q.pageSize<1||q.pageSize>500)))throw new BadRequestException('分页参数不合法');
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
export function buildMisFeeQuery(q:MisFeeQuery,offices:string[],house?:MisHouseFilter){
 validateMisFeeRange(q);
 if(!offices.length||offices.some(x=>!['01','02','03','04'].includes(x)))throw new BadRequestException('MIS小区范围不合法');
 const params:Record<string,string|number>={};
 const where=[`l.管理处 IN (${offices.map((o,i)=>{params[`office${i}`]=o;return `@office${i}`;}).join(',')})`,`ISNULL(w.SC,N'0')=N'0'`];
 for(const [key,op,column] of [['periodFrom','>=','w.ZJ_CNY'],['periodTo','<=','w.ZJ_CNY']] as const)if(q[key]){params[key]=q[key]!;where.push(`${column}${op}@${key}`);}
 if(q.paidFrom){params.paidFrom=q.paidFrom;where.push('w.ZJ_SKRQ>=CONVERT(datetime,@paidFrom,23)');}
 if(q.paidTo){params.paidTo=q.paidTo;where.push('w.ZJ_SKRQ<DATEADD(day,1,CONVERT(datetime,@paidTo,23))');}
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
 const page=q.page??1,pageSize=q.pageSize??50;params.firstRow=(page-1)*pageSize+1;params.lastRow=page*pageSize;
 const sql=`SELECT COUNT_BIG(*) AS total,CONVERT(varchar(50),SUM(CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0 THEN w.ZJ_JE ELSE 0 END),2) AS receivableAmount,CONVERT(varchar(50),SUM(CASE WHEN w.ZJ_SKRQ IS NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>0 THEN w.ZJ_JE ELSE 0 END),2) AS unpaidAmount,CONVERT(varchar(50),SUM(CASE WHEN w.ZJ_SKRQ IS NOT NULL AND w.ZJ_TKRQ IS NULL AND w.ZJ_JE>=0 THEN w.ZJ_JE ELSE 0 END),2) AS paidAmount,SUM(CASE WHEN w.ZJ_TKRQ IS NOT NULL THEN 1 ELSE 0 END) AS refundedCount,CONVERT(varchar(19),MAX(w.updatedate),120) AS latestUpdatedAt ${from};
 WITH ranked AS (SELECT ROW_NUMBER() OVER(ORDER BY w.ZJ_CNY DESC,w.ZJ_ID DESC) AS rowNo,CONVERT(varchar(30),w.ZJ_ID) AS id,l.管理处 AS officeCode,${address} AS address,z.姓名 AS ownerName,w.ZJ_LX AS feeCode,f.XM AS feeName,w.ZJ_CNY AS period,CONVERT(varchar(50),w.ZJ_JE,2) AS amount,CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidAt,CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundedAt,w.ZJ_HM AS documentNo,CASE WHEN w.ZJ_SKRQ IS NOT NULL THEN w.凭证号码 ELSE NULL END AS receiptNo,CASE WHEN w.ZJ_SKRQ IS NOT NULL THEN w.发票号码 ELSE NULL END AS invoiceNo,CASE WHEN w.ZJ_SKRQ IS NOT NULL THEN COALESCE(NULLIF(w.收款方式,N''),m.收款方式) ELSE NULL END AS paymentMethod,w.收款人 AS cashier,w.备注 AS remark,CONVERT(varchar(19),w.updatedate,120) AS updatedAt ${from}) SELECT * FROM ranked WHERE rowNo BETWEEN @firstRow AND @lastRow ORDER BY rowNo;`;
 return {sql,params,page,pageSize};
}
