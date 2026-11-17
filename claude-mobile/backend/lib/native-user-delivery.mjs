import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {NATIVE_USER_TRANSPORT} from './native-user-bridge.mjs';
import {phoneImageReferences,phoneAttachmentNote,PHONE_IMAGE_ERRORS} from './phone-images.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=text=>createHash('sha256').update(text).digest('hex');
const errors={
  NATIVE_INPUT_NOT_CONNECTED:'桌面原生输入扩展尚未连接，本条消息未发送；请在桌面重新加载插件后重试',
  NATIVE_INPUT_REJECTED:'桌面没有接收这条输入，消息未发送',
  NATIVE_PREPARE_FAILED:'发送准备没有完成，这条消息确定未发送；可以沿用原会话重新发送',
  NATIVE_CLAIM_ABANDONED:'连接恢复时已取消尚未进入引擎的输入；这条消息未发送，可以重试',
  NATIVE_OWNER_CHANGED:'桌面会话在发送前重新连接，这条消息未发送；请沿用原会话重试',
  NATIVE_OUTCOME_UNKNOWN:'尚未确认电脑是否收到这条消息，正在核对原请求；不会自动重复发送',
  NATIVE_ATTACHMENTS_UNSUPPORTED:'原生输入不接收结构化附件，请从手机上传图片后以文件引用发送',
  ...PHONE_IMAGE_ERRORS,
  NATIVE_SLASH_UNSUPPORTED:'手机原生输入暂不执行斜杠命令，请在电脑端执行；消息未发送',
  DESKTOP_CREATE_FAILED:'无法创建桌面原生会话，消息未发送',
  DESKTOP_ATTACH_FAILED:'无法打开原桌面会话，消息未发送',
  DESKTOP_TARGET_MISMATCH:'桌面会话标识不匹配，消息未发送',
  DESKTOP_BASELINE_UNAVAILABLE:'无法读取原生会话基线，消息未发送',
  NATIVE_QUEUE_FULL:'当前会话待发消息过多，请等待已发送消息处理',
  GATEWAY_RESTART_BEFORE_DISPATCH:'连接服务在投递前重启，这条消息确定未发送；可沿用原会话重新发送',
};
const guards=new Map();

/** Read raw, append-only native bytes, never a hydrated/mobile display cache. */
export async function findNativeUserProof({path,nativeMessageId,textHash,startSize=0,sessionId,signal}={}){
  if(signal?.aborted||!path||!UUID.test(nativeMessageId??'')||!/^[a-f0-9]{64}$/.test(textHash??''))return {verified:false};
  const info=await stat(path);
  const start=Number.isSafeInteger(startSize)&&startSize>=0&&startSize<=info.size?startSize:0;
  const stream=createReadStream(path,{start,encoding:'utf8',signal});
  let pending='',skipping=false;
  const inspect=line=>{
    let row;try{row=JSON.parse(line);}catch{return null;}
    if(row.uuid!==nativeMessageId)return null;
    if(row.type!=='user'||row.message?.role!=='user'||row.isMeta||row.isSidechain||row.sessionId!==sessionId)return {verified:false,reason:'NOT_NATIVE_USER'};
    const origin=row.origin;
    if(origin?.kind!=='plugin'||origin.asUser!==true||!/^mobile-native-bridge(?:@[^\s]+)?$/.test(origin.name??''))return {verified:false,reason:'WRONG_INPUT_ORIGIN'};
    const content=row.message.content;
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter(block=>block?.type==='text').map(block=>block.text??'').join('\n'):null;
    if(typeof text!=='string'||hash(text)!==textHash)return {verified:false,reason:'INPUT_TEXT_CHANGED'};
    return {verified:true,nativeMessageId,origin:{kind:'plugin',name:origin.name,asUser:true},timestamp:row.timestamp??null};
  };
  try{
    for await(const chunk of stream){
      pending+=chunk;
      let at;
      while((at=pending.indexOf('\n'))!==-1){
        const line=pending.slice(0,at);pending=pending.slice(at+1);
        if(skipping){skipping=false;continue;}
        const proof=inspect(line);if(proof)return proof;
      }
      // Native text input is bounded by the public API. Unrelated huge base64
      // rows are skipped, never truncated and accepted as the target message.
      if(pending.length>1024*1024){pending='';skipping=true;}
    }
    // A half-written final line is deliberately not an acknowledgement. A
    // rewritten file can grow past the old byte offset; UUID proof must then
    // search from zero, under the caller's hard read deadline.
    return start>0&&!signal?.aborted?findNativeUserProof({path,nativeMessageId,textHash,startSize:0,sessionId,signal}):{verified:false};
  }finally{stream.destroy();}
}

/** Owns operation IDs, not the desktop writer or its generated message IDs. */
export class NativeUserDelivery{
  constructor({ledger,intent,bridge,readTranscript,sessionFile,legacy,uploadsDir,statFile=stat,readProof=findNativeUserProof,now=Date.now,sleep=delay,ackTimeoutMs=1200,pollMs=100}={}){
    if(!ledger||!intent||!bridge||typeof readTranscript!=='function'||typeof sessionFile!=='function')throw new TypeError('原生用户投递缺少依赖');
    Object.assign(this,{ledger,intent,bridge,readTranscript,sessionFile,legacy,uploadsDir,statFile,readProof,now,sleep});
    this.ackTimeoutMs=Math.max(0,Math.min(1500,ackTimeoutMs));this.pollMs=Math.max(1,pollMs);
  }

  _guard(requestId,operation){
    const key=this.ledger.dir+'\0'+String(requestId).toLowerCase();
    const previous=guards.get(key)||Promise.resolve();
    const result=previous.then(operation),tail=result.then(()=>{},()=>{});
    guards.set(key,tail);void tail.then(()=>{if(guards.get(key)===tail)guards.delete(key);});
    return result;
  }

  _public(record){
    if(!record)return null;
    const state=record.state,delivery=state==='accepted'?'accepted':state==='rejected'?'rejected':state==='unknown'?'unknown':'waiting';
    const errorCode=state==='unknown'?'NATIVE_OUTCOME_UNKNOWN':state==='rejected'?(record.errorCode||'NATIVE_INPUT_REJECTED'):null;
    return {requestId:record.requestId,messageId:record.nativeMessageId??record.messageId,nativeMessageId:record.nativeMessageId??null,
      sessionId:record.sessionId??null,desktopSessionId:record.desktopSessionId??null,state,delivery,
      transport:NATIVE_USER_TRANSPORT,inputProvenance:'plugin-as-user',queueMode:'next',
      errorCode,error:errorCode?(errors[errorCode]||'原生消息尚未发送'):null,uncertain:state==='unknown',
      notDispatched:state==='rejected'&&(record.nativeNotSubmitted===true||!Object.hasOwn(record,'dispatchedAt')),cursor:record.baseline?.cursor??0,
      // Acceptance proves the native text append, not that Read opened an image.
      baseline:record.baseline??null,attachmentDelivery:record.attachmentDelivery==='file-reference'?'file-reference':null,createdAt:record.createdAt,updatedAt:record.updatedAt};
  }

  async _reject(record,errorCode){
    return this.ledger.mark(record.requestId,{state:'rejected',errorCode,error:errors[errorCode]||'原生消息未发送',uncertain:false},{ifState:record.state});
  }

  async _reconcile(record,active=()=>true,signal){
    if(!active())return record;
    const preparing=record&&guards.has(this.ledger.dir+'\0'+record.requestId);
    if(record?.transport===NATIVE_USER_TRANSPORT&&record.state==='prepared'&&!preparing&&!this.bridge.hasPending(record.requestId))return this._reject(record,'NATIVE_PREPARE_FAILED');
    if(!record||record.transport!==NATIVE_USER_TRANSPORT||!['dispatched','unknown'].includes(record.state)||!record.nativeMessageId)return record;
    try{
      const entry=await this.sessionFile(record.sessionId);
      if(!active())return record;
      const proof=await this.readProof({path:entry?.path,nativeMessageId:record.nativeMessageId,textHash:record.textHash,startSize:record.baseline?.startSize??0,sessionId:record.sessionId,signal});
      if(proof.verified&&active())return this.ledger.mark(record.requestId,{state:'accepted',acceptedAt:this.now(),nativeOrigin:proof.origin,error:null,errorCode:null,uncertain:false},{ifState:record.state});
    }catch{/* Native I/O failed: preserve the uncertain/queued operation. */}
    return record;
  }

  async _readBounded(requestId,initial=null,waitForAck=false){
    if(waitForAck&&this.ackTimeoutMs===0)return this._public(initial);
    const limit=waitForAck?this.ackTimeoutMs:1500,abort=new AbortController();
    let latest=initial,active=true,timer;
    const fallback=()=>this._public(latest??{requestId,messageId:requestId,state:'unknown'});
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>{active=false;abort.abort();resolve(fallback());},limit);});
    const work=(async()=>{
      for(;;){
        const record=await this.ledger.get(requestId);
        if(!active)return fallback();
        latest=record;
        if(record&&record.transport!==NATIVE_USER_TRANSPORT&&this.legacy){
          if(record.state==='prepared'&&!guards.has(this.ledger.dir+'\0'+record.requestId)&&!this.bridge.hasPending(record.requestId)){
            latest=await this._reject(record,'NATIVE_PREPARE_FAILED');
            return this._public(latest);
          }
          const value=await this.legacy.status(record.requestId);
          return {...value,notDispatched:value?.state==='rejected'&&!Object.hasOwn(record,'dispatchedAt')};
        }
        latest=await this._reconcile(record,()=>active,abort.signal);
        if(!active)return fallback();
        if(!waitForAck||!latest||['accepted','rejected','unknown'].includes(latest.state))return this._public(latest);
        await this.sleep(this.pollMs);
      }
    })();
    try{return await Promise.race([work,timeout]);}
    catch{return fallback();}
    finally{active=false;clearTimeout(timer);abort.abort();}
  }

  _wait(record){return this._readBounded(record.requestId,record,true);}

  async submit(args={}){
    const {requestId,sessionId=null,cwd,text,model,permissionMode,permissionExplicit=false,attachments=[],priority='now',prompt,fileAttachments=[],clientRequestHash}=args;
    // Keep the immutable fingerprint's old shape for existing operation IDs.
    const payload={sessionId:typeof sessionId==='string'?sessionId.toLowerCase():sessionId,cwd,text,model,mode:permissionMode,...(permissionExplicit?{permissionExplicit:true}:{}),attachments:[...attachments],priority,prompt:prompt||text,fileAttachments};
    return this._guard(requestId,async()=>{
      const prepared=await this.ledger.prepare(requestId,payload);
      if(prepared.existing){
        if(prepared.record.transport!==NATIVE_USER_TRANSPORT&&this.legacy)return this.legacy.status(prepared.record.requestId);
        return this._public(await this._reconcile(prepared.record));
      }
      let record=await this.ledger.mark(prepared.record.requestId,{transport:NATIVE_USER_TRANSPORT,sessionId:payload.sessionId,...(clientRequestHash?{clientRequestHash}:{}),
        attachmentIds:[...attachments],attachmentDelivery:attachments.length?'file-reference':null,
        // Private display data only; native proof always uses the submitted text.
        ...(attachments.length?{attachmentText:text}:{})});
      if(fileAttachments.length)return this._public(await this._reject(record,'NATIVE_ATTACHMENTS_UNSUPPORTED'));
      if(text.trimStart().startsWith('/'))return this._public(await this._reject(record,'NATIVE_SLASH_UNSUPPORTED'));
      let nativeText=text;
      if(attachments.length){
        try{
          // Resolve only after prepare's existing-operation check. Missing or
          // changed uploads must never turn a prior send into a fresh rejection.
          const images=await phoneImageReferences(attachments,{uploadsDir:this.uploadsDir});
          const note=phoneAttachmentNote(images.map(image=>image.path));
          nativeText=text?text+note:note.trimStart();
        }catch(error){return this._public(await this._reject(record,Object.hasOwn(PHONE_IMAGE_ERRORS,error?.code)?error.code:'PHONE_IMAGE_UNAVAILABLE'));}
      }
      record=await this.ledger.mark(record.requestId,{textHash:hash(nativeText),sessionId:payload.sessionId||record.requestId});
      let attached;
      try{
        attached=payload.sessionId?await this.intent.attach(record.sessionId):await this.intent.create({sessionId:record.sessionId,cwd,title:text.trim()||'图片',model,permissionMode});
      }catch{return this._public(await this._reject(record,payload.sessionId?'DESKTOP_ATTACH_FAILED':'DESKTOP_CREATE_FAILED'));}
      if(attached?.sessionId!==record.sessionId||!attached.desktopSessionId)return this._public(await this._reject(record,'DESKTOP_TARGET_MISMATCH'));
      record=await this.ledger.mark(record.requestId,{desktopSessionId:attached.desktopSessionId});
      try{await this.bridge.waitForSession(record.sessionId,record.desktopSessionId);}
      catch{return this._public(await this._reject(record,'NATIVE_INPUT_NOT_CONNECTED'));}
      try{
        const transcript=await this.readTranscript(record.sessionId),entry=await this.sessionFile(record.sessionId);
        const info=entry?.path?await this.statFile(entry.path):null;
        if(!Number.isSafeInteger(info?.size)||!Number.isFinite(transcript?.cursor))throw Error();
        record=await this.ledger.mark(record.requestId,{baseline:{cursor:transcript.cursor,startSize:info.size}});
      }catch{return this._public(await this._reject(record,'DESKTOP_BASELINE_UNAVAILABLE'));}
      try{
        this.bridge.enqueue({requestId:record.requestId,sessionId:record.sessionId,desktopSessionId:record.desktopSessionId,text:nativeText,
          onClaim:({dispatchToken,leaseId,instanceId,ownerPid})=>this.ledger.mark(record.requestId,{state:'dispatched',dispatchToken,leaseId,claimInstanceId:instanceId,nativeOwnerPid:ownerPid,dispatchedAt:this.now()})});
      }catch(error){return this._public(await this._reject(record,error.code==='NATIVE_QUEUE_FULL'?'NATIVE_QUEUE_FULL':'NATIVE_INPUT_REJECTED'));}
      return this._wait(record);
    });
  }

  async status(requestId){
    if(typeof requestId!=='string'||!UUID.test(requestId))throw Object.assign(new Error('请求编号无效'),{statusCode:400,code:'INVALID_REQUEST_ID'});
    // Read-only status must not queue behind a slow create/attach or proof read.
    return this._readBounded(requestId.toLowerCase());
  }
  get(requestId){return this.status(requestId);}
  reconcile(requestId){return this.status(requestId);}

  async recoverStartup(){
    const recovered=await this.ledger.recover();
    for(const record of recovered){
      if(record.transport===NATIVE_USER_TRANSPORT)await this._reconcile(record);
      else if(this.legacy)await this.legacy.status(record.requestId);
    }
    return recovered;
  }

  annotateTranscript(value){
    if(!value)return value;
    // Both caller and hydration own these message objects. A gallery preview
    // cannot mutate the raw session cache or become native delivery evidence.
    return {...value,messages:value.messages.map(message=>{
      const requestId=this.bridge.requestForMessage(value.id??value.sessionId,message.id);
      return {...message,...(requestId?{requestId,nativeMessageId:message.id}:{}),...(Array.isArray(message.attachments)?{attachments:message.attachments.map(attachment=>({...attachment}))}:{})};
    })};
  }
}
