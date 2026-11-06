import {BadRequestException} from '@nestjs/common';import {MisFeeQuery,MisHouseFilter,buildMisFeeFilter} from './mis-fees.query';
export interface MisLedgerAddress extends MisHouseFilter{offices?:string[];buildingOnly?:boolean}
export interface MisLedgerQuery extends MisFeeQuery{view?:'list'|'stats'}
/** MIS实收原账只读投影；负数调整按原值计入，退款标记不是独立退款资金流水。 */
export function buildMisLedgerQuery(q:MisLedgerQuery,offices:string[],addresses?:MisLedgerAddress[]){
 const page=q.page??1,pageSize=q.pageSize??20;if(![20,50,100].includes(pageSize))throw new BadRequestException('流水分页仅支持20、50、100条');if(q.houseId)throw new BadRequestException('流水请使用授权小区与地址筛选');if(q.view&&!['list','stats'].includes(q.view))throw new BadRequestException('流水视图不合法');
 if(q.view==='stats'&&(!q.paidFrom||!q.paidTo||(Date.parse(q.paidTo)-Date.parse(q.paidFrom))/86400000>366))throw new BadRequestException('统计需指定一年以内的收款日期范围');
 const compiled=buildMisFeeFilter(addresses?{...q,q:undefined}:q,offices);let from=compiled.from+' AND w.ZJ_SKRQ IS NOT NULL';const params:Record<string,string|number>={...compiled.params,firstRow:(page-1)*pageSize+1,lastRow:page*pageSize};
 if(addresses){if(addresses.length>120)throw new BadRequestException('地址命中过多，请补充小区或楼栋');const clauses=addresses.map((address,i)=>{if(!address.road)throw new BadRequestException('房屋缺少路名，无法安全匹配MIS地址');const scoped=address.offices?.filter(o=>offices.includes(o))??offices;if(!scoped.length)return'1=0';const part=buildMisFeeFilter({},scoped,address);for(const[k,v]of Object.entries(part.params))params[`address${i}_${k}`]=v;let predicate=part.from.split(' WHERE ')[1];if(address.buildingOnly&&!address.shop)predicate=predicate.replace(' AND s.室=@houseRoom','');return'('+predicate.replace(/@(\w+)/g,(_all,k)=>`@address${i}_${k}`)+')'});from+=clauses.length?` AND (${clauses.join(' OR ')})`:' AND 1=0';}
 const paid="CASE WHEN w.ZJ_TKRQ IS NULL THEN w.ZJ_JE ELSE 0 END",adjustment="CASE WHEN w.ZJ_TKRQ IS NULL AND w.ZJ_JE<0 THEN w.ZJ_JE ELSE 0 END",refunded="CASE WHEN w.ZJ_TKRQ IS NOT NULL THEN ABS(w.ZJ_JE) ELSE 0 END";
 const summary=`SELECT COUNT_BIG(*) AS total,CONVERT(varchar(50),SUM(${paid}),2) AS paidNetAmount,CONVERT(varchar(50),SUM(${adjustment}),2) AS adjustmentAmount,CONVERT(varchar(50),SUM(${refunded}),2) AS refundedOriginalAmount ${from};`;
 if(q.view==='stats'){
  const method="COALESCE(NULLIF(w.收款方式,N''),m.收款方式,N'未记录')",day='CONVERT(varchar(10),w.ZJ_SKRQ,23)';
  const grouped=(key:string,name:string,by:string)=>`SELECT ${key} AS [key],${name} AS name,COUNT_BIG(*) AS count,CONVERT(varchar(50),SUM(${paid}),2) AS amount,CONVERT(varchar(50),SUM(${adjustment}),2) AS adjustmentAmount ${from} GROUP BY ${by} ORDER BY ${key};`;
  return{sql:summary+grouped('w.ZJ_LX',"MAX(COALESCE(f.XM,N'未命名费项'))",'w.ZJ_LX')+grouped(method,method,method)+grouped('w.收款人',"COALESCE(NULLIF(w.收款人,N''),N'未记录')",'w.收款人')+grouped(day,day,day),params,page,pageSize};
 }
 const list=`WITH ranked AS(SELECT ROW_NUMBER() OVER(ORDER BY w.ZJ_SKRQ DESC,w.ZJ_ID DESC) AS rowNo,CONVERT(varchar(30),w.ZJ_ID) AS id,l.管理处 AS officeCode,${compiled.address} AS address,z.姓名 AS ownerName,w.ZJ_LX AS feeCode,f.XM AS feeName,w.ZJ_CNY AS period,CONVERT(varchar(50),w.ZJ_JE,2) AS amount,CONVERT(varchar(10),w.ZJ_SKRQ,23) AS paidAt,CONVERT(varchar(10),w.ZJ_TKRQ,23) AS refundedAt,w.凭证号码 AS receiptNo,COALESCE(NULLIF(w.收款方式,N''),m.收款方式) AS paymentMethod,w.收款人 AS cashier,w.备注 AS remark ${from}) SELECT * FROM ranked WHERE rowNo BETWEEN @firstRow AND @lastRow ORDER BY rowNo;`;
 return{sql:summary+list,params,page,pageSize};
}
