import {Emitter} from '../vendor/rpc.mjs';
import {INVALIDATE_READS} from './shared-reads.mjs';

const taskMethods=new Map([
  ['onDynamicTaskEvent','task'],['onDynamicStreamEvent','stream'],
  ['onDynamicWorkspaceEvent','workspace'],['onDynamicTaskTerminalOutcome','terminal'],
  ['onDynamicTaskReady','ready'],
]);
const catalogMethods=new Set(['bridge/catalogUpdated','thread/name/updated','turn/started','turn/completed']);
const snapshotMethods=new Set(['item/agentMessage/delta','item/started','item/completed','turn/started','turn/completed','turn/plan/updated','turn/diff/updated','thread/tokenUsage/updated','bridge/historyReset','bridge/queueUpdated','bridge/approval','bridge/approvalResolved','bridge/desktopOnline','bridge/desktopOffline','error']);
const path=value=>typeof value==='string'&&value.startsWith('/')&&!value.includes('\0')?value:null;
const targetId=params=>typeof params==='string'?params:params?.taskId;

/** Uses original event subscriptions. It forwards fresh Codex notifications as
 * snapshot invalidations; it does not fabricate stream deltas or task results. */
export function wrapReadEvents(input,{api,pollMs=1000,autoStart=true,useLongPolling=false}={}){
  if(!api?.get)throw Error('Readonly event adapter requires api.get');
  const channels={...input},records=new Map(),active=new Set(),metadata=new Map();
  let disposed=false,timer=null,inflight=null,sequence=null,epoch=null;
  const state={connected:false,sequence:null,epoch:null,lastError:null};
  const errors=new Emitter(),changes=new Emitter();
  function schedule(){if(!disposed&&autoStart&&active.size&&!timer){timer=setTimeout(()=>{timer=null;readPoll(useLongPolling&&sequence!==null).catch(()=>{});},state.connected?pollMs:Math.max(pollMs,1000));timer.unref?.();}}
  function activate(record){active.add(record);if(autoStart&&!disposed)pollNow().catch(()=>{});}
  function deactivate(record){active.delete(record);if(!active.size){if(timer){clearTimeout(timer);timer=null;}if(inflight?.wait)inflight.controller.abort();}}
  function event(kind,params={}){
    const name=kind+':'+JSON.stringify(params),existing=records.get(name);if(existing)return existing.emitter.event;
    const record={kind,params};record.emitter=new Emitter({onWillAddFirstListener:()=>activate(record),onDidRemoveLastListener:()=>deactivate(record)});records.set(name,record);return record.emitter.event;
  }
  const broadcastEvent=event('broadcast'),taskChanged=event('changed'),projectChanged=event('project');
  async function refreshMetadata(ids,signal){
    const missing=[...new Set(ids)].filter(id=>!metadata.has(id));
    for(let i=0;i<missing.length;i+=100){const page=await api.get('/api/threads?ids='+encodeURIComponent(missing.slice(i,i+100).join(',')),{signal});for(const thread of page.data||[])if(path(thread.cwd))metadata.set(thread.id,thread);}
  }
  function emitSnapshot(id,source,reset=false,catalogSource=null){
    const thread=metadata.get(id);
    const base={type:'task_snapshot_updated',taskId:id,
      ...(thread?{workspacePath:thread.cwd,workspaceKey:thread.cwd}:{}),
      traceId:'codex-event-'+String(source?.id??sequence),reason:reset?'history_reset':'task_status_changed',
      codexSourceMethod:source?.method||'bridge/eventsReset'};
    const list={...base,type:'workspace_task_list_changed',reason:catalogSource?.method==='thread/name/updated'?'task_meta_changed':'task_status_changed'};
    for(const record of active){
      const expected=targetId(record.params),scope=path(record.params?.workspacePath);
      if(['task','stream'].includes(record.kind)&&expected===id&&(!scope||!thread||scope===thread.cwd))record.emitter.fire(base);
      else if(record.kind==='workspace'&&thread&&scope===thread.cwd&&(reset||catalogSource))record.emitter.fire(list);
      else if(record.kind==='changed'&&(reset||catalogSource))record.emitter.fire(list);
    }
  }
  function emitCatalog(source,invalidate=true){
    if(invalidate)api[INVALIDATE_READS]?.({catalog:true});
    const payload={channel:'state:projects',payload:{source:'codex-app',method:source?.method||'bridge/eventsReset'}};
    for(const record of active){if(record.kind==='broadcast')record.emitter.fire(payload);else if(record.kind==='project')record.emitter.fire(payload.payload);}
    changes.fire(payload.payload);
  }
  async function accept(page,signal){
    if(!Number.isSafeInteger(page?.sequence)||page.sequence<0||typeof page.epoch!=='string'||!Array.isArray(page.events))throw Error('Codex event page is invalid');
    if(disposed)return;
    // Existing replay is not a new completion. Initial snapshot loads already
    // read current state; begin emitting only events after this baseline.
    if(sequence===null){sequence=page.sequence;epoch=page.epoch;state.connected=true;state.sequence=sequence;state.epoch=epoch;state.lastError=null;return;}
    const reset=page.reset||epoch!==page.epoch;
    const fresh=page.events.filter(value=>Number.isSafeInteger(value.id)&&value.id>sequence);
    // Readers after an event must not join a GET begun before that event.
    if(reset||fresh.length)api[INVALIDATE_READS]?.({catalog:reset||fresh.some(source=>catalogMethods.has(source.method))});
    if(reset){
      metadata.clear();const ids=[...active].map(value=>targetId(value.params)).filter(Boolean);await refreshMetadata(ids,signal);
      if(disposed)return;for(const id of new Set(ids))emitSnapshot(id,null,true);emitCatalog(null,false);
    }else{
      const changed=new Map(),catalogSources=new Map();let catalogSource=null;
      const snapshotIds=new Set([...active].filter(record=>record.kind==='task'||record.kind==='stream').map(record=>targetId(record.params)));
      const listsActive=[...active].some(record=>record.kind==='workspace'||record.kind==='changed');
      for(const source of fresh){
        const id=source.params?.threadId;if(catalogMethods.has(source.method))catalogSource=source;
        if(id&&catalogMethods.has(source.method))catalogSources.set(id,source);
        // Snapshot-only traffic cannot change the global task list. Resolve
        // metadata only for task/stream subscribers or actual list changes.
        if(id&&(snapshotMethods.has(source.method)||catalogMethods.has(source.method))&&(snapshotIds.has(id)||(listsActive&&catalogMethods.has(source.method))))changed.set(id,source);
      }
      await refreshMetadata([...changed.keys()],signal);if(disposed)return;
      for(const[id,source]of changed)emitSnapshot(id,source,false,catalogSources.get(id));
      for(const source of fresh)if(source.method==='turn/completed'){
        const id=source.params?.threadId,status=source.params?.turn?.status;if(status!=='completed'&&status!=='failed')continue;
        for(const record of active)if(record.kind==='terminal'&&targetId(record.params)===id)record.emitter.fire({taskId:id,outcome:status==='completed'?'succeeded':'failed'});
      }
      if(catalogSource)emitCatalog(catalogSource,false);
    }
    sequence=page.sequence;epoch=page.epoch;state.connected=true;state.sequence=sequence;state.epoch=epoch;state.lastError=null;
  }
  function readPoll(wait){
    if(disposed)return Promise.resolve();if(inflight)return inflight.promise;
    if(timer){clearTimeout(timer);timer=null;}
    const record={wait,controller:new AbortController(),promise:null};inflight=record;
    record.promise=Promise.resolve().then(async()=>{
      try{
        const page=await api.get('/api/events?since='+(sequence??0)+(wait?'&wait=1':''),{signal:record.controller.signal});
        record.wait=false;
        if(!record.controller.signal.aborted&&!disposed)await accept(page,record.controller.signal);
      }catch(error){
        if(record.controller.signal.aborted||disposed)return;
        state.connected=false;state.lastError='Codex event transport unavailable';errors.fire({code:'CODEX_EVENT_READ_UNAVAILABLE',message:state.lastError});throw error;
      }finally{if(inflight===record)inflight=null;schedule();}
    });return record.promise;
  }
  function pollNow(){
    if(disposed)return Promise.resolve();if(timer){clearTimeout(timer);timer=null;}
    const current=inflight;
    if(!current)return readPoll(false);
    if(!current.wait)return current.promise;
    // Subscribe/resync callers need an immediate baseline, never the result of
    // an idle 20-second wait. Finish cancellation before another read starts so
    // an old response cannot overtake the manual snapshot or advance its cursor.
    current.controller.abort();
    return current.promise.catch(()=>{}).then(()=>readPoll(false));
  }
  if(channels['zcode-task']){
    const service=channels['zcode-task'];channels['zcode-task']=new Proxy(service,{get(target,name,receiver){
      if(taskMethods.has(name))return params=>event(taskMethods.get(name),params);
      if(name==='onTaskChanged')return taskChanged;if(name==='onError')return errors.event;
      return Reflect.get(target,name,receiver);
    }});
  }
  if(channels.project){const service=channels.project;channels.project=new Proxy(service,{get(target,name,receiver){if(name==='onDidChange'||name==='onTaskChanged')return projectChanged;return Reflect.get(target,name,receiver);}});}
  // Phone organization changes are local writes, so no native turn event follows.
  const localCatalogSubscription=Object.hasOwn(input.project||{},'onDidChange')?input.project.onDidChange(source=>emitCatalog(source)):null;
  const originalBroadcast=channels.broadcast;
  channels.broadcast=new Proxy(originalBroadcast||{},{get(target,name,receiver){if(name==='onMessage')return broadcastEvent;return Reflect.get(target,name,receiver);}});
  return{channels,pollNow,changes:changes.event,status:state,
    capabilities:{source:'Codex JSON event API',stream:'snapshot-invalidations-only',terminalOutcome:'fresh completed/failed turns only',taskReady:false,historyReplayCompletion:false,longPolling:useLongPolling},
    dispose(){if(disposed)return;disposed=true;localCatalogSubscription?.dispose();if(timer)clearTimeout(timer);timer=null;inflight?.controller.abort();for(const record of records.values())record.emitter.dispose();records.clear();active.clear();errors.dispose();changes.dispose();state.connected=false;},
  };
}
