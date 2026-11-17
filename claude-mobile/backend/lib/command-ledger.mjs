import {mkdir,open,readFile,readdir,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES=new Set(['prepared','dispatched','accepted','rejected','unknown']);
const TRANSITIONS={prepared:new Set(['dispatched','rejected']),dispatched:new Set(['accepted','rejected','unknown']),unknown:new Set(['accepted','rejected']),accepted:new Set(),rejected:new Set()};
const IMMUTABLE=new Set(['version','requestId','messageId','fingerprint','createdAt','updatedAt']);
// Share serialization across instances in this service process, including get
// and startup recovery. Separate server processes must use separate directories.
const queues=new Map();
const fault=(message,code,status=400)=>Object.assign(new Error(message),{code,status,statusCode:status});

function validId(id){
  if(typeof id!=='string'||!UUID.test(id))throw fault('requestId 必须是 UUID','INVALID_REQUEST_ID');
  return id.toLowerCase();
}

// Match JSON object semantics (omitted undefined fields), but reject values
// whose meaning cannot be represented durably. Never include payloads in errors.
function canonical(value,seen=new Set()){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(typeof value!=='object'||seen.has(value))throw fault('命令内容必须是 JSON 数据','INVALID_COMMAND_PAYLOAD');
  const proto=Object.getPrototypeOf(value);
  if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)throw fault('命令内容必须是 JSON 数据','INVALID_COMMAND_PAYLOAD');
  seen.add(value);
  try{
    if(Array.isArray(value))return '['+Array.from(value,item=>canonical(item,seen)).join(',')+']';
    return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonical(value[key],seen)).join(',')+'}';
  }finally{seen.delete(value);}
}

/**
 * Durable command identity; this module never dispatches a command.
 * Await prepare(), then mark({state:'dispatched'}) BEFORE touching native I/O.
 * existing:true is a lookup result, never permission to dispatch again, even
 * for prepared/unknown. Only an actual native ACK authorizes the caller to mark
 * accepted; an HTTP write/finish is not that ACK. Call recover() once at startup
 * before accepting commands. Payload text/attachments are hashed, not stored.
 */
export class CommandLedger{
  constructor({dir}={}){
    if(typeof dir!=='string'||!dir.trim())throw fault('必须指定独立的命令记录目录','INVALID_LEDGER_DIR');
    this.dir=resolve(dir);
  }

  _serial(operation){
    const previous=queues.get(this.dir)||Promise.resolve();
    const result=previous.then(operation);
    const tail=result.then(()=>{},()=>{});
    queues.set(this.dir,tail);
    void tail.then(()=>{if(queues.get(this.dir)===tail)queues.delete(this.dir);});
    return result;
  }

  async _read(id){
    let text;
    try{text=await readFile(join(this.dir,id+'.json'),'utf8');}
    catch(error){if(error.code==='ENOENT')return null;throw fault('无法读取命令记录','LEDGER_READ_FAILED',500);}
    let record;
    try{record=JSON.parse(text);}catch{throw fault('命令记录损坏','LEDGER_CORRUPT',500);}
    if(!record||record.version!==1||record.requestId!==id||record.messageId!==id||!STATES.has(record.state)||!/^[a-f0-9]{64}$/.test(record.fingerprint)||!Number.isFinite(record.createdAt)||!Number.isFinite(record.updatedAt))throw fault('命令记录损坏','LEDGER_CORRUPT',500);
    return record;
  }

  async _save(record){
    const temporary=join(this.dir,'.'+record.requestId+'.'+randomUUID()+'.tmp');
    let file;
    try{
      await mkdir(this.dir,{recursive:true,mode:0o700});
      file=await open(temporary,'wx',0o600);
      await file.writeFile(JSON.stringify(record));
      await file.sync();
      await file.close();file=null;
      await rename(temporary,join(this.dir,record.requestId+'.json'));
      const directory=await open(this.dir,'r');
      try{await directory.sync();}finally{await directory.close();}
    }catch{throw fault('命令记录持久化失败，禁止继续发送','LEDGER_WRITE_FAILED',500);}
    finally{
      await file?.close().catch(()=>{});
      await unlink(temporary).catch(()=>{});
    }
  }

  async prepare(requestId,payload){
    const id=validId(requestId);
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw fault('命令内容必须是 JSON 对象','INVALID_COMMAND_PAYLOAD');
    const fingerprint=createHash('sha256').update(canonical(payload)).digest('hex');
    return this._serial(async()=>{
      const existing=await this._read(id);
      if(existing){
        if(existing.fingerprint!==fingerprint)throw fault('同一 requestId 的命令内容发生变化','COMMAND_ID_COLLISION',409);
        return {record:existing,existing:true};
      }
      const now=Date.now();
      const record={version:1,requestId:id,messageId:id,fingerprint,state:'prepared',createdAt:now,updatedAt:now};
      try{await this._save(record);}catch(error){
        // This is a new command and native preparation has not begun. Even if
        // rename succeeded before a later fsync failed, no native action ran.
        error.notDispatched=true;
        throw error;
      }
      return {record,existing:false};
    });
  }

  async mark(requestId,patch,{ifState}={}){
    const id=validId(requestId);
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>IMMUTABLE.has(key)))throw fault('命令更新包含无效字段','INVALID_COMMAND_PATCH');
    const snapshot=JSON.parse(canonical(patch));
    if(Object.hasOwn(snapshot,'state')&&!STATES.has(snapshot.state))throw fault('无效的命令状态','INVALID_COMMAND_STATE');
    return this._serial(async()=>{
      const record=await this._read(id);
      if(!record)throw fault('命令记录不存在','COMMAND_NOT_FOUND',404);
      if(ifState!==undefined&&record.state!==ifState)return record;
      for(const field of ['nativeMessageId','dispatchToken']){
        if(record[field]!=null&&Object.hasOwn(snapshot,field)&&snapshot[field]!==record[field])throw fault('原生投递标识绑定后不允许改变','NATIVE_IDENTITY_IMMUTABLE',409);
      }
      if(Object.hasOwn(snapshot,'nativeMessageId')&&(typeof snapshot.nativeMessageId!=='string'||!UUID.test(snapshot.nativeMessageId)))throw fault('原生消息编号无效','INVALID_NATIVE_MESSAGE_ID');
      const next=snapshot.state??record.state;
      if(next!==record.state&&!TRANSITIONS[record.state].has(next))throw fault('命令状态不允许重新发送或回退','INVALID_COMMAND_TRANSITION',409);
      const updated={...record,...snapshot,updatedAt:Date.now()};
      await this._save(updated);
      return updated;
    });
  }

  async get(requestId){
    const id=validId(requestId);
    return this._serial(()=>this._read(id));
  }

  async recover(){
    return this._serial(async()=>{
      let names;
      try{names=await readdir(this.dir);}catch(error){if(error.code==='ENOENT')return [];throw fault('无法读取命令记录目录','LEDGER_READ_FAILED',500);}
      const recovered=[];
      for(const name of names.sort()){
        if(!name.endsWith('.json')||!UUID.test(name.slice(0,-5)))continue;
        const record=await this._read(name.slice(0,-5));
        if(!['prepared','dispatched'].includes(record?.state))continue;
        // A prepared command never crossed the durable native-I/O checkpoint.
        // Preserve any target/desktop-intent identity, but finish this request;
        // an explicit user retry needs a new request ID and the same session.
        const notSent=record.state==='prepared';
        const updated={...record,state:notSent?'rejected':'unknown',delivery:notSent?'rejected':'unknown',
          errorCode:notSent?'GATEWAY_RESTART_BEFORE_DISPATCH':'NATIVE_OUTCOME_UNKNOWN',
          error:notSent?'网关在投递前重启，本条消息未发送；请使用新请求编号重试，已有会话请沿用原会话':'尚未确认电脑是否收到消息，正在核对原请求；不会自动重复发送',
          uncertain:!notSent,updatedAt:Date.now()};
        await this._save(updated);
        recovered.push(updated);
      }
      return recovered;
    });
  }
}
