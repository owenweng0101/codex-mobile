import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {desktopTurns} from './desktop-bridge.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST=/^[A-Za-z0-9_-]{8,160}$/;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const BLOCKED={busy:'会话正在运行，结束后再归档','plan-mode':'当前 Plan 模式暂不使用手机原生归档流程，请切换执行模式后重试','owner-unavailable':'暂时无法确认原生会话状态，尚未发送归档请求'};
function identity({threadId,requestId}={}) {
  if(typeof threadId!=='string'||!UUID.test(threadId))throw new Error('请选择明确的归档聊天');
  if(typeof requestId!=='string'||!REQUEST.test(requestId))throw new Error('归档请求标识无效');
  return{threadId,requestId};
}
const stateError=()=>Object.assign(new Error('归档请求记录暂不可用，请刷新核对实际状态，避免重复请求'),{code:'NATIVE_ARCHIVE_STATE_UNAVAILABLE',outcomeUnknown:true});

// No owner archive RPC exists in this App version. A selected idle chat asks its
// own native model/tool context to archive itself. Saved-state reads alone can
// complete the operation; model wording and notifications are not evidence.
export class NativeArchive {
  constructor({desktop,readThread,isArchived,stateDir,initialWaitMs=25000,pollMs=500,readTimeoutMs=2000,settleMs=500}={}) {
    if(!desktop||typeof readThread!=='function'||typeof stateDir!=='string'||!stateDir)throw new Error('需要原生会话、核验服务和持久请求目录');
    this.desktop=desktop;this.readThread=readThread;this.isArchived=isArchived;this.directory=join(stateDir,'native-archive');this.path=join(this.directory,'requests.json');
    this.initialWaitMs=initialWaitMs;this.pollMs=pollMs;this.readTimeoutMs=readTimeoutMs;this.settleMs=settleMs;this.jobs=new Map();this.threads=new Map();this.saving=Promise.resolve();
  }
  ready() {return this.loading ||= this.load();}
  async load() {
    await mkdir(this.directory,{recursive:true,mode:0o700});let raw;
    try{raw=await readFile(this.path,'utf8')}catch(error){if(error.code==='ENOENT')return this;throw stateError()}
    try{
      const stored=JSON.parse(raw);if(stored.version!==1||!Array.isArray(stored.jobs))throw Error();
      for(const record of stored.jobs){
        identity(record);if(!Array.isArray(record.aliases)||record.aliases.some(id=>!REQUEST.test(id))||record.blockedReason&&!Object.hasOwn(BLOCKED,record.blockedReason)||record.turnId!=null&&typeof record.turnId!=='string')throw Error();
        const job={threadId:record.threadId,requestId:record.requestId,aliases:new Set([record.requestId,...record.aliases]),state:record.verifiedAt?'archived':record.notArchivedAt?'notArchived':record.blockedReason?'blocked':'pending',sendStarted:record.started===true,createdAt:record.createdAt,verifiedAt:record.verifiedAt,notArchivedAt:record.notArchivedAt,turnId:record.turnId,reason:record.blockedReason,stoppedWaiting:record.stoppedWaiting===true,recovered:true,outcomeUnknown:record.started===true&&!record.verifiedAt&&!record.notArchivedAt};
        for(const id of job.aliases){if(this.jobs.has(id))throw Error();this.jobs.set(id,job);}if(job.state==='pending')this.threads.set(job.threadId,job);
      }
    }catch{this.jobs.clear();this.threads.clear();throw stateError()}
    return this;
  }
  persist() {
    const write=async()=>{
      const jobs=[...new Set(this.jobs.values())].map(job=>({threadId:job.threadId,requestId:job.requestId,aliases:[...job.aliases],createdAt:job.createdAt,started:job.sendStarted===true,...(job.verifiedAt?{verifiedAt:job.verifiedAt}:{}),...(job.notArchivedAt?{notArchivedAt:job.notArchivedAt}:{}),...(job.turnId?{turnId:job.turnId}:{}),...(job.state==='blocked'?{blockedReason:job.reason}:{}),...(job.stoppedWaiting?{stoppedWaiting:true}:{})}));
      const temp=this.path+'.'+randomUUID()+'.tmp';let file;
      try{file=await open(temp,'wx',0o600);await file.writeFile(JSON.stringify({version:1,jobs})+'\n');await file.sync();await file.close();file=null;await rename(temp,this.path);const dir=await open(this.directory,'r');try{await dir.sync()}finally{await dir.close()}}
      catch{throw stateError()}finally{await file?.close().catch(()=>{});await unlink(temp).catch(()=>{})}
    };
    const next=this.saving.then(write);this.saving=next.catch(()=>{});return next;
  }
  response(job,requestId=job.requestId) {
    const archived=job.state==='archived',blocked=job.state==='blocked',notArchived=job.state==='notArchived';
    const message=archived?'会话已归档':notArchived?'归档未完成，已恢复会话操作；本次请求已发送，不会自动重试':blocked?BLOCKED[job.reason]:job.stoppedWaiting?'已停止等待；已发送的归档请求仍可能完成，请刷新核对':job.recovered?'正在只读核对先前归档请求，不会再次发送':'归档需要原生会话执行，正在核对实际结果';
    return{threadId:job.threadId,requestId,status:archived?'archived':notArchived?'notArchived':blocked?'blocked':'pending',archived,pending:!archived&&!blocked&&!notArchived,sent:job.sendStarted===true,...(!archived&&job.reason?{reason:job.reason}:{}),message,...(job.turnId?{turnId:job.turnId}:{}),...(job.outcomeUnknown?{outcomeUnknown:true}:{})};
  }
  isPending(threadId) {return this.threads.get(threadId)?.state==='pending';}
  async bounded(operation,fallback=null) {
    let timer;try{return await Promise.race([operation(),new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),this.readTimeoutMs)})])}catch{return fallback}finally{clearTimeout(timer)}
  }
  async probe(threadId) {
    return this.bounded(async()=>{
      let unarchived=false;
      try{const response=await this.readThread(threadId),thread=response?.thread??response;if(thread?.id===threadId&&typeof thread.path==='string'){const path=thread.path.replaceAll('\\','/');if(path.includes('/archived_sessions/'))return{archived:true,unarchived:false};unarchived=path.includes('/sessions/');}}catch{}
      if(this.isArchived)try{if(await this.isArchived(threadId)===true)return{archived:true,unarchived:false}}catch{return{archived:false,unarchived:false}}
      return{archived:false,unarchived};
    },{archived:false,unarchived:false});
  }
  async completedOwnTurn(job) {
    if(typeof this.desktop.snapshot!=='function')return null;
    const state=await this.bounded(()=>this.desktop.snapshot(job.threadId,{fresh:true}));
    if(!state||state.id!==job.threadId||state.threadRuntimeStatus?.type!=='idle')return null;
    const turns=desktopTurns(state);if(turns.some(turn=>turn.status==='inProgress'))return null;
    const clientId='native-archive-'+job.requestId;
    const candidates=turns.filter(turn=>turn.params?.clientUserMessageId===clientId);
    const turn=job.turnId?turns.find(turn=>turn.turnId===job.turnId):candidates.length===1?candidates[0]:null;
    if(!turn||turn.status!=='completed'||!turn.turnId||turn.params?.clientUserMessageId&&turn.params.clientUserMessageId!==clientId)return null;
    if(!job.turnId){job.turnId=turn.turnId;await this.persist();}
    return turn;
  }
  async markArchived(job) {
    const changed=job.state!=='archived'||!job.verifiedAt;job.state='archived';job.verifiedAt ||= Date.now();delete job.reason;if(changed)try{await this.persist()}catch{}
  }
  async check(job) {
    if(job.checking)return job.checking;
    job.checking=(async()=>{
      const initial=await this.probe(job.threadId);if(initial.archived){await this.markArchived(job);return true;}
      const completed=job.state==='pending'&&job.sendStarted?await this.completedOwnTurn(job):null;
      if(!completed)delete job.completionCandidate;
      if(completed){
        // Read again AFTER the fresh completed/idle owner snapshot. A failed or
        // unknown read is never evidence that the archive failed. Require the
        // same result again after a short quiet window for storage propagation.
        const after=await this.probe(job.threadId);if(after.archived){await this.markArchived(job);return true;}
        if(after.unarchived){
          if(job.completionCandidate?.turnId!==completed.turnId)job.completionCandidate={turnId:completed.turnId,observedAt:Date.now()};
          else if(Date.now()-job.completionCandidate.observedAt>=this.settleMs){job.state='notArchived';job.notArchivedAt=Date.now();job.outcomeUnknown=false;delete job.reason;await this.persist();}
        }
      }
      return false;
    })().catch(()=>false).finally(()=>{job.checking=null});return job.checking;
  }
  async block(job,reason) {if(job.state!=='archived'){job.state='blocked';job.reason=reason;await this.persist();}}
  async start(job) {
    try{
      if(await this.check(job)||job.stoppedWaiting)return;
      const history=await this.desktop.history(job.threadId);
      if(!history||history.thread?.id!==job.threadId){await this.block(job,'owner-unavailable');return;}
      if(history.activeTurn){await this.block(job,'busy');return;}
      if(history.settings?.mode==='plan'){await this.block(job,'plan-mode');return;}
      if(job.stoppedWaiting||job.state==='archived')return;
      // Commit the no-replay barrier before sending any model input.
      job.sendStarted=true;await this.persist();
      if(job.state!=='pending'||job.stoppedWaiting)return;
      const sent=await this.desktop.send(job.threadId,{requestId:'native-archive-'+job.requestId,input:[{type:'text',text:`请使用当前 Codex App 提供的 set_thread_archived 工具，将且仅将由用户明确选择的当前聊天（ID=${job.threadId}）归档，archived=true。不要修改文件，不要调用 shell 或其他工具，也不要操作其他聊天。若该工具不可用，请明确说明，不能声称成功。`}]});
      job.turnId=sent?.turn?.id;await this.persist();
    }catch(error){if(job.sendStarted){job.outcomeUnknown=true;}else try{await this.block(job,'owner-unavailable')}catch{job.outcomeUnknown=true;}}
  }
  async wait(job) {
    const deadline=Date.now()+this.initialWaitMs;
    do{await this.check(job);if(job.state==='archived'||job.state==='notArchived'||job.state==='blocked'||job.stoppedWaiting)return;await delay(Math.min(this.pollMs,Math.max(0,deadline-Date.now())));}while(Date.now()<deadline);
  }
  async run(params) {
    const {threadId,requestId}=identity(params);await this.ready();const existing=this.jobs.get(requestId);
    if(existing){if(existing.threadId!==threadId)throw new Error('归档请求与聊天不一致');if(existing.initial)await existing.initial;await this.check(existing);return this.response(existing,requestId);}
    const active=this.threads.get(threadId);
    if(active?.state==='pending'){active.aliases.add(requestId);this.jobs.set(requestId,active);await this.persist();if(active.initial)await active.initial;await this.check(active);return this.response(active,requestId);}
    const job={threadId,requestId,aliases:new Set([requestId]),state:'pending',sendStarted:false,createdAt:Date.now()};this.jobs.set(requestId,job);this.threads.set(threadId,job);await this.persist();
    job.startPromise=this.start(job);let timer;
    job.initial=Promise.race([this.wait(job),new Promise(resolve=>{timer=setTimeout(resolve,this.initialWaitMs)})]).then(()=>this.response(job)).finally(()=>clearTimeout(timer));
    return job.initial;
  }
  async status(params) {
    const {threadId,requestId}=identity(params);await this.ready();const existing=this.jobs.get(requestId);if(existing&&existing.threadId!==threadId)throw new Error('归档请求与聊天不一致');
    const job=existing||{threadId,requestId,aliases:new Set([requestId]),state:'pending',sendStarted:false,createdAt:Date.now(),recovered:true};
    // Unknown status is read-only, including after restart. It cannot create a job.
    if(existing)await this.check(job);
    else{const wasKnown=this.jobs.has(requestId);await this.check(job);if(job.state==='archived'&&!wasKnown){this.jobs.set(requestId,job);await this.persist().catch(()=>{})}}
    return this.response(job,requestId);
  }
  async cancel(params) {
    const {threadId,requestId}=identity(params);await this.ready();const job=this.jobs.get(requestId);if(!job||job.threadId!==threadId)return this.status(params);
    await this.check(job);if(job.state!=='archived'){job.stoppedWaiting=true;await this.persist();}return this.response(job,requestId);
  }
}
