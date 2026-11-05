import {Injectable,OnModuleDestroy} from '@nestjs/common';
import {MisPostingCommand,MisPostingError,createMssqlPostingDriver,executeMisPosting,inspectMisPosting} from './mis-posting.util';
/** Separate lazy write boundary; importing/starting the application never connects or writes. */
@Injectable()
export class MisPostingConnector implements OnModuleDestroy{
 private poolPromise:Promise<any>|null=null;
 private async driver(){
  if(!process.env.MIS_FEES_USER||!process.env.MIS_FEES_PASSWORD||!process.env.MIS_FEES_TENANT_ID)throw new MisPostingError('MIS服务端连接未配置','refused');
  if(!this.poolPromise){const sql=require('mssql');const e=process.env;const pool=new sql.ConnectionPool({server:e.MIS_FEES_SERVER||'wjwy.mis.shxwit.com',port:Number(e.MIS_FEES_PORT||1533),database:e.MIS_FEES_DATABASE||'MIS吴泾物业',user:e.MIS_FEES_USER,password:e.MIS_FEES_PASSWORD,connectionTimeout:8000,requestTimeout:15000,pool:{min:0,max:2,idleTimeoutMillis:30000,acquireTimeoutMillis:8000},options:{encrypt:true,trustServerCertificate:e.MIS_FEES_TRUST_CERTIFICATE==='true',tdsVersion:'7_3_B',appName:'PMS-MIS-Posting',...(e.MIS_FEES_LEGACY_TLS==='true'?{cryptoCredentialsDetails:{minVersion:'TLSv1',ciphers:'DEFAULT@SECLEVEL=0'}}:{})}});pool.on('error',()=>{this.poolPromise=null;void pool.close().catch(()=>{})});this.poolPromise=pool.connect().catch(async()=>{this.poolPromise=null;await pool.close().catch(()=>{});throw new MisPostingError('MIS连接未完成，请核查原单后重试','not_posted')});}
  return createMssqlPostingDriver(await this.poolPromise);
 }
 async post(command:MisPostingCommand){if(process.env.MIS_POSTING_MODE!=='on')throw new MisPostingError('MIS正式写入未启用，未修改源库','refused');return executeMisPosting(command,await this.driver(),true);}
 async inspect(command:MisPostingCommand){return inspectMisPosting(command,await this.driver());}
 async onModuleDestroy(){const p=this.poolPromise;this.poolPromise=null;if(p)await p.then(pool=>pool.close()).catch(()=>{});}
}

