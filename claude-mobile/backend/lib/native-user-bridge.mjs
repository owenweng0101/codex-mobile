import http from 'node:http';
import net from 'node:net';
import {mkdir,readFile,writeFile,rename,unlink,lstat,chmod,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeRuntimeObservation} from './runtime-status.mjs';

export const NATIVE_USER_TRANSPORT='native-user-v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESKTOP_ENTRIES=new Set(['claude-desktop','claude-desktop-3p']);
const TOKEN=/^[A-Za-z0-9_-]{32,}$/;
const fault=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const idOf=value=>{
  if(typeof value!=='string'||!UUID.test(value))throw fault('INVALID_NATIVE_ID','原生通道编号无效',400);
  return value.toLowerCase();
};
function equalSecret(a,b){
  if(typeof a!=='string'||typeof b!=='string')return false;
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
}
async function atomicPrivateFile(path,value){
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});
    await rename(temporary,path);
  }finally{await unlink(temporary).catch(()=>{});}
}
function bodyOf(req,limit=256*1024){
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,done=false;
    const fail=error=>{if(done)return;done=true;reject(error);};
    req.on('data',chunk=>{
      if(done)return;
      size+=chunk.length;
      if(size>limit){req.resume();return fail(fault('NATIVE_BODY_TOO_LARGE','原生通道请求过大',413));}
      chunks.push(chunk);
    });
    req.on('end',()=>{
      if(done)return;done=true;
      try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();resolve(value);}
      catch{reject(fault('INVALID_NATIVE_BODY','原生通道请求格式无效',400));}
    });
    req.on('aborted',()=>fail(fault('NATIVE_REQUEST_ABORTED','原生通道请求已断开',400)));
    req.on('error',()=>fail(fault('NATIVE_REQUEST_ABORTED','原生通道请求已断开',400)));
  });
}
function respond(res,status,value){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}

/**
 * Private, device-authenticated ingress for a plugin running INSIDE the owner.
 * This socket is never proxied to the phone. It cannot send peer messages, run
 * a CLI, mutate native history, or ask a model to relay the user's words.
 *
 * Offer -> durable claim -> one engine submit -> native UUID receipt. A claim
 * lost on the wire may be queried again; a native action is never replayed.
 */
export class NativeUserBridge{
  constructor({stateDir,ledger,ownerFor,now=Date.now,sleep=delay,clientTtlMs=15000,maxQueuedPerSession=64}={}){
    if(typeof stateDir!=='string'||!ledger||typeof ownerFor!=='function')throw new TypeError('原生通道需要独立状态目录、账本和桌面所有权查询');
    Object.assign(this,{stateDir,ledger,ownerFor,now,sleep,clientTtlMs,maxQueuedPerSession});
    this.socketPath=join(stateDir,'native-user.sock');
    if(Buffer.byteLength(this.socketPath)>100)throw new TypeError('原生 Unix socket 路径过长，请使用较短的 CLM_STATE');
    this.configPath=join(stateDir,'native-bridge.json');
    this.bridgeId=randomUUID();
    this.clients=new Map();this.jobs=new Map();this.nativeIndex=new Map();this.guards=new Map();
    this.server=null;this.token=null;this.socketIdentity=null;this.initialized=false;
  }

  _serial(key,operation){
    const previous=this.guards.get(key)||Promise.resolve();
    const result=previous.then(operation),tail=result.then(()=>{},()=>{});
    this.guards.set(key,tail);
    void tail.then(()=>{if(this.guards.get(key)===tail)this.guards.delete(key);});
    return result;
  }

  async start(){
    if(this.server)return;
    await mkdir(this.stateDir,{recursive:true,mode:0o700});
    const directory=await lstat(this.stateDir);
    if(!directory.isDirectory()||directory.isSymbolicLink()||(process.getuid&&directory.uid!==process.getuid()))throw fault('UNSAFE_NATIVE_DIRECTORY','原生通道目录不安全',503);
    await chmod(this.stateDir,0o700);
    let previous=null;
    try{
      const info=await lstat(this.configPath);
      if(!info.isFile()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))throw fault('UNSAFE_NATIVE_CONFIG','原生通道配置不安全',503);
      previous=JSON.parse(await readFile(this.configPath,'utf8'));
      if(previous.version!==1||!TOKEN.test(previous.token))throw fault('INVALID_NATIVE_CONFIG','原生通道配置损坏',503);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    this.token=previous?.token??randomBytes(32).toString('base64url');
    await this._removeStaleSocket();
    const server=http.createServer((req,res)=>{void this._handle(req,res);});
    server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.socketPath,()=>{server.off('error',reject);resolve();});});
      await chmod(this.socketPath,0o600);
      this.socketIdentity=await lstat(this.socketPath);
      this.server=server;
      await atomicPrivateFile(this.configPath,{version:1,socketPath:this.socketPath,token:this.token});
      await this._loadReceiptIndex();
      this.initialized=true;
    }catch(error){
      server.close();
      if(this.server===server)this.server=null;
      await this._removeOwnedSocket();
      throw error;
    }
  }

  async _removeStaleSocket(){
    let info;
    try{info=await lstat(this.socketPath);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(!info.isSocket()||(process.getuid&&info.uid!==process.getuid()))throw fault('UNSAFE_NATIVE_SOCKET','原生通道路径已被其他文件占用',503);
    const active=await new Promise((resolve,reject)=>{
      const socket=net.createConnection(this.socketPath);
      socket.setTimeout(1000,()=>{socket.destroy();reject(fault('NATIVE_SOCKET_BUSY','无法确认原生通道是否仍在运行',503));});
      socket.once('connect',()=>{socket.destroy();resolve(true);});
      socket.once('error',error=>{socket.destroy();if(['ECONNREFUSED','ENOENT'].includes(error.code))resolve(false);else reject(error);});
    });
    if(active)throw fault('NATIVE_SOCKET_BUSY','原生通道已在运行，禁止重复启动',503);
    let current;
    try{current=await lstat(this.socketPath);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(current.ino!==info.ino||current.dev!==info.dev)throw fault('NATIVE_SOCKET_CHANGED','原生通道所有者发生变化',503);
    await unlink(this.socketPath);
  }

  async _removeOwnedSocket(){
    if(!this.socketIdentity)return;
    try{const info=await lstat(this.socketPath);if(info.ino===this.socketIdentity.ino&&info.dev===this.socketIdentity.dev)await unlink(this.socketPath);}catch(error){if(error.code!=='ENOENT')throw error;}
    this.socketIdentity=null;
  }

  async stop(){
    this.initialized=false;
    const server=this.server;this.server=null;
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await this._removeOwnedSocket();
    this.clients.clear();this.jobs.clear();
  }

  async _loadReceiptIndex(){
    let files;
    try{files=await readdir(this.ledger.dir);}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const name of files){
      if(!name.endsWith('.json')||!UUID.test(name.slice(0,-5)))continue;
      const record=await this.ledger.get(name.slice(0,-5));
      if(record?.transport===NATIVE_USER_TRANSPORT&&UUID.test(record.nativeMessageId??'')){
        const prior=this.nativeIndex.get(record.nativeMessageId);
        if(prior&&(prior.requestId!==record.requestId||prior.sessionId!==record.sessionId))throw fault('NATIVE_LEDGER_COLLISION','原生回执编号存在重复绑定，已停止接收新输入',503);
        this.nativeIndex.set(record.nativeMessageId,{requestId:record.requestId,sessionId:record.sessionId});
      }
    }
  }

  async _owner(sessionId){
    const owner=await this.ownerFor(sessionId);
    if(!owner||!DESKTOP_ENTRIES.has(owner.entrypoint)||typeof owner.hostSessionId!=='string'||!owner.hostSessionId)throw fault('NATIVE_OWNER_REQUIRED','当前会话没有可确认的桌面原生所有者');
    return owner;
  }

  async _handle(req,res){
    try{
      if(!this.initialized)return respond(res,503,{code:'NATIVE_RECOVERY_PENDING'});
      if(req.method!=='POST')return respond(res,405,{code:'METHOD_NOT_ALLOWED'});
      if(req.headers.host!=='claude-mobile-native'||req.headers.origin)return respond(res,403,{code:'NATIVE_ORIGIN_REJECTED'});
      if(!equalSecret(req.headers.authorization,'Bearer '+this.token))return respond(res,401,{code:'NATIVE_AUTH_REQUIRED'});
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return respond(res,415,{code:'JSON_REQUIRED'});
      const path=new URL(req.url,'http://claude-mobile-native').pathname;
      if(!['/v1/poll','/v1/claim','/v1/receipt'].includes(path))return respond(res,404,{code:'NOT_FOUND'});
      const body=await bodyOf(req);
      const sessionId=idOf(body.sessionId);
      const result=path==='/v1/poll'?await this._poll(sessionId,body):path==='/v1/claim'?await this._claim(sessionId,body):await this._receipt(sessionId,body);
      respond(res,200,result);
    }catch(error){
      if(!res.headersSent&&!res.destroyed)respond(res,error.statusCode||503,{code:error.code||'NATIVE_BRIDGE_ERROR',error:error.statusCode?error.message:'原生通道暂时不可用'});
    }
  }

  async _poll(sessionId,body){
    if(typeof body.ready!=='boolean'||typeof body.instanceId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(body.instanceId))throw fault('INVALID_NATIVE_POLL','原生通道实例状态无效',400);
    const owner=await this._owner(sessionId);
    if(body.hostSessionId!==owner.hostSessionId||body.entrypoint!==owner.entrypoint)throw fault('NATIVE_HOST_MISMATCH','请求不是当前桌面会话的原生实例');
    return this._serial('session:'+sessionId,async()=>{
      let client=this.clients.get(sessionId);
      const sameOwner=client&&client.desktopSessionId===owner.hostSessionId&&client.pid===owner.pid;
      if(sameOwner&&client.instanceId!==body.instanceId&&this.now()-client.lastSeen<=this.clientTtlMs)throw fault('NATIVE_INSTANCE_IN_USE','另一个原生输入实例仍在连接中');
      if(!sameOwner||client.instanceId!==body.instanceId){
        client={leaseId:randomUUID(),instanceId:body.instanceId,desktopSessionId:owner.hostSessionId,pid:owner.pid,lastSeen:this.now()};
        this.clients.set(sessionId,client);
      }
      client.lastSeen=this.now();
      if(body.runtime){const runtime=nativeRuntimeObservation(body.runtime,this.now());if(runtime)client.runtime=runtime;}
      for(const job of this.jobs.values()){
        if(job.sessionId!==sessionId||job.state!=='offered'||job.desktopSessionId===owner.hostSessionId&&job.ownerPid===owner.pid)continue;
        await this._serial(job.requestId,async()=>{
          if(job.state!=='offered')return;
          const record=await this.ledger.mark(job.requestId,{state:'rejected',errorCode:'NATIVE_OWNER_CHANGED',uncertain:false},{ifState:'prepared'});
          if(record.state==='rejected')this.jobs.delete(job.requestId);
        });
      }
      const job=body.ready?[...this.jobs.values()].find(value=>value.sessionId===sessionId&&value.desktopSessionId===client.desktopSessionId&&value.ownerPid===client.pid&&value.state==='offered'):null;
      return {protocol:1,bridgeId:this.bridgeId,leaseId:client.leaseId,job:job?{requestId:job.requestId,sessionId,text:job.text}:null};
    });
  }

  async _claim(sessionId,body){
    const requestId=idOf(body.requestId);
    return this._serial(requestId,async()=>{
      const client=this.clients.get(sessionId),job=this.jobs.get(requestId);
      if(!client||body.instanceId!==client.instanceId||!equalSecret(body.leaseId,client.leaseId)||this.now()-client.lastSeen>this.clientTtlMs)throw fault('NATIVE_LEASE_EXPIRED','原生通道连接已更新');
      const owner=await this._owner(sessionId);
      if(owner.hostSessionId!==client.desktopSessionId||owner.pid!==client.pid)throw fault('NATIVE_OWNER_CHANGED','桌面会话所有者已变化');
      if(body.recover===true){
        // Only a client still in its durable pre-engine "claiming" phase may
        // call this. Recovery can acknowledge or cancel, NEVER grant execution.
        const record=await this.ledger.get(requestId);
        if(!record||record.transport!==NATIVE_USER_TRANSPORT||record.sessionId!==sessionId)throw fault('NATIVE_RECOVERY_MISMATCH','原生领取恢复目标不一致');
        if(record.nativeMessageId)return {claimed:false,terminal:'accepted',nativeMessageId:record.nativeMessageId,dispatchToken:record.dispatchToken};
        if(record.dispatchedAt!==undefined&&record.claimInstanceId!==body.previousInstanceId)throw fault('NATIVE_RECOVERY_MISMATCH','不是原领取实例的未提交回执');
        if(record.state==='accepted')throw fault('NATIVE_RECOVERY_MISMATCH','原生接收记录不完整');
        if(record.state!=='rejected'){
          const closed=await this.ledger.mark(requestId,{state:'rejected',nativeNotSubmitted:true,errorCode:'NATIVE_CLAIM_ABANDONED',uncertain:false},{ifState:record.state});
          if(closed.state!=='rejected')throw fault('NATIVE_RECOVERY_CHANGED','原生领取状态已变化，请查询原请求');
        }
        this.jobs.delete(requestId);
        return {claimed:false,terminal:'rejected',notDispatched:true};
      }
      if(!job||job.sessionId!==sessionId||job.desktopSessionId!==client.desktopSessionId||job.ownerPid!==client.pid)throw fault('NATIVE_COMMAND_UNAVAILABLE','原生待发消息不存在',404);
      if(job.state==='claimed'){
        if(job.leaseId!==client.leaseId||job.instanceId!==body.instanceId)throw fault('NATIVE_ALREADY_CLAIMED','原生消息已被另一个连接领取');
        return {claimed:true,dispatchToken:job.dispatchToken};
      }
      const dispatchToken=job.dispatchToken??(job.dispatchToken=randomBytes(32).toString('base64url'));
      await job.onClaim({dispatchToken,leaseId:client.leaseId,instanceId:client.instanceId,ownerPid:client.pid});
      Object.assign(job,{state:'claimed',dispatchToken,leaseId:client.leaseId,instanceId:client.instanceId});
      return {claimed:true,dispatchToken};
    });
  }

  _serialReceipt(requestId,operation){
    // One index writer across requests, then the request lock shared by claims.
    return this._serial('native-receipts',()=>this._serial(requestId,operation));
  }

  async _receipt(sessionId,body){
    const requestId=idOf(body.requestId);
    return this._serialReceipt(requestId,async()=>{
      const record=await this.ledger.get(requestId);
      if(!record||record.transport!==NATIVE_USER_TRANSPORT||record.sessionId!==sessionId||!equalSecret(body.dispatchToken,record.dispatchToken))throw fault('NATIVE_RECEIPT_MISMATCH','原生回执与发送请求不一致');
      if(!['accepted','rejected','unknown'].includes(body.status))throw fault('INVALID_NATIVE_RECEIPT','原生回执状态无效',400);
      if(body.status==='accepted'){
        const nativeMessageId=idOf(body.nativeMessageId);
        if(record.nativeMessageId&&record.nativeMessageId!==nativeMessageId)throw fault('NATIVE_ID_CHANGED','原生消息编号不允许改变');
        const known=this.nativeIndex.get(nativeMessageId);
        if(known&&(known.requestId!==requestId||known.sessionId!==sessionId))throw fault('NATIVE_ID_COLLISION','原生消息编号已属于其他请求');
        if(record.state==='rejected')throw fault('NATIVE_REJECTED_RECEIPT','已拒绝请求出现矛盾的原生回执');
        // The append hook proves a native row ID, not JSONL durability. Public
        // acceptance is decided separately by NativeUserDelivery's raw reader.
        await this.ledger.mark(requestId,{nativeMessageId,nativeReceiptStatus:'accepted',nativeReceiptAt:this.now()});
        this.nativeIndex.set(nativeMessageId,{requestId,sessionId});
        this.jobs.delete(requestId);
      }else if(record.state!=='accepted'&&!record.nativeMessageId){
        if(body.status==='rejected'&&['dispatched','unknown'].includes(record.state)){
          await this.ledger.mark(requestId,{state:'rejected',nativeReceiptStatus:'rejected',errorCode:'NATIVE_INPUT_REJECTED',uncertain:false});
          this.jobs.delete(requestId);
        }else if(body.status==='unknown'&&record.state==='dispatched'){
          await this.ledger.mark(requestId,{state:'unknown',nativeReceiptStatus:'unknown',errorCode:'NATIVE_OUTCOME_UNKNOWN',uncertain:true});
        }
      }
      return {recorded:true};
    });
  }

  enqueue({requestId,sessionId,desktopSessionId,text,onClaim}){
    requestId=idOf(requestId);sessionId=idOf(sessionId);
    if(typeof text!=='string'||typeof onClaim!=='function')throw new TypeError('原生发送必须提供原文和持久化回调');
    if(this.jobs.has(requestId))throw fault('NATIVE_DUPLICATE_QUEUE','发送请求已在原生队列中');
    if([...this.jobs.values()].filter(job=>job.sessionId===sessionId).length>=this.maxQueuedPerSession)throw fault('NATIVE_QUEUE_FULL','当前会话待发消息过多，请等待已发送消息处理',429);
    this.jobs.set(requestId,{requestId,sessionId,desktopSessionId,ownerPid:this.clients.get(sessionId)?.pid??null,text,onClaim,state:'offered'});
  }

  connection(sessionId,desktopSessionId,ownerPid){
    const client=this.clients.get(sessionId);
    const ready=Boolean(this.initialized&&this.server&&client&&this.now()-client.lastSeen<=this.clientTtlMs&&(!desktopSessionId||client.desktopSessionId===desktopSessionId)&&(ownerPid==null||client.pid===ownerPid));
    return {ready,transport:NATIVE_USER_TRANSPORT,input:'user',queue:true,steer:false,attachments:false,runtime:ready?client.runtime??null:null,...(ready?{desktopSessionId:client.desktopSessionId}:{})};
  }

  async waitForSession(sessionId,desktopSessionId,{timeoutMs=10000}={}){
    let budget=timeoutMs;
    while(budget>=0){
      const connection=this.connection(sessionId,desktopSessionId);
      if(connection.ready)return connection;
      if(!budget)break;
      const wait=Math.min(100,budget);await this.sleep(wait);budget-=wait;
    }
    throw fault('NATIVE_INPUT_NOT_CONNECTED','桌面原生输入扩展尚未连接，本条消息未发送；请在桌面重新加载插件后重试',503);
  }

  hasPending(requestId){return this.jobs.has(requestId);}

  requestForMessage(sessionId,nativeMessageId){
    const value=this.nativeIndex.get(nativeMessageId);
    return value?.sessionId===sessionId?value.requestId:null;
  }
}
