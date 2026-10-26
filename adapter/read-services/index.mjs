import {createHash,randomUUID} from 'node:crypto';
import {Emitter} from '../vendor/rpc.mjs';
// onDynamic* service methods must be (params)=>event factories for the channel
// protocol; a never-firing event matches optional telemetry the UI subscribes.
const noopDynamicEvent=()=>new Emitter().event;
import {normalize} from 'node:path';
import {INVALIDATE_READS,CATALOG_GENERATION} from './shared-reads.mjs';

const HOST='local';
// Original ZCode's agent renderer normalizes every legacy engine tag to glm.
// This is UI protocol compatibility only; actual execution/model provider is
// kept separately and never invokes ZCode's GLM agent.
const AGENT_RENDERER='glm';
const MODEL_PROVIDER='codex-app';
const unsupported=method=>Object.assign(new Error('Codex read adapter does not implement '+method),{code:'CODEX_READ_ONLY_METHOD_UNAVAILABLE'});
const scopeError=()=>Object.assign(new Error('所选会话与工作目录不一致，请重新打开会话'),{code:'CODEX_WORKSPACE_MISMATCH'});
const asTime=value=>Number.isFinite(value)?value<1e11?Math.round(value*1000):value:0;
const cleanPath=value=>typeof value==='string'&&value.startsWith('/')&&!value.includes('\0')?normalize(value):null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function taskId(params){const id=typeof params==='string'?params:params?.taskId;if(!uuid.test(id||''))throw Object.assign(new Error('请选择真实 Codex 会话'),{code:'CODEX_INVALID_TASK_ID'});return id;}
function host(params){if(params?.hostId&&params.hostId!==HOST)throw Object.assign(new Error('当前适配器只连接本机 Codex'),{code:'CODEX_HOST_UNAVAILABLE'});}
function knownStatus(thread,lastTurn){
  if(lastTurn?.status==='inProgress'||thread.status?.type==='active')return'running';
  if(lastTurn?.status==='failed'||thread.status?.type==='systemError')return'error';
  if(lastTurn?.status==='interrupted')return'stopped';
  if(lastTurn?.status==='completed')return'completed';
  // notLoaded/idle describe the engine connection, not a completed task.
  return undefined;
}
export function projectTask(thread,{organization={},lastTurn}={}){
  const id=thread.id,status=knownStatus(thread,lastTurn);
  return{taskId:id,traceId:id,title:thread.name||thread.preview||'新任务',workspacePath:thread.cwd,
    hostId:HOST,projectId:thread.projectId||null,createdAt:asTime(thread.createdAt),updatedAt:asTime(thread.updatedAt),
    mode:'build',...(thread.model?{model:thread.model}:{}),...(thread.reasoningEffort?{thoughtLevel:thread.reasoningEffort}:{}),
    provider:AGENT_RENDERER,executionBackend:'codex-app',...(status?{status}:{}),codexConnectionStatus:thread.status?.type||'unknown',
    pinned:(organization.pins||[]).includes(id),archived:!!thread.archived,
    ...((organization.unread||[]).includes(id)?{unreadAt:asTime(thread.updatedAt)||1}:{})};
}
function projectProject(project,index){
  const roots=(project.roots||[]).map((entry,position)=>({rootPath:typeof entry==='string'?entry:entry.path,position,isPrimary:position===0})).filter(root=>cleanPath(root.rootPath));
  return{id:project.id,hostId:HOST,name:project.name,nameOverridden:true,roots,position:index,pinned:false,deleted:false,createdAt:0,updatedAt:0,
    ...(roots[0]?{directoryMatchPath:roots[0].rootPath}:{})};
}
function contentText(item){
  return(item.content||[]).map(value=>value.type==='text'?value.text||'':value.type==='attachment'?'[附件：'+(value.name||'文件')+']':['image','localImage','local_image'].includes(value.type)?'[图片]':'').filter(Boolean).join('\n');
}
function projectedTool(item){
  const status=item.status==='inProgress'?'running':item.status==='completed'?'completed':item.status==='declined'?'denied':item.status==='failed'?'failed':undefined;
  if(item.type==='commandExecution')return{toolName:'shell',title:'运行命令',kind:'shell',input:{command:item.command||'',cwd:item.cwd},output:item.aggregatedOutput||'',...(status?{status}:{}),raw:{toolCallId:item.id},...(item.exitCode!=null?{exitCode:item.exitCode}:{})};
  if(item.type==='fileChange')return{toolName:'file-edit',title:'修改文件',kind:'file-edit',input:{paths:(item.changes||[]).map(change=>change.path)},output:(item.changes||[]).map(change=>change.diff||'').join('\n'),...(status?{status}:{}),raw:{toolCallId:item.id}};
  if(['mcpToolCall','dynamicToolCall','webSearch','collabAgentToolCall','contextCompaction'].includes(item.type))return{toolName:item.tool||item.type,title:item.tool||item.query||item.type,kind:item.type,input:{},...(status?{status}:{}),raw:{toolCallId:item.id}};
  return null;
}
export function projectMessages(turns){
  const messages=[];
  for(const turn of turns||[]){
    let assistant=null;
    const ensureAssistant=()=>{if(!assistant){assistant={id:turn.id+':record',role:'assistant',content:'',timestamp:asTime(turn.startedAt),parts:[]};messages.push(assistant);}return assistant;};
    for(const item of turn.items||[]){
      if(item.type==='userMessage'){assistant=null;messages.push({id:item.id,role:'user',content:contentText(item),timestamp:asTime(turn.startedAt)});continue;}
      if(item.type==='agentMessage'||item.type==='plan'){
        if(item.phase==='commentary'){const a=ensureAssistant();const text=item.text||'';a.thought=(a.thought?a.thought+'\n':'')+text;a.parts.push({type:'thought',content:text});continue;}
        const a=ensureAssistant(),text=item.text||'';a.id=item.id;a.content+=(a.content?'\n':'')+text;a.parts.push({type:'content',content:text});
        if(Number.isFinite(turn.durationMs))a.durationMs=turn.durationMs;continue;
      }
      if(item.type==='reasoning'){const a=ensureAssistant(),text=(item.summary||[]).map(value=>typeof value==='string'?value:value.text||'').filter(Boolean).join('\n');if(text){a.thought=(a.thought?a.thought+'\n':'')+text;a.parts.push({type:'thought',content:text});}continue;}
      const tool=projectedTool(item);if(tool){const a=ensureAssistant();a.tools??=[];const index=a.tools.length;a.tools.push(tool);a.parts.push({type:'tool-call',toolIndex:index});}
    }
  }
  return messages;
}

export function createReadServices({api,cacheMs=500,maxCatalogPages=100,maxHistoryPages=30}={}){
  if(!api?.get)throw Error('需要只读 Codex API');
  let catalogPromise,catalogAt=0,catalogPending=false,catalogGeneration=0;
  const catalogChanged=new Emitter();
  // Shared across RPC reconnects with the shared read service. An uncertain
  // native request is only polled, never replaced by another archive send.
  const archiveRequests=new Map();
  function archiveParams(params){
    const p=typeof params==='string'?{taskId:params}:{...params};host(p);taskId(p);
    if(p.remoteSessionId||p.sourceServerId||p.workspacePath!=null&&!cleanPath(p.workspacePath)||p.workspaceIdentity&&cleanPath(p.workspaceIdentity)!==cleanPath(p.workspacePath))throw scopeError();
    return p;
  }
  const archivePending=(requestId,cause)=>Object.assign(new Error('归档结果仍待核对，请稍后刷新；不会重复发送原生归档请求'),{code:'CODEX_ARCHIVE_PENDING',requestId,outcomeUnknown:true,...(cause?{cause}:{})});
  function invalidateCatalog(){catalogPromise=null;catalogAt=0;catalogPending=false;api[INVALIDATE_READS]?.({catalog:true});}
  async function catalog(){
    if(catalogPromise&&catalogGeneration===(api[CATALOG_GENERATION]??0)&&(catalogPending||Date.now()-catalogAt<cacheMs))return catalogPromise;
    catalogGeneration=api[CATALOG_GENERATION]??0;catalogPending=true;catalogPromise=(async()=>{
      const [projectResult,organization]=await Promise.all([api.get('/api/projects'),api.get('/api/organize')]);
      if(projectResult.truncated)throw Object.assign(new Error('Codex 项目目录尚未完整读取'),{code:'CODEX_CATALOG_TRUNCATED'});
      const threads=[],seen=new Set();let cursor=null;
      for(let index=0;index<maxCatalogPages;index++){
        const page=await api.get('/api/threads'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
        for(const value of page.data||[])if(!seen.has(value.id)){seen.add(value.id);threads.push(value);}
        if(!page.nextCursor)return{projects:projectResult.projects||[],threads,organization};
        if(page.nextCursor===cursor)throw Error('Codex 列表游标未前进');cursor=page.nextCursor;
      }
      throw Object.assign(new Error('Codex 会话列表超出当前读取上限'),{code:'CODEX_CATALOG_LIMIT'});
    })();const current=catalogPromise;
    current.then(()=>{if(catalogPromise===current){catalogPending=false;catalogAt=Date.now();}},()=>{if(catalogPromise===current){catalogPromise=null;catalogPending=false;}});return current;
  }
  async function list(params={},kind='active'){
    host(params);const c=await catalog();let threads=c.threads;
    if(kind==='archived'){
      threads=[];let cursor;
      for(let i=0;i<maxCatalogPages;i++){
        const page=await api.get('/api/archived?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));threads.push(...page.data||[]);
        if(!page.nextCursor)break;if(page.nextCursor===cursor)throw Error('归档列表游标未前进');cursor=page.nextCursor;if(i===maxCatalogPages-1)throw Error('归档列表超出当前读取上限');
      }
    }
    const scopes=params.workspaceScopes??(params.workspacePath?[params]:null);
    if(scopes!=null){
      if(!Array.isArray(scopes))throw scopeError();
      const roots=scopes.map(scope=>{host(scope);const path=cleanPath(scope.workspacePath);if(!path)throw scopeError();if(scope.workspaceIdentity&&cleanPath(scope.workspaceIdentity)&&cleanPath(scope.workspaceIdentity)!==path)throw scopeError();return path;});
      threads=threads.filter(thread=>roots.includes(cleanPath(thread.cwd)));
    }
    let result=threads.map(thread=>projectTask(thread,{organization:c.organization}));
    if(kind==='pinned')result=result.filter(value=>value.pinned);
    if(kind==='active')result=result.filter(value=>!value.pinned);
    if(kind==='active'&&params.pinned===true)result=result.filter(value=>value.pinned);
    const rawQuery=params.search??params.query??params.searchTerm??'';if(typeof rawQuery!=='string')throw Object.assign(new Error('搜索文本无效'),{code:'CODEX_INVALID_SEARCH'});
    const query=rawQuery.trim().toLocaleLowerCase();if(query)result=result.filter(value=>value.title.toLocaleLowerCase().includes(query));
    result.sort((a,b)=>(params.sortBy==='created'?b.createdAt-a.createdAt:0)||b.updatedAt-a.updatedAt||a.taskId.localeCompare(b.taskId));
    return result;
  }
  async function snapshot(params){
    host(params);const id=taskId(params),messageLimit=Number.isFinite(params?.messageLimit)&&params.messageLimit>0?Math.min(2000,Math.floor(params.messageLimit)):100;
    const page=await api.get('/api/history?threadId='+encodeURIComponent(id));
    if(page.thread?.id!==id)throw Error('Codex 历史编号不一致');
    if(params?.workspacePath&&cleanPath(params.workspacePath)!==cleanPath(page.thread.cwd))throw scopeError();
    const turns=[...page.turns||[]];let cursor=page.nextCursor,reads=1,messages=projectMessages(turns);
    while(cursor&&messages.length<messageLimit&&reads<maxHistoryPages){
      const older=await api.get('/api/history?threadId='+encodeURIComponent(id)+'&cursor='+encodeURIComponent(cursor));
      if(older.thread?.id!==id)throw Error('Codex 历史编号不一致');
      if(older.thread.cwd!==page.thread.cwd)throw scopeError();
      const known=new Set(turns.map(turn=>turn.id));turns.unshift(...(older.turns||[]).filter(turn=>!known.has(turn.id)));
      if(older.nextCursor===cursor)throw Error('Codex 历史游标未前进');cursor=older.nextCursor;reads++;messages=projectMessages(turns);
    }
    const organization=(await catalog()).organization,meta=projectTask(page.thread,{organization,lastTurn:turns.at(-1)}),allCount=messages.length;
    const output={meta,messages:messages.slice(-messageLimit),configOptions:[],slashCommands:[],
      runtime:{readOnly:true,unsupportedInReadAdapter:['permissionInteraction','backgroundJobs','commandQueue','configOptions','slashCommands'],
        ...(page.tokenUsage?{codexTokenUsage:page.tokenUsage}:{}),...(page.plan!=null?{codexPlan:page.plan}:{}),
        ...(Array.isArray(page.approvals)?{codexPendingApprovalCount:page.approvals.length}:{}),
        ...(page.activeTurn?{codexActiveTurnId:page.activeTurn}:{})},
      history:{truncatedBefore:!!cursor||allCount>messageLimit,...(!cursor?{totalMessages:allCount}:{totalMessagesKnown:false})}};
    return output;
  }
  const task={
    async initialize(){return{available:true,readOnly:true};},
    async checkCodexConnectivity(){const status=await api.get('/api/status');return{ok:!!status.online,target:'codex',readOnly:true};},
    listTasks:params=>list(params),listPinnedTasks:params=>list(params,'pinned'),listArchivedTasks:params=>list(params,'archived'),
    async listPinnedTaskIds(){return(await list({},'pinned')).map(value=>value.taskId);},
    async listActiveTaskIds(params){return(await list(params,'all')).filter(value=>value.status==='running').map(value=>value.taskId);},
    async listDeletedTaskIds(){return[];},
    async listTaskList(params={}){const kind=['active','pinned','archived'].includes(params.kind)?params.kind:'active',items=await list(params,kind),offset=Number.isInteger(params.offset)&&params.offset>=0?params.offset:0,limit=Number.isInteger(params.limit)&&params.limit>0?Math.min(params.limit,500):items.length;return{items:items.slice(offset,offset+limit),total:items.length,hasMore:offset+limit<items.length};},
    async getTaskMeta(params){host(params);const id=taskId(params);const value=(await list(params,'all')).find(value=>value.taskId===id);if(value)return value;const page=await api.get('/api/history?threadId='+encodeURIComponent(id));if(params.workspacePath&&cleanPath(params.workspacePath)!==cleanPath(page.thread?.cwd))throw scopeError();return page.thread?.id===id?projectTask(page.thread,{lastTurn:page.turns?.at(-1)}):null;},
    getTaskSnapshot:snapshot,
    async getTaskSnapshotWithEtag(params){const value=await snapshot(params),etag=createHash('sha256').update(JSON.stringify(value)).digest('hex');return params.ifNoneMatch===etag?{snapshot:null,etag,notModified:true}:{snapshot:value,etag};},
    async getTaskSnapshotBody(){return null;},async getTaskSnapshotRef(){return null;},async getTaskSnapshotToolCallsSlice(){return null;},
    async getTaskModelSelection(params){const value=await this.getTaskMeta(params);return value?.model?{providerId:MODEL_PROVIDER,modelId:value.model}:null;},
    async getTaskConfigOptions(){return[];},
    async setTaskPinned(params){
      const p=archiveParams(params),id=taskId(p);
      if(typeof p.pinned!=='boolean')throw Error('置顶状态必须是布尔值');
      if(typeof api.post!=='function')throw Object.assign(Error('当前连接不支持修改置顶'),{code:'CODEX_WRITE_UNAVAILABLE'});
      const meta=await task.getTaskMeta(p);
      if(!meta||meta.archived)throw Object.assign(Error('会话不存在或已归档，请刷新后重试'),{code:'CODEX_INVALID_TASK_ID'});
      const result=await api.post('/api/organize',{action:'pin',threadId:id,enabled:p.pinned});
      invalidateCatalog();
      if(!Array.isArray(result?.pins)||result.pins.includes(id)!==p.pinned)throw Error('置顶结果未确认，请刷新后重试');
      catalogChanged.fire({method:'bridge/catalogUpdated',taskId:id});
      return{...meta,pinned:p.pinned};
    },
    // Original H5 calls zcode-task.archiveTask/unarchiveTask for list actions.
    // Backed by the native archive service; a pending native verification is
    // polled so the UI gets a definitive task object or a clear failure.
    async archiveTask(params){
      const p=archiveParams(params),id=taskId(p),meta=await task.getTaskMeta(p);
      if(!meta)throw Object.assign(new Error('会话不存在，请刷新后重试'),{code:'CODEX_INVALID_TASK_ID'});
      let record=archiveRequests.get(id);
      if(!record){record={requestId:'march'+randomUUID().replaceAll('-','').slice(0,20),attempted:false};archiveRequests.set(id,record);}
      if(record.promise)return record.promise;
      const {requestId}=record,readStatus=()=>api.get('/api/thread/archive/status?threadId='+encodeURIComponent(id)+'&requestId='+encodeURIComponent(requestId));
      record.promise=(async()=>{
        let result;
        try{if(record.attempted)result=await readStatus();else{record.attempted=true;result=await api.post('/api/thread/archive',{threadId:id,requestId});}}
        catch(error){if(error.sent===false){archiveRequests.delete(id);throw error;}throw archivePending(requestId,error);}
        const deadline=Date.now()+40000;
        while(true){
          if(result?.threadId!==id||result?.requestId!==requestId)throw archivePending(requestId);
          if(result.archived===true&&result.verified===true&&result.pending===false&&result.status==='archived'){
            archiveRequests.delete(id);invalidateCatalog();return{...meta,archived:true};
          }
          if(result.pending!==true){
            if(result.archived===false&&['blocked','notArchived'].includes(result.status)){
              if(result.sent===false)archiveRequests.delete(id);
              throw Object.assign(new Error(result.error||result.message||'归档未完成，请稍后刷新'),{code:'CODEX_ARCHIVE_FAILED',requestId});
            }
            throw archivePending(requestId);
          }
          if(Date.now()+1000>deadline)throw archivePending(requestId);
          await new Promise(resolve=>setTimeout(resolve,1000));
          try{result=await readStatus();}catch(error){throw archivePending(requestId,error);}
        }
      })().finally(()=>{record.promise=null;});
      return record.promise;
    },
    async unarchiveTask(params){
      const p=archiveParams(params),id=taskId(p),before=await task.getTaskMeta(p);
      if(!before)throw Object.assign(new Error('会话不存在，请刷新后重试'),{code:'CODEX_INVALID_TASK_ID'});
      const requestId='munar'+randomUUID().replaceAll('-','').slice(0,20);
      const result=await api.post('/api/thread/unarchive',{threadId:id,requestId});
      if(result?.unarchived!==true||result.verified!==true||result.threadId!==id||result.requestId!==requestId)throw Object.assign(new Error(result?.error||result?.message||'恢复归档未完成，请稍后刷新'),{code:'CODEX_UNARCHIVE_FAILED'});
      archiveRequests.delete(id);invalidateCatalog();
      const meta=await task.getTaskMeta(p).catch(()=>null);
      return{...(meta||before),archived:false};
    },
  };
  const channels={
    project:{
      onDidChange:catalogChanged.event,
      async readProjects(params={}){host(params);return(await catalog()).projects.map(projectProject);},
      async readTree(params={}){host(params);if(params.refresh===true){invalidateCatalog();}const c=await catalog();return{projects:c.projects.map(projectProject),tasks:c.threads.map(thread=>projectTask(thread,{organization:c.organization}))};},
      async resolveSessionDirectories(params){const meta=await task.getTaskMeta(params);if(!meta)throw Error('会话不存在');return{workspacePath:meta.workspacePath,projectId:meta.projectId,additionalDirectories:[]};},
    },
    'remote-projects':{async readDirectory(){return{hosts:[],entries:[]};}},
    'task-groups':{async read(){const c=await catalog(),groups=(c.organization.groups||[]).map(group=>({id:group.id,title:group.name,color:group.color})),knownGroups=new Set(groups.map(value=>value.id));return{groups,members:c.threads.filter(thread=>knownGroups.has(c.organization.assignments?.[thread.id])).map(thread=>({workspaceKey:thread.cwd,taskId:thread.id,groupId:c.organization.assignments[thread.id]})),order:[]};}},
    'zcode-task':task,
  };
  for(const [channel,service] of Object.entries(channels))channels[channel]=new Proxy(service,{get(target,name,receiver){if(typeof name!=='string')return Reflect.get(target,name,receiver);if(name in target)return Reflect.get(target,name,receiver);if(name.startsWith('onDynamic'))return noopDynamicEvent;return()=>{throw unsupported(channel+'.'+name);};}});
  return channels;
}
