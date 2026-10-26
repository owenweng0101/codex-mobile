import { cleanUserText } from './view.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=message=>Object.assign(new Error(message),{statusCode:400});
export function ensureThreadUnarchived(thread) {
  if(thread?.path?.includes('/archived_sessions/'))throw Object.assign(new Error('这条会话已归档，请先显式恢复后再操作'),{statusCode:409,code:'THREAD_ARCHIVED'});
  return thread;
}
export function archivedThreadMetadata(thread) {
  return {id:thread.id,name:typeof thread.name==='string'?thread.name.slice(0,200):null,preview:cleanUserText(thread.preview||'').slice(0,200),cwd:thread.cwd,createdAt:thread.createdAt,updatedAt:thread.updatedAt,model:thread.model,projectId:thread.projectId||null,status:{type:'archived'},archived:true};
}
function stateOf(thread,id) {
  if(thread?.id!==id||typeof thread.path!=='string')return null;
  if(thread.path.includes('/archived_sessions/'))return 'archived';
  if(thread.path.includes('/sessions/'))return 'unarchived';
  return null;
}

// Official metadata RPCs only. Native background goal scheduling is preserved;
// this service never changes the goal or submits a resume/turn operation.
export class ArchivedThreads {
  constructor(core) {this.core=core;this.requests=new Map();this.restoring=new Map();}
  async list(query) {
    const q=(query.get('q')||'').trim();if(q.length>200)throw invalid('搜索词最多 200 个字符');
    const limit=Number(query.get('limit')||30);if(!Number.isInteger(limit)||limit<1||limit>100)throw invalid('每页数量需为 1–100');
    let cursor;
    if(query.get('cursor')){
      try{const raw=query.get('cursor');if(raw.length>16384)throw Error();const saved=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(saved.v!==1||saved.q!==q||typeof saved.cursor!=='string'||!saved.cursor)throw Error();cursor=saved.cursor;}
      catch{throw invalid('归档列表游标已失效，请重新搜索');}
    }
    const page=await this.core.call('thread/list',{archived:true,limit,sortKey:'updated_at',sortDirection:'desc',modelProviders:[],useStateDbOnly:true,...(q?{searchTerm:q}:{}),...(cursor?{cursor}:{})});
    return {data:page.data.map(archivedThreadMetadata),nextCursor:page.nextCursor?Buffer.from(JSON.stringify({v:1,q,cursor:page.nextCursor})).toString('base64url'):null,searchScope:'title'};
  }
  unarchive({threadId,requestId}={}) {
    if(!uuid.test(threadId||''))return Promise.reject(invalid('请选择需要恢复的会话'));
    if(typeof requestId!=='string'||!/^[-A-Za-z0-9_]{8,128}$/.test(requestId))return Promise.reject(invalid('恢复请求缺少有效编号，请刷新重试'));
    const key=threadId+':'+requestId,existing=this.requests.get(key);
    if(existing){
      if(existing.unknown||existing.complete){existing.unknown=false;existing.complete=false;existing.promise=this.verify(threadId).then(thread=>{if(thread){existing.complete=true;return{...this.result(thread),requestId};}throw this.uncertain()});existing.promise.catch(()=>{existing.unknown=true});}
      return existing.promise;
    }
    const pending=this.restoring.get(threadId)||this.restore(threadId).finally(()=>this.restoring.delete(threadId));
    this.restoring.set(threadId,pending);
    const receipt=pending.then(result=>{record.complete=true;return{...result,requestId}}),record={promise:receipt,unknown:false,complete:false};this.requests.set(key,record);
    receipt.catch(error=>{if(error.outcomeUnknown)record.unknown=true;else this.requests.delete(key)});
    if(this.requests.size>300)this.requests.delete(this.requests.keys().next().value);
    return receipt;
  }
  async restore(threadId) {
    let thread=(await this.core.call('thread/read',{threadId,includeTurns:false},5000)).thread;
    if(stateOf(thread,threadId)==='unarchived')return this.result(thread);
    if(stateOf(thread,threadId)!=='archived')throw Object.assign(new Error('无法确认会话的归档状态，请刷新后重试'),{statusCode:409});
    let goalState={goalKnown:false,mayContinueGoal:true};
    try {
      const response=await this.core.call('thread/goal/get',{threadId},5000);
      if(!response||!Object.hasOwn(response,'goal')||response.goal!==null&&(response.goal?.threadId!==threadId||typeof response.goal.status!=='string'))throw new Error('unverified goal state');
      goalState={goalKnown:true,goalStatus:response.goal?.status??null,mayContinueGoal:!!response.goal&&!['paused','complete'].includes(response.goal.status)};
    } catch {}
    let rpcError;
    try{await this.core.call('thread/unarchive',{threadId},10000);}catch(error){rpcError=error;}
    thread=await this.verify(threadId);if(thread)return this.result(thread,goalState);
    throw this.uncertain(rpcError);
  }
  async verify(threadId) {try{const thread=(await this.core.call('thread/read',{threadId,includeTurns:false},5000)).thread;return stateOf(thread,threadId)==='unarchived'?thread:null;}catch{return null;}}
  async refreshDesktop(threadId,desktop) {
    const thread=(await this.core.call('thread/read',{threadId,includeTurns:false},5000)).thread;
    if(stateOf(thread,threadId)!=='unarchived')throw Object.assign(new Error('会话尚未核验为已恢复，暂不通知桌面端'),{statusCode:409,code:'THREAD_ARCHIVED'});
    const receipt=await desktop.notifyUnarchived(threadId);desktop.unfollow(threadId);return receipt;
  }
  uncertain(cause) {return Object.assign(new Error('恢复请求已发出，尚未确认保存状态，请刷新归档列表核对后再操作'),{statusCode:409,code:'UNARCHIVE_OUTCOME_UNKNOWN',outcomeUnknown:true,cause});}
  result(thread,goalState={goalKnown:false,mayContinueGoal:true}) {return{threadId:thread.id,unarchived:true,verified:true,...goalState,thread:{...archivedThreadMetadata(thread),archived:false,status:thread.status||{type:'notLoaded'}}};}
}
