import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const KEYS={thread:['id','name','cwd','createdAt','updatedAt','projectId','model','modelProvider','reasoningEffort'],settings:['name','model','effort','mode','approvalPolicy','sandbox'],top:['model','modelProvider','reasoningEffort','approvalPolicy','approvalsReviewer','cwd','serviceTier']};
const primitive=value=>value===null||['string','number','boolean'].includes(typeof value);
const fields=(source,keys)=>Object.fromEntries(keys.filter(key=>source&&Object.hasOwn(source,key)&&primitive(source[key])).map(key=>[key,source[key]]));
function failure(message,code='CREATION_OUTCOME_UNKNOWN') {return Object.assign(new Error(message),{code,outcomeUnknown:true});}
function minimalResult(result) {
  if (!result?.thread || typeof result.thread.id!=='string' || !result.thread.id) throw failure('创建回执缺少会话标识');
  const thread=fields(result.thread,KEYS.thread);
  if(typeof result.thread.status?.type==='string')thread.status={type:result.thread.status.type};
  return {...fields(result,KEYS.top),thread,settings:fields(result.settings,KEYS.settings),desktop:{attached:result.desktop?.attached===true,persisted:result.desktop?.persisted===true,writerReleased:result.desktop?.writerReleased===true}};
}

// Persist the allocation before any caller can retry after a dropped HTTP ACK.
// One request never invokes a second create, including after a server restart.
export class CreationLedger {
  constructor(stateDir) {
    if(typeof stateDir!=='string'||!stateDir)throw new Error('需要创建记录目录');
    this.directory=join(stateDir,'creation-ledger');this.pending=new Map();
  }
  async initialize() {this.ready ||= mkdir(this.directory,{recursive:true,mode:0o700});await this.ready;}
  paths(requestId) {
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(requestId))throw new Error('创建请求标识无效');
    const digest=createHash('sha256').update(requestId).digest('hex');return{record:join(this.directory,digest+'.json'),lock:join(this.directory,digest+'.lock')};
  }
  async read(path,requestId) {
    let raw;try{raw=await readFile(path,'utf8')}catch(error){if(error.code==='ENOENT')return null;throw error}
    let record;try{record=JSON.parse(raw)}catch{throw failure('创建记录暂不可用，请核对已有任务','CREATION_LEDGER_CORRUPT')}
    if(record.version!==1||record.requestId!==requestId||!['started','allocated','persisted','needsAttach','complete','unknown'].includes(record.state))throw failure('创建记录格式无效，请核对已有任务','CREATION_LEDGER_CORRUPT');
    return record;
  }
  async write(path,record) {
    const temporary=path+'.'+randomUUID()+'.tmp';let file;
    try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(record)+'\n');await file.sync();await file.close();file=null;await rename(temporary,path);const dir=await open(this.directory,'r');try{await dir.sync()}finally{await dir.close()}}
    catch(error){throw Object.assign(failure('创建回执尚未可靠保存，请核对已有任务','CREATION_LEDGER_WRITE_FAILED'),{cause:error})}
    finally{await file?.close().catch(()=>{});await unlink(temporary).catch(()=>{})}
  }
  acknowledge(record) {
    if(record.state==='complete')return{...minimalResult(record.result),creation:{requestId:record.requestId,state:'complete',needsAttach:false}};
    if(record.threadId)return{thread:{id:record.threadId},desktop:{attached:false,persisted:record.persisted===true,writerReleased:record.writerReleased===true},creation:{requestId:record.requestId,state:'needsAttach',needsAttach:true,persisted:record.persisted===true,writerReleased:record.writerReleased===true}};
    throw Object.assign(failure('创建结果尚未确认，请先核对任务列表，避免重复创建'),{requestId:record.requestId});
  }
  run(requestId,operation) {
    this.paths(requestId);
    if(typeof operation!=='function')return Promise.reject(new Error('需要创建操作'));
    if(this.pending.has(requestId))return this.pending.get(requestId);
    const promise=this.execute(requestId,operation).finally(()=>this.pending.delete(requestId));this.pending.set(requestId,promise);return promise;
  }
  async execute(requestId,operation) {
    await this.initialize();const paths=this.paths(requestId),existing=await this.read(paths.record,requestId);if(existing)return this.acknowledge(existing);
    let lock;try{lock=await open(paths.lock,'wx',0o600)}catch(error){if(error.code!=='EEXIST')throw error;const record=await this.read(paths.record,requestId);if(record)return this.acknowledge(record);throw failure('创建正在确认，请先核对任务列表，避免重复创建')}
    const record={version:1,requestId,state:'started',createdAt:Date.now(),updatedAt:Date.now(),persisted:false,writerReleased:false};
    const save=async()=>{record.updatedAt=Date.now();await this.write(paths.record,record)};
    try{
      // Recheck under the exclusive per-request lock in case another process
      // committed a response between our initial read and lock acquisition.
      const raced=await this.read(paths.record,requestId);if(raced)return this.acknowledge(raced);
      await save();
      const allocated=async(info,persisted)=>{
        if(typeof info?.threadId!=='string'||!info.threadId)throw failure('创建阶段缺少会话标识');
        if(record.threadId&&record.threadId!==info.threadId)throw failure('创建阶段会话标识发生变化');
        record.threadId=info.threadId;record.persisted=record.persisted||persisted;record.state=record.persisted?'persisted':'allocated';await save();
      };
      try{
        const result=await operation({onCreated:info=>allocated(info,false),onPersisted:info=>allocated(info,true)});
        const minimal=minimalResult(result);
        if(record.threadId&&minimal.thread.id!==record.threadId)throw failure('创建回执与已分配会话不一致');
        record.threadId=minimal.thread.id;record.persisted=minimal.desktop.persisted;record.writerReleased=minimal.desktop.writerReleased;record.result=minimal;record.state='complete';await save();return this.acknowledge(record);
      }catch(error){
        if(!record.threadId&&typeof error.threadId==='string')record.threadId=error.threadId;
        if(error.persisted===true)record.persisted=true;if(error.writerReleased===true)record.writerReleased=true;
        record.state=record.threadId?'needsAttach':'unknown';await save();
        return this.acknowledge(record);
      }
    }finally{await lock.close();await unlink(paths.lock).catch(()=>{})}
  }
}
