import {CodexReadClient} from './api-client.mjs';

const paths=new Set(['/api/organize','/api/queue','/api/upload','/api/thread','/api/message','/api/interrupt-expected','/api/thread/archive','/api/thread/unarchive']);
export class CodexWriteClient extends CodexReadClient{
 async post(path,body){
  if(!paths.has(path))throw Object.assign(Error('未开放此 Codex 写入接口'),{code:'CODEX_WRITE_UNAVAILABLE',sent:false});
  if(!this.bearer)await this.credentials();
  this.requests++;
  let response,value;
  try{
   response=await this.fetch(this.origin+path,{method:'POST',headers:{authorization:'Bearer '+this.bearer,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(path==='/api/thread'?90000:150000)});
   value=await response.json();
  }catch(cause){throw Object.assign(Error('与 Codex 的操作回执连接中断，请核对原会话后重试'),{code:'NATIVE_OUTCOME_UNKNOWN',outcomeUnknown:true,cause});}
  if(!response.ok)throw Object.assign(Error(value.error||'Codex 操作失败'),value,{statusCode:response.status,code:value.code||'CODEX_WRITE_FAILED',outcomeUnknown:value.outcomeUnknown===true||!!value.threadId||response.status>=500&&value.sent!==false});
  return value;
 }
}
