import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {desktopCatalog,readMarker} from './sessions.mjs';
import {readDesktopUnread} from './desktop-unread.mjs';

const execute=promisify(execFile);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure=(status,code,message)=>Object.assign(Error(message),{statusCode:status,code});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const replyKey=version=>version.split(':')[0];
const resumeNative=id=>execute('/usr/bin/open',['-b','com.anthropic.claudefordesktop','claude://resume?session='+encodeURIComponent(id)],{timeout:5000});
const desktopRunning=async()=>{try{await execute('/usr/bin/pgrep',['-x','Claude']);return true;}catch{return false;}};

/** Reuse the App's existing-session entry point. The App itself owns the unread
 * mutation; success is determined by a fresh native-state read, never by open's
 * exit status or a phone-local receipt. Opening follows the same session on Mac.
 * Read commands are persisted before dispatch and never replayed after restart.
 */
export class NativeRead {
  constructor({stateDir=join(homedir(),'Library/Application Support/ClaudeMobile'),catalog=desktopCatalog,unread=()=>readDesktopUnread({withRevision:true}),resume=resumeNative,isRunning=desktopRunning,timeoutMs=12000,intervalMs=400,now=Date.now,sleep=pause}={}){
    Object.assign(this,{dir:join(stateDir,'native-read-commands'),catalog,unread,resume,isRunning,timeoutMs,intervalMs,now,sleep});
    this.tail=Promise.resolve();this.inflight=new Map();
  }
  acknowledge(input){
    try{this.validate(input);}catch(error){return Promise.reject(error);}
    const signature=JSON.stringify([input.sessionId,input.desktopSessionId,input.unreadVersion]);
    const active=this.inflight.get(input.requestId);
    if(active)return active.signature===signature?active.promise:Promise.reject(failure(409,'READ_ID_CONFLICT','这条已读请求与原请求不一致，请重新打开会话。'));
    const payload={requestId:input.requestId,sessionId:input.sessionId,desktopSessionId:input.desktopSessionId,unreadVersion:input.unreadVersion};
    const promise=this.tail.then(()=>this.run(payload,signature));this.tail=promise.catch(()=>{});
    this.inflight.set(input.requestId,{signature,promise});
    void promise.finally(()=>{if(this.inflight.get(input.requestId)?.promise===promise)this.inflight.delete(input.requestId);}).catch(()=>{});
    return promise;
  }
  validate(input){
    if(!input||!UUID.test(input.requestId??'')||!UUID.test(input.sessionId??'')||typeof input.desktopSessionId!=='string'||!/^local_[\w-]{1,80}$/.test(input.desktopSessionId)||typeof input.unreadVersion!=='string'||!input.unreadVersion||input.unreadVersion.length>220)
      throw failure(400,'INVALID_READ_REQUEST','已读请求无效，请重新打开会话。');
  }
  async snapshot(input){
    const [catalog,dots]=await Promise.all([this.catalog(),this.unread()]);
    const item=catalog.find(item=>item.cliSessionId===input.sessionId);
    if(!item||item.sessionId!==input.desktopSessionId)throw failure(409,'READ_TARGET_CHANGED','电脑端会话已变化，请重新打开。');
    if(!dots.known)throw failure(503,'NATIVE_READ_UNKNOWN','暂时无法确认电脑端已读状态，请重试。');
    const marker=readMarker(item,dots);
    if(replyKey(marker.unreadVersion)!==replyKey(input.unreadVersion))throw failure(409,'READ_REPLY_CHANGED','已有新回复，请先读取最新内容。');
    return marker;
  }
  async load(id){
    try{return JSON.parse(await readFile(join(this.dir,id+'.json'),'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw failure(503,'READ_RECORD_UNAVAILABLE','暂时无法核对已读请求，请稍后重试。');}
  }
  async save(record,create=false){
    await mkdir(this.dir,{recursive:true,mode:0o700});
    const target=join(this.dir,record.requestId+'.json'),temporary=create?target:target+'.'+randomUUID()+'.tmp';
    const file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
    if(!create){try{await rename(temporary,target);}finally{await unlink(temporary).catch(()=>{});}}
  }
  receipt(input,marker){return {ok:true,verified:true,unread:false,requestId:input.requestId,sessionId:input.sessionId,desktopSessionId:input.desktopSessionId,unreadVersion:marker.unreadVersion};}
  async confirm(record,marker){
    const receipt=this.receipt(record,marker),next={...record,state:'confirmed',receipt,confirmedAt:this.now()};
    const original=await this.load(record.requestId);
    if(original&&original.signature!==record.signature)throw failure(409,'READ_ID_CONFLICT','这条已读请求与原请求不一致。');
    if(!original){
      try{await this.save(next,true);return receipt;}catch(error){if(error.code!=='EEXIST')throw error;}
      const winner=await this.load(record.requestId);
      if(winner?.signature!==record.signature)throw failure(409,'READ_ID_CONFLICT','这条已读请求与原请求不一致。');
    }
    await this.save(next);return receipt;
  }

  async run(input,signature){
    let record=await this.load(input.requestId);
    if(record&&record.signature!==signature)throw failure(409,'READ_ID_CONFLICT','这条已读请求与原请求不一致，请重新打开会话。');
    let marker=await this.snapshot(input);
    if(!marker.unread){
      record??={...input,signature,state:'confirmed'};
      return this.confirm(record,marker);
    }
    if(marker.unreadVersion!==input.unreadVersion)throw failure(409,'READ_STATE_CHANGED','电脑端状态已更新，请读取最新内容后重试。');
    // A previously dispatched request may still complete. Re-read only; do not
    // navigate the desktop again after a lost HTTP reply or a gateway restart.
    if(record)return this.observe(record);
    if(!await this.isRunning())throw failure(503,'DESKTOP_NOT_RUNNING','请先打开电脑端 Claude，再同步已读状态。');
    // Revalidate after waiting for the App and before the only native action.
    marker=await this.snapshot(input);
    if(!marker.unread)return this.confirm({...input,signature,state:'confirmed'},marker);
    if(marker.unreadVersion!==input.unreadVersion)throw failure(409,'READ_STATE_CHANGED','电脑端状态已更新，请读取最新内容后重试。');
    record={...input,signature,state:'dispatched',dispatchedAt:this.now()};
    try{await this.save(record,true);}catch(error){
      if(error.code!=='EEXIST')throw error;
      const original=await this.load(input.requestId);
      if(original?.signature!==signature)throw failure(409,'READ_ID_CONFLICT','这条已读请求与原请求不一致。');
      return this.observe(original);
    }
    try{await this.resume(input.sessionId);}catch{
      // open may have handed the URL off before reporting an error. Its result
      // cannot authorize a replay, nor can it serve as a read receipt.
    }
    return this.observe(record);
  }
  async observe(record){
    const deadline=this.now()+this.timeoutMs;
    do{
      const marker=await this.snapshot(record);
      if(!marker.unread)return this.confirm(record,marker);
      if(this.now()>=deadline)break;
      await this.sleep(this.intervalMs);
    }while(true);
    return {ok:false,verified:false,unread:true,pending:true,requestId:record.requestId,sessionId:record.sessionId,desktopSessionId:record.desktopSessionId,error:'电脑端尚未确认已读，请稍后重试。'};
  }
}
