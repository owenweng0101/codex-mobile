import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const guards=new Map();
const nativeEntry=new Set(['claude-desktop-3p','claude-desktop']);
const errors={
  DESKTOP_CREATE_FAILED:'桌面会话创建或接管失败，消息未投递',
  DESKTOP_ATTACH_FAILED:'无法接管桌面会话，消息未投递',
  DESKTOP_ATTACH_PENDING:'桌面接管尚未确认，本条消息未发送；请稍后沿用原会话，使用新请求编号重试',
  GATEWAY_RESTART_BEFORE_DISPATCH:'网关在投递前重启，本条消息未发送；请使用新请求编号重试，已有会话请沿用原会话',
  DESKTOP_TARGET_MISMATCH:'桌面会话标识不匹配，消息未投递',
  DESKTOP_CHANNEL_UNAVAILABLE:'桌面会话通道不可用，消息未投递',
  DESKTOP_BASELINE_UNAVAILABLE:'无法读取桌面会话投递基线，消息未投递',
  DESKTOP_FOREIGN_WRITER:'当前会话写入者不属于已接管的桌面会话，消息未投递',
  CROSS_SESSION_INBOUND_NOT_ACCEPTED:'桌面会话以 bypassPermissions（完全放行）运行，Claude 会挂起跨会话消息等待桌面确认，手机无法确认送达；本条消息未发送。请在用户级 ~/.claude/settings.json 中添加 "crossSessionInbound": "accept" 后重试。',
  NATIVE_OUTCOME_UNKNOWN:'尚未确认桌面是否收到消息，请查询原请求。若桌面会话是 bypass 权限，需在 ~/.claude/settings.json 设置 "crossSessionInbound": "accept" 才能收下手机消息',
};
const pendingStates=new Set(['dispatched','unknown']);
const confirmationTimeoutMs=30000;
const userSettingsPath=()=>join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'settings.json');

/** Reads the user-level settings file. Injected in tests so no real user file
 * is ever read; a missing file simply means the inbound switch is absent.
 * A malformed file throws JSON.parse's SyntaxError, which the caller treats as
 * "the switch cannot be proven off" instead of a reason to block the send. */
async function readUserSettings(){
  let text;
  try{text=await readFile(userSettingsPath(),'utf8');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  return JSON.parse(text);
}

// A pre-dispatch failure is provably unsent, so the phone must not treat it as
// an unknown delivery it can resend under a new ID without user intent.
function markNotDispatched(error){
  if(!error||(typeof error!=='object'&&typeof error!=='function')||error.notDispatched!==undefined)return error;
  try{error.notDispatched=true;}catch{}
  return error;
}

/**
 * Message delivery only. The server validates readiness, paths, models,
 * attachment IDs and permission modes before calling submit(). No CLI writer
 * or automatic replay exists here. A socket write is NOT a native ACK.
 * recoverStartup() belongs to the server and must run before it accepts requests.
 */
export class DesktopDelivery{
  constructor({ledger,intent,sendPeerMessage,liveSession,readTranscript,sessionFile,statFile=stat,now=Date.now,sleep=delay,setTimer=setTimeout,clearTimer=clearTimeout,ackTimeoutMs=1500,pollMs=100,readUserSettings:readSettings=readUserSettings}={}){
    if(!ledger||!intent||[sendPeerMessage,liveSession,readTranscript,sessionFile,statFile,now,sleep,readSettings].some(fn=>typeof fn!=='function'))throw new TypeError('DesktopDelivery 需要明确注入桌面投递依赖');
    if(!Number.isFinite(ackTimeoutMs)||ackTimeoutMs<0||!Number.isFinite(pollMs)||pollMs<=0)throw new TypeError('无效的确认等待时间');
    Object.assign(this,{ledger,intent,sendPeerMessage,liveSession,readTranscript,sessionFile,statFile,now,sleep,setTimer,clearTimer,readUserSettings:readSettings});
    this.ackTimeoutMs=Math.min(1500,ackTimeoutMs);
    this.pollMs=Math.min(100,pollMs);
  }

  // Shared by instances using the same ledger directory. Only a request ID is
  // serialized; separate messages in one busy session remain independent.
  _guard(requestId,operation){
    const key=this.ledger.dir??this.ledger;
    let requests=guards.get(key);
    if(!requests){requests=new Map();guards.set(key,requests);}
    const id=typeof requestId==='string'?requestId.toLowerCase():requestId;
    const previous=requests.get(id)||Promise.resolve();
    const result=previous.then(operation);
    const tail=result.then(()=>{},()=>{});
    requests.set(id,tail);
    void tail.then(()=>{
      if(requests.get(id)===tail)requests.delete(id);
      if(!requests.size&&guards.get(key)===requests)guards.delete(key);
    });
    return result;
  }

  _public(record){
    if(!record)return null;
    const {requestId,messageId,state,createdAt,updatedAt}=record;
    const delivery=state==='accepted'?'accepted':state==='rejected'?'rejected':state==='unknown'?'unknown':'waiting';
    const errorCode=state==='unknown'?'NATIVE_OUTCOME_UNKNOWN':state==='rejected'?(record.errorCode||'DESKTOP_ATTACH_FAILED'):null;
    return {requestId,messageId,sessionId:record.sessionId??null,desktopSessionId:record.desktopSessionId??null,state,delivery,
      error:errorCode?(errors[errorCode]||'桌面消息未投递'):null,errorCode,uncertain:state==='unknown',
      attachmentDelivery:state==='accepted'?(record.attachmentDelivery??null):null,
      cursor:record.baseline?.cursor??0,baseline:record.baseline?{...record.baseline}:null,createdAt,updatedAt};
  }

  async _unknown(record){
    // Only a command already dispatched to native I/O can have an unknown
    // outcome. Preflight failures must never manufacture a dispatch checkpoint.
    return this.ledger.mark(record.requestId,{state:'unknown',delivery:'unknown',errorCode:'NATIVE_OUTCOME_UNKNOWN',error:errors.NATIVE_OUTCOME_UNKNOWN,uncertain:true});
  }

  async _reject(record,errorCode){
    return this.ledger.mark(record.requestId,{state:'rejected',delivery:'rejected',errorCode,error:errors[errorCode],uncertain:false});
  }

  async _reconcile(record,active=()=>true){
    if(!record||!pendingStates.has(record.state)||!active())return record;
    if(record.state==='unknown'){
      // An unknown command is still checked against the transcript: a queued
      // mid-turn message can be written after the first timeout expired.
      if(!record.sessionId||!active())return record;
    }
    const dispatchedAt=record.dispatchedAt??record.updatedAt;
    const expired=record.state==='dispatched'&&Number.isFinite(dispatchedAt)&&this.now()-dispatchedAt>=confirmationTimeoutMs;
    // The transcript is the authority. Check it before expiring: a message
    // queued behind a long desktop turn may only be written at the boundary.
    if(record.sessionId){
      let transcript=null,readFailed=false;
      try{transcript=await this.readTranscript(record.sessionId);}
      catch{readFailed=true;}
      if(!active())return record;
      const message=Array.isArray(transcript?.messages)?transcript.messages.find(item=>item?.id===record.messageId&&item.role==='user'):null;
      if(message){
        const attachmentIds=Array.isArray(record.attachmentIds)?record.attachmentIds:[];
        // A native materialization prefixes the delivered text with @"<uploads path>"
        // mentions. If that is absent, the desktop received only the Read fallback.
        const native=attachmentIds.length>0&&(
          Array.isArray(message.attachments)&&message.attachments.length>0
          ||typeof message.rawText==='string'&&/(?:^|\s)@"[^"\n]*\/uploads\//.test(message.rawText)
        );
        const attachmentDelivery=attachmentIds.length===0?null:(native?'native':'read-path');
        return this.ledger.mark(record.requestId,{state:'accepted',delivery:'accepted',errorCode:null,error:null,uncertain:false,acceptedAt:this.now(),attachmentDelivery});
      }
      // A busy desktop may legitimately hold the message in its own queue for
      // minutes. Do not turn that into an "unknown" failure the phone has to
      // chase with a manual query; keep waiting until the turn ends.
      if(expired||readFailed){
        let busy=false;
        try{busy=(await this.liveSession(record.sessionId))?.status==='busy';}catch{}
        if(!active())return record;
        if(!busy)return this.ledger.mark(record.requestId,{state:'unknown',delivery:'unknown',errorCode:'NATIVE_OUTCOME_UNKNOWN',error:errors.NATIVE_OUTCOME_UNKNOWN,uncertain:true});
        return this.ledger.mark(record.requestId,{delivery:'waiting',waitingReason:'desktop-busy'});
      }
    }
    return record;
  }

  // A replayed request never dispatches again; it can only read and reconcile.
  // A record that already crossed the durable dispatch checkpoint may be in the
  // desktop, so a reconcile failure must keep its stored state (unknown or the
  // original one) and never surface as a "provably unsent" error: telling the
  // phone that would let the user resend a message that may already be there.
  async _replay(record){
    try{return this._public(await this._reconcile(record));}
    catch(error){
      if(!pendingStates.has(record.state))throw error;
      return this._public(record);
    }
  }

  async _wait(record){
    const deadline=this.now()+this.ackTimeoutMs;
    let budget=this.ackTimeoutMs,active=true,timer;
    const timeout=new Promise(resolve=>{timer=this.setTimer(()=>{active=false;resolve(record);},this.ackTimeoutMs);});
    const poll=async()=>{
      while(active){
        const next=await this._reconcile(record,()=>active);
        if(!active)return record;
        record=next;
        if(!record||record.state!=='dispatched')return record;
        const remaining=Math.min(budget,deadline-this.now());
        if(remaining<=0)return record;
        const wait=Math.min(this.pollMs,remaining);
        await this.sleep(wait);
        budget-=wait; // A frozen injected clock must not cause a busy loop.
      }
      return record;
    };
    try{return await Promise.race([poll(),timeout]);}
    finally{active=false;this.clearTimer(timer);}
  }

  async submit({requestId,sessionId=null,cwd,text,model,permissionMode,permissionExplicit=false,attachments=[],priority='now',prompt,fileAttachments=[]}={}){
    // Snapshot everything that can change native message semantics, including
    // the server-built attachment prompt. Never persist any of it as metadata.
    const payload={sessionId:typeof sessionId==='string'?sessionId.toLowerCase():sessionId,cwd,text,model,mode:permissionMode,...(permissionExplicit?{permissionExplicit:true}:{}),attachments:[...attachments],priority,prompt:prompt||text,fileAttachments};
    return this._guard(requestId,async()=>{
      let dispatched=false;
      try{
        const prepared=await this.ledger.prepare(requestId,payload);
        if(prepared.existing)return this._replay(prepared.record);
        let record=prepared.record;
        const target=payload.sessionId||record.requestId;
        record=await this.ledger.mark(record.requestId,{state:'prepared',sessionId:target,desktopSessionId:null,attachmentIds:payload.attachments,delivery:'waiting',error:null,errorCode:null,uncertain:false});
        let attached;
        try{
          attached=payload.sessionId?await this.intent.attach(target):await this.intent.create({sessionId:record.requestId,cwd:payload.cwd,title:payload.text,model:payload.model,permissionMode:payload.mode});
        }catch(error){
          const errorCode=error?.code==='DESKTOP_PENDING'?'DESKTOP_ATTACH_PENDING':payload.sessionId?'DESKTOP_ATTACH_FAILED':'DESKTOP_CREATE_FAILED';
          record=await this.ledger.mark(record.requestId,{state:'rejected',delivery:'rejected',errorCode,error:errors[errorCode],uncertain:false});
          return this._public(record);
        }
        if(attached?.sessionId!==target){
          record=await this.ledger.mark(record.requestId,{state:'rejected',delivery:'rejected',errorCode:'DESKTOP_TARGET_MISMATCH',error:errors.DESKTOP_TARGET_MISMATCH,uncertain:false});
          return this._public(record);
        }
        record=await this.ledger.mark(record.requestId,{state:'prepared',desktopSessionId:attached.desktopSessionId??null});
        // A bypassPermissions target makes the desktop CLI hold peer messages
        // for approval unless the user-level settings file opts in. Detect it
        // before dispatch: otherwise the phone waits 30s and ends up "unknown".
        // Only a settings file that parsed and clearly lacks "accept" blocks the
        // send. A malformed file (JSON.parse's SyntaxError) proves nothing, so
        // keep dispatching and let the CLI policy decide; read errors keep the
        // strict preflight because they never were a supported configuration.
        const targetMode=typeof attached.permissionMode==='string'?attached.permissionMode:(payload.sessionId?null:payload.mode);
        if(targetMode==='bypassPermissions'){
          let settings=null,unparsable=false;
          try{settings=await this.readUserSettings();}
          catch(error){unparsable=error?.name==='SyntaxError';}
          if(!unparsable&&settings?.crossSessionInbound!=='accept')return this._public(await this._reject(record,'CROSS_SESSION_INBOUND_NOT_ACCEPTED'));
        }
        let live,baseline;
        try{live=await this.liveSession(target);}
        catch{return this._public(await this._reject(record,'DESKTOP_CHANNEL_UNAVAILABLE'));}
        if(!live?.socketPath)return this._public(await this._reject(record,'DESKTOP_CHANNEL_UNAVAILABLE'));
        if(!nativeEntry.has(live.entrypoint)||typeof attached.desktopSessionId!=='string'||!attached.desktopSessionId||live.hostSessionId!==attached.desktopSessionId)return this._public(await this._reject(record,'DESKTOP_FOREIGN_WRITER'));
        try{
          const transcript=await this.readTranscript(target);
          const entry=await this.sessionFile(target);
          if(!entry?.path||!Array.isArray(transcript?.messages)||!Number.isFinite(transcript.cursor))throw new Error('Missing native baseline');
          const info=await this.statFile(entry.path);
          if(!Number.isSafeInteger(info?.size)||info.size<0)throw new Error('Invalid native baseline');
          baseline={cursor:transcript.cursor,startSize:info.size};
        }catch{return this._public(await this._reject(record,'DESKTOP_BASELINE_UNAVAILABLE'));}
        // Do not catch ledger failures and continue: this checkpoint must finish
        // before the socket is touched. Its fingerprint/identity never change.
        // The peer policy compares permission-mode classes. A prompting sender
        // into a bypassPermissions target is held for desktop approval, which is
        // not a delivery this gateway can complete. Match the target's class so
        // the user's own phone message reaches the session they are looking at.
        const fromMode=attached?.permissionMode==='bypassPermissions'?'bypass':'prompting';
        record=await this.ledger.mark(record.requestId,{state:'dispatched',baseline,dispatchedAt:this.now()});
        dispatched=true;
        try{
          await this.sendPeerMessage({...live,msgId:record.messageId,text:payload.prompt,priority:payload.priority,fromMode,fileAttachments:payload.fileAttachments,...(!payload.sessionId?{name:payload.text}:{} )});
        }catch{return this._public(await this._unknown(record));}
        return this._public(await this._wait(record));
      }catch(error){
        // Only pre-dispatch failures are provably unsent. Anything after the
        // dispatched checkpoint keeps the unknown outcome instead.
        if(!dispatched)markNotDispatched(error);
        throw error;
      }
    });
  }

  // Startup: finish the durable dispatch decision before the gateway accepts
  // requests. recover() closes every prepared/dispatched record; a record that
  // had been dispatched is then confirmed against the native transcript. A
  // failed read or an ambiguous owner keeps the conservative unknown state.
  async recoverStartup({active=()=>true}={}){
    const recovered=await this.ledger.recover();
    const results=[];
    for(const record of recovered){
      if(record.state!=='unknown'){results.push(record);continue;}
      let next=record;
      try{next=await this._reconcile(record,active);}
      catch{next=record;}
      results.push(next);
    }
    return results;
  }

  async status(requestId){
    return this._guard(requestId,async()=>this._public(await this._reconcile(await this.ledger.get(requestId))));
  }

  async get(requestId){return this.status(requestId);}
  async reconcile(requestId){return this.status(requestId);}
}
