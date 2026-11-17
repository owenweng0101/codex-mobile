// Only overlapping, byte-identical JSON reads share an RPC. Settled data is not cached.
// Subscription ACKs, resync, row ranges, commands and writes always remain independent.
export function shareStartupReads(services, {maxPending = 128} = {}) {
 const reads = {
  projectService: new Set(['readTree', 'readProjects', 'resolveSessionDirectories']),
  remoteProjectService: new Set(['readDirectory']),
  taskGroupService: new Set(['read']),
  zcodeTaskService: new Set(['getTaskMeta', 'getTaskModelSelection', 'listTasks', 'listPinnedTasks', 'listPinnedTaskIds', 'listActiveTaskIds', 'listTaskList', 'getTaskSnapshot', 'getTaskSnapshotWithEtag']),
  windowControllerService: new Set(['getTaskMeta', 'listTaskList']),
  modelSelectionService: new Set(['getView']),
  providerSettingsService: new Set(['getView']),
 };
 const pending = new Map(); let disposed = false;
 const clear = () => pending.clear();
 // JSON.stringify silently folds undefined, NaN and tokens into other keys. Bypass them.
 function jsonKey(args) {
  const seen = new Set();
  function valid(value) {
   if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
   if (typeof value === 'number') return Number.isFinite(value);
   if (!value || typeof value !== 'object' || seen.has(value)) return false;
   if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
   seen.add(value);
   const descriptors = Object.getOwnPropertyDescriptors(value);
   for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !('value' in descriptors[key]) || !valid(descriptors[key].value)) { seen.delete(value); return false; }
   }
   // Sparse arrays serialize as null entries; do not merge them with real nulls.
   const dense = !Array.isArray(value) || Object.keys(value).length === value.length;
   seen.delete(value); return dense;
  }
  return valid(args) ? JSON.stringify(args) : null;
 }
 const output = {...services};
 for (const [serviceName, service] of Object.entries(services)) {
  if (!service || typeof service !== 'object') continue;
  output[serviceName] = new Proxy(service, {get(target, method, receiver) {
   const fn = Reflect.get(target, method, receiver);
   if (typeof fn !== 'function' || typeof method !== 'string') return fn;
   // Wrap existing listeners only: no extra remote subscriptions or event payloads.
   const listener = event => (callback, ...rest) => event.call(target, function(...args) {clear();return callback.apply(this, args);}, ...rest);
   if (/^onDynamic/.test(method)) return (...args) => listener(fn.apply(target, args));
   if (/^on[A-Z]/.test(method)) return listener(fn);
   if (reads[serviceName]?.has(method)) return (...args) => {
    if (method === 'readTree' && args[0]?.refresh === true) {clear();return fn.apply(target, args);}
    const key = jsonKey(args);
    if (disposed || key === null) return fn.apply(target, args);
    const id = JSON.stringify([serviceName, method, key]);
    let entry = pending.get(id);
    const joined = !!entry;
    if (!entry) {
     entry = Promise.resolve().then(() => fn.apply(target, args)).then(original => ({original, snapshot:structuredClone(original)}));
     if (pending.size < maxPending) pending.set(id, entry);
     const done = () => {if (pending.get(id) === entry) pending.delete(id);};
     entry.then(done, done);
    }
    return entry.then(value => joined ? structuredClone(value.snapshot) : value.original);
   };
   if (/^(set|update|mutate|archive|unarchive|create|delete|send|start|stop|remove|add|admit|refresh)/.test(method)) return (...args) => {
    clear();let result;
    try {result = fn.apply(target, args);} catch(error) {clear();throw error;}
    if (result && typeof result.then === 'function') return result.finally(clear);
    clear();return result;
   };
   return fn.bind(target);
  }});
 }
 return {services:output,clear,dispose(){disposed=true;clear();}};
}

function workspaceEntries(info){
 if(info?.authenticated!==true||!Array.isArray(info.workspaces))throw Error('需要先完成 Codex 手机配对');
 return info.workspaces.map(value=>{
  const path=value.workspacePath??value.path;
  if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0'))throw Error('本机工作区信息无效');
  return{workspacePath:path,label:value.label||value.name||path,kind:'local',...(value.workspaceIdentity?{workspaceIdentity:value.workspaceIdentity}:{})};
 });
}
const keyOf=workspace=>workspace.workspaceIdentity?.trim()||workspace.workspacePath;
// These read-only views belong to the paired host, not to a particular draft.
// Keep successful reads and coalesce requests while inner workspaces remount.
export function cacheNavigationModels(services,{now=Date.now,maxAgeMs=60000}={}){
 const caches=[],subscriptions=[];
 const wrap=(service,method='getView')=>{
  if(typeof service?.[method]!=='function')return service;
  const cache=new Map();caches.push(cache);
  const subscription=service.onDidChange?.(()=>cache.clear());if(subscription)subscriptions.push(subscription);
  return new Proxy(service,{get(target,name,receiver){
   if(name==='update'||name==='refresh')return(...args)=>{cache.clear();return target[name](...args);};
   if(name!==method)return Reflect.get(target,name,receiver);
   return input=>{
    const key=JSON.stringify(input??{}),existing=cache.get(key);
    if(existing&&(existing.pending||now()-existing.time<maxAgeMs))return existing.promise;
    const entry={pending:true,time:now()};
    entry.promise=Promise.resolve().then(()=>target[method](input)).then(value=>{entry.pending=false;entry.time=now();return value;},error=>{if(cache.get(key)===entry)cache.delete(key);throw error;});
    cache.set(key,entry);if(cache.size>32)cache.delete(cache.keys().next().value);
    return entry.promise;
   };
  }});
 };
 return{services:{...services,settingService:wrap(services.settingService,'get'),modelSelectionService:wrap(services.modelSelectionService),providerSettingsService:wrap(services.providerSettingsService)},clear(){for(const cache of caches)cache.clear();},dispose(){for(const subscription of subscriptions)subscription.dispose();for(const cache of caches)cache.clear();}};
}
const TIMELINE_SELECTOR='[data-v4-timeline-scroll="true"]';
function visibleTimelineRect(target,document,window=document?.defaultView||globalThis.window){
 function paintedRect(target){
  if(!target||target.isConnected===false)return null;
  const doc=target.ownerDocument||document,view=doc.defaultView||window;
  if(doc.hidden||doc.visibilityState==='hidden')return null;
  if(typeof target.getClientRects==='function'&&!target.getClientRects().length)return null;
  for(let ancestor=target;ancestor;ancestor=ancestor.parentElement){
   if(ancestor.hidden||ancestor.inert||ancestor.getAttribute?.('aria-hidden')==='true')return null;
   const style=view?.getComputedStyle?.(ancestor);
   if(style&&(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.contentVisibility==='hidden'||style.opacity!==''&&Number(style.opacity)===0))return null;
  }
  const rect=target.getBoundingClientRect?.();
  if(!rect||!(rect.width>0&&rect.height>0))return null;
  const width=view?.innerWidth||doc.documentElement?.clientWidth||Infinity,height=view?.innerHeight||doc.documentElement?.clientHeight||Infinity;
  const left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(width,rect.left+rect.width),bottom=Math.min(height,rect.top+rect.height);
  return right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;
 }
 const rect=paintedRect(target);if(!rect)return null;
 let view=window;const visited=new Set();
 while(view&&!visited.has(view)){
  visited.add(view);let frame;try{frame=view.frameElement;}catch{break;}
  if(!frame)break;
  if(!paintedRect(frame))return null;
  view=frame.ownerDocument?.defaultView;
 }
 return rect;
}
function findVisibleTimeline(document,{window=document?.defaultView||globalThis.window,sessionId,preferred}={}){
 if(typeof document?.querySelector!=='function')return null;
 const candidates=typeof document.querySelectorAll==='function'?[...document.querySelectorAll(TIMELINE_SELECTOR)]:[document.querySelector(TIMELINE_SELECTOR)];
 const matches=target=>target&&(sessionId===undefined||target.closest?.('[data-session-id]')?.getAttribute?.('data-session-id')===sessionId)&&visibleTimelineRect(target,document,window);
 return candidates.find(target=>target===preferred&&matches(target))||candidates.find(matches)||null;
}
/**
 * Mobile older-history loader.
 *
 * The versioned original timeline prefetches older rows within two viewports and
 * keeps no user-visible affordance. When the store drops a page (window epoch
 * changed while the range read was in flight) nothing is rendered at all, so the
 * reader retries a gesture that looks broken. This adapter-level loader owns the
 * top block and the retry:
 *  - a short "加载更多 / 加载中…" block above the visible conversation;
 *  - an upward drag near the top requests the next page automatically;
 *  - a silent drop is retried, and a stalled read shows an explicit retry hint
 *    instead of disappearing.
 * It only drives the original, already-reviewed scroll handler through synthetic
 * upward intent + a real scroll offset change; it never calls the store itself.
 */
export function installOlderHistoryLoader({document=globalThis.document,window=globalThis.window,now=()=>Date.now(),pollMs=400,stallMs=15000,silentRetryMs=1600,cooldownMs=700,maxSilentPages=3,warn=(...args)=>{try{globalThis.console?.warn?.(...args);}catch{}} }={}){
 if(!document||typeof document.querySelector!=='function'||!document.body)return{dispose(){},get node(){return null;}};
 const timers=window||globalThis;
 let element=null,node=null,text=null,disposed=false,suspended=false;
 let lastTriggerAt=-Infinity,pendingSince=null,pendingLoaded=null,stalled=0,retryVisible=false,attemptStart=null,attemptLoaded=null,upAt=-Infinity,internal=false;
 // Cached React panes remain in the DOM after returning Home. Geometry alone
 // is insufficient for aria-hidden/inert ancestors, and the iframe itself can
 // be hidden by the hub without changing this document's visibilityState.
 const visibleRect=target=>disposed||suspended?null:visibleTimelineRect(target,document,window);
 const visibleTimeline=()=>disposed||suspended?null:findVisibleTimeline(document,{window,preferred:element});
 const record=()=>{
  if(!visibleRect(element))return null;
  const total=Number(element.dataset?.totalRowCount),loaded=Number(element.dataset?.windowRowCount);
  const loading=element.dataset?.loadingOlder==='true';
  return{total:Number.isFinite(total)?total:null,loaded:Number.isFinite(loaded)?loaded:null,loading,hasOlder:Number.isFinite(total)&&Number.isFinite(loaded)?loaded<total:null};
 };
 function ensureNode(){
  if(node)return node;
  node=document.createElement('div');
  node.setAttribute('data-codex-history-loader','true');
  node.setAttribute('role','status');
  node.setAttribute('aria-live','polite');
  // Match the pinned DSH older-message row, not a viewport overlay. This
  // helper-owned sibling leaves the native message layer/virtual offsets alone.
  node.style.cssText='display:none;justify-content:center;align-items:center;flex-shrink:0;width:100%;padding:4px 0';
  text=document.createElement('button');text.type='button';
  text.style.cssText='border:none;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-secondary,var(--cm-muted,#61666b));background:var(--dsw-alias-interactive-bg-hover-solid,var(--cm-hover,#eceef0));cursor:pointer;padding:4px 12px;font-family:inherit;font-size:12px;white-space:nowrap';
  if(typeof node.append==='function')node.append(text);else node.appendChild?.(text);
  text.addEventListener?.('click',event=>{event.preventDefault?.();event.stopPropagation?.();trigger('tap');});
  return node;
 }
 function place(){
  const host=element?.parentElement;
  if(!node||!visibleRect(element)||!host||host===document.body||host===document.documentElement||typeof host.insertBefore!=='function')return false;
  // Native timeline parents are flex columns. Keep the row outside the
  // scrollport so it cannot enter virtual row counts, spacers or row anchors.
  if(node.parentNode!==host||node.nextSibling!==element)host.insertBefore(node,element);
  return true;
 }
 function paint(){
  const state=record();
  if(!node||!state){bind(null);if(node)node.style.display='none';return;}
  // The host height does not shrink when this normal-flow row appears. Using
  // the reduced scrollport height here would toggle the row near the threshold.
  const nearHeight=element.parentElement?.clientHeight||element.clientHeight||0;
  const near=element.scrollTop<=Math.max(96,Math.min(nearHeight,420))||state.loading||pendingSince!==null;
  const show=state.hasOlder===true&&near;
  if(text){
   const label=retryVisible?'加载失败，重试':state.loading||pendingSince!==null&&now()-pendingSince<silentRetryMs?'加载中…':'加载更多';
   if(text.textContent!==label)text.textContent=label;
   text.disabled=state.loading;
   text.style.cursor=state.loading?'default':'pointer';
   text.style.opacity=state.loading?'.6':'1';
  }
  node.style.display=show&&place()?'flex':'none';
  node.setAttribute('aria-busy',String(state.loading));
 }
 function trigger(reason){
  if(disposed||!element)return false;
  const target=element,state=record();
  if(!state){bind(null);return false;}
  if(state.hasOlder!==true||state.loading)return false;
  if(now()-lastTriggerAt<cooldownMs)return false;
  lastTriggerAt=now();pendingSince=now();pendingLoaded=state.loaded;retryVisible=false;
  if(attemptStart===null){attemptStart=now();attemptLoaded=state.loaded;}
  stalled+=1;
  internal=true;
  try{
   const Wheel=window?.WheelEvent;
   if(typeof Wheel==='function')target.dispatchEvent(new Wheel('wheel',{deltaY:-120,bubbles:true,cancelable:true}));
  }catch{}
  // A native handler can synchronously navigate or retire its pane. Never
  // finish an old gesture against a replacement timeline or an unmounted node.
  if(target!==element||!visibleRect(target)){internal=false;tick();return false;}
  try{
   // A real offset change publishes a trusted scroll event under the fresh
   // upward intent, which is what the original handler reacts to.
   const before=target.scrollTop;
   if(before>0){target.scrollTop=before-1;target.scrollTop=before;}
   else{target.scrollTop=1;target.scrollTop=0;}
  }catch{}
  try{if(target===element&&visibleRect(target))target.dispatchEvent(new (window?.Event||Event)('scroll'));}catch{}
  internal=false;
  warn('[codex-history] 请求更早消息',{reason,scrollTop:target.scrollTop,loaded:state.loaded,total:state.total,attempt:stalled});
  paint();
  return true;
 }
 function progress(){
  const state=record();
  if(!state){bind(null);return;}
  if(pendingSince!==null&&state.loaded!==null&&state.loaded!==pendingLoaded){pendingSince=null;retryVisible=false;stalled=0;attemptStart=null;attemptLoaded=null;}
  if(attemptStart!==null&&attemptLoaded!==null&&state.loaded!==null&&state.loaded>attemptLoaded){attemptStart=null;attemptLoaded=null;retryVisible=false;stalled=0;}
  if(pendingSince!==null&&!state.loading&&now()-pendingSince>=silentRetryMs){
   // The store finished the read but kept no new rows: it silently discarded the
   // page (epoch moved). Retry the gesture a bounded number of times.
   pendingSince=null;
   if(stalled<maxSilentPages){warn('[codex-history] 更早消息没有增加，自动重试',{loaded:state.loaded,total:state.total,attempt:stalled});if(trigger('silent-retry'))return;}
   else{retryVisible=true;warn('[codex-history] 多次重试仍没有更早消息，显示可重试提示',{loaded:state.loaded,total:state.total});}
  }
  if(attemptStart!==null&&!retryVisible&&now()-attemptStart>=stallMs&&(state.loaded??0)===(attemptLoaded??0)){retryVisible=true;warn('[codex-history] 更早消息 15 秒内没有加载成功，显示重试提示',{loaded:state.loaded,total:state.total});}
  if(state.hasOlder===false){pendingSince=null;attemptStart=null;attemptLoaded=null;retryVisible=false;stalled=0;if(node)node.style.display='none';}
  paint();
 }
 function ownsEvent(event){
  if(disposed||internal||event?.currentTarget&&event.currentTarget!==element)return false;
  if(!visibleRect(element)){bind(null);return false;}
  return true;
 }
 function onScroll(event){
  if(!ownsEvent(event))return;
  const state=record();
  if(!state||state.hasOlder!==true)return;
  const top=element.scrollTop;
  if(top<=Math.max(96,Math.min(element.clientHeight||0,420))&&now()-upAt<=1400)trigger('scroll');
  else if(top<=2)trigger('scroll-top');
 }
 function onWheel(event){
  if(!event||!ownsEvent(event))return;
  if((event.deltaY??0)<0){upAt=now();if(element.scrollTop<=Math.max(96,Math.min(element.clientHeight||0,420)))trigger('wheel');}
 }
 let lastTouchY=null;
 function onTouchStart(event){if(ownsEvent(event))lastTouchY=event?.touches?.[0]?.clientY??null;}
 function onTouchMove(event){
  if(!ownsEvent(event))return;
  const y=event?.touches?.[0]?.clientY;if(y===undefined||lastTouchY===null){lastTouchY=y??lastTouchY;return;}
  const upward=y>lastTouchY;lastTouchY=y;
  if(!upward)return;
  upAt=now();
  if(element.scrollTop<=Math.max(96,Math.min(element.clientHeight||0,420)))trigger('touch');
 }
 function detach(){
  if(node){node.style.display='none';node.remove?.();}
  if(!element)return;
  element.removeEventListener?.('scroll',onScroll);
  element.removeEventListener?.('wheel',onWheel);
  element.removeEventListener?.('touchstart',onTouchStart,{passive:true});
  element.removeEventListener?.('touchmove',onTouchMove,{passive:true});
  element=null;
 }
 function bind(next){
  if(next===element)return;
  detach();
  // A different conversation must not inherit an exhausted page, old gesture,
  // pending retry or cooldown from the timeline that just unmounted.
  lastTriggerAt=-Infinity;pendingSince=null;pendingLoaded=null;stalled=0;retryVisible=false;attemptStart=null;attemptLoaded=null;upAt=-Infinity;lastTouchY=null;
  element=next||null;
  if(!element){if(node)node.style.display='none';return;}
  element.addEventListener?.('scroll',onScroll);
  element.addEventListener?.('wheel',onWheel);
  element.addEventListener?.('touchstart',onTouchStart,{passive:true});
  element.addEventListener?.('touchmove',onTouchMove,{passive:true});
  ensureNode();paint();
 }
 const tick=()=>{if(disposed)return;bind(visibleTimeline());progress();};
 const observers=[],listeners=[];
 const listen=(target,type,handler)=>{if(typeof target?.addEventListener==='function'){target.addEventListener(type,handler);listeners.push(()=>target.removeEventListener(type,handler));}};
 // React navigation is a DOM change, not necessarily a browser navigation.
 // Observe same-origin frame ancestors too: switching the hub tab may only hide
 // its iframe container, without firing visibilitychange inside the iframe.
 const documents=new Set();let observed=document;
 while(observed&&!documents.has(observed)){
  documents.add(observed);
  const Observer=observed.defaultView?.MutationObserver||window?.MutationObserver;
  if(typeof Observer==='function'){
   const observer=new Observer(records=>{
    if(records.some(record=>record.target!==node&&!node?.contains?.(record.target)))tick();
   });
   observer.observe(observed.documentElement||observed.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','inert','data-state','data-total-row-count','data-window-row-count','data-loading-older']});observers.push(observer);
  }
  listen(observed,'visibilitychange',tick);
  try{observed=observed.defaultView?.frameElement?.ownerDocument;}catch{observed=null;}
 }
 const suspend=()=>{suspended=true;bind(null);},resume=()=>{suspended=false;tick();};
 listen(window,'pagehide',suspend);listen(window,'pageshow',resume);
 listen(document,'freeze',suspend);listen(document,'resume',resume);
 listen(window,'resize',tick);listen(window,'popstate',tick);
 listen(window?.visualViewport,'resize',tick);listen(window?.visualViewport,'scroll',tick);
 tick();
 const interval=timers?.setInterval?.(tick,pollMs);
 return{dispose(){if(disposed)return;disposed=true;timers?.clearInterval?.(interval);for(const observer of observers)observer.disconnect();for(const remove of listeners)remove();detach();node?.remove?.();node=null;},get node(){return node;},get element(){return element;},trigger};
}
// Observe existing reads and their rendered result. Never subscribe or fetch here.
export function createInitialContentReadiness({document,getContext,viewReported=()=>true,requestFrame=globalThis.requestAnimationFrame}={}){
 const enabled=typeof document?.querySelector==='function';
 const snapshots=new Map(),acknowledged=new Set();let catalogue=false,settled=enabled?'loading':'ready',failure,disposed=false,observer,resolveReady,rejectReady;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;if(!enabled)resolve();});
 // An early rejected subscription can precede the bootstrap's await.
 ready.catch(()=>{});
 const stats={frameListeners:0,frames:0,subscriptions:0,acks:0,matchingSnapshots:0,lastFrame:null};
 const workspaceCurrent=p=>p?.workspacePath===getContext()?.workspacePath&&(p?.workspaceIdentity||null)===(getContext()?.workspaceIdentity||null);
 const current=p=>workspaceCurrent(p)&&p?.sessionId===getContext()?.initialTaskId;
 function details(){
  const context=getContext(),key=context.workspacePath+'\0'+context.initialTaskId,expected=snapshots.get(key),timeline=context.initialTaskId?findVisibleTimeline(document,{sessionId:context.initialTaskId}):null;
  const number=value=>value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
  return{state:settled,disposed,viewReported:Boolean(viewReported()),hasTask:Boolean(context.initialTaskId),catalogue,acknowledged:acknowledged.has(key),snapshot:expected?{totalRows:expected.total,windowRows:expected.loaded}:null,timeline:{present:Boolean(timeline),totalRows:number(timeline?.dataset?.totalRowCount),windowRows:number(timeline?.dataset?.windowRowCount),hasRenderedRow:Boolean(timeline?.querySelector?.('[data-row-id]'))},observed:{...stats}};
 }
 function check(){
  if(disposed||settled!=='loading'||!viewReported())return settled;
  const context=getContext();
  if(context.initialTaskId){
   const key=context.workspacePath+'\0'+context.initialTaskId,expected=snapshots.get(key),timeline=findVisibleTimeline(document,{sessionId:context.initialTaskId});
   if((!expected&&!acknowledged.has(key))||!timeline)return 'loading';
   const rawTotal=timeline.dataset?.totalRowCount,rawLoaded=timeline.dataset?.windowRowCount;
   if(rawTotal===undefined||rawLoaded===undefined||!Number.isFinite(Number(rawTotal))||!Number.isFinite(Number(rawLoaded))||Number(rawTotal)<0||Number(rawLoaded)<0)return 'loading';
   // Raw snapshot rows and the virtual/rendered window need not have the same
   // cardinality (grouping, pruning, recovery or live output). Wait for actual
   // committed rows, not for an old count that may never occur again.
   const rendered=Number(rawTotal)>0&&Number(rawLoaded)>0&&timeline.querySelector?.('[data-row-id]');
   const empty=expected?.total===0&&expected.loaded===0&&Number(rawTotal)===0&&Number(rawLoaded)===0;
   if(!rendered&&!empty)return 'loading';
  }else if(!catalogue||!document.querySelector('[data-testid="sidebar-primary-navigation"]'))return 'loading';
  settled='ready';observer?.disconnect();resolveReady();return settled;
 }
 const changed=()=>{check();if(settled==='loading')requestFrame?.(check);};
 function fail(error){if(disposed||settled!=='loading')return;failure=error;settled='error';observer?.disconnect();rejectReady(error);}
 function wrap(services){
  if(!enabled)return services;
  return Object.fromEntries(Object.entries(services).map(([name,service])=>{
   if(!service||typeof service!=='object')return[name,service];
   return[name,new Proxy(service,{get(target,method,receiver){
    const fn=Reflect.get(target,method,receiver);if(typeof fn!=='function')return fn;
    if(method==='onDynamicConversationFrame')return(...args)=>{
     const event=fn.apply(target,args),params=args[0];stats.frameListeners++;
     return(callback,...rest)=>event.call(target,function(...values){
      const result=callback.apply(this,values),wire=values[0],snapshot=wire?.frame?.payload?.kind==='snapshot'?wire.frame.payload.snapshot:null;
      // The actual native listener is workspace-scoped, NOT session-scoped.
      // Its snapshot carries sessionId and both wire/logical topics bind it to
      // the current task. Requiring params.sessionId dropped every real frame.
      const sessionId=snapshot?.sessionId,workspaceMatch=workspaceCurrent(params);
      const taskMatch=typeof sessionId==='string'&&sessionId===getContext()?.initialTaskId&&(!params?.sessionId||params.sessionId===sessionId);
      const topicMatch=[wire?.topic,wire?.frame?.topic].every(topic=>topic===undefined||topic==='conversation/'+sessionId);
      stats.frames++;stats.lastFrame={kind:['complete','chunk'].includes(wire?.kind)?wire.kind:'other',hasSnapshot:Boolean(snapshot),hasSessionParameter:typeof params?.sessionId==='string',workspaceMatch,taskMatch,topicMatch};
      if(workspaceMatch&&taskMatch&&topicMatch&&snapshot?.rows&&Array.isArray(snapshot.rows.window)&&Number.isFinite(snapshot.rows.totalCount)){
       stats.matchingSnapshots++;snapshots.set(params.workspacePath+'\0'+sessionId,{total:snapshot.rows.totalCount,loaded:snapshot.rows.window.length});changed();
      }
      return result;
     },...rest);
    };
    if(method==='subscribeConversationV4')return(...args)=>Promise.resolve().then(()=>{stats.subscriptions++;return fn.apply(target,args);}).then(value=>{
     // This adapter publishes history before ACK; the original replay buffer may
     // consume it without this observer seeing a complete wire snapshot (e.g.
     // chunked/recovery paths). ACK alone is never ready: check() also needs rows.
     if(current(args[0])&&value?.ack?.mode==='snapshot'&&typeof value.ack.subscriptionId==='string'){
      stats.acks++;acknowledged.add(args[0].workspacePath+'\0'+args[0].sessionId);changed();
     }
     return value;
    },error=>{if(current(args[0]))fail(error);throw error;});
    if(name==='projectService'&&method==='readTree')return(...args)=>Promise.resolve().then(()=>fn.apply(target,args)).then(value=>{catalogue=true;changed();return value;},error=>{if(!getContext()?.initialTaskId)fail(error);throw error;});
    return fn.bind(target);
   }})];
  }));
 }
 if(enabled&&document.body){
  const cleanups=[],documents=new Set();let observed=document;
  observer={disconnect(){for(const cleanup of cleanups)cleanup();}};
  while(observed&&!documents.has(observed)){
   const target=observed;documents.add(target);
   const Observer=target.defaultView?.MutationObserver||globalThis.MutationObserver;
   if(typeof Observer==='function'){
    const watch=new Observer(check);watch.observe(target.body||target.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-window-row-count','data-total-row-count','data-session-id','class','style','hidden','aria-hidden','inert']});cleanups.push(()=>watch.disconnect());
   }
   if(typeof target.addEventListener==='function'){target.addEventListener('visibilitychange',check);cleanups.push(()=>target.removeEventListener('visibilitychange',check));}
   try{observed=target.defaultView?.frameElement?.ownerDocument;}catch{observed=null;}
  }
 }
 return{wrap,check,ready,details,get error(){return failure;},dispose(){disposed=true;observer?.disconnect();resolveReady();}};
}

export async function mountCodexOriginalH5({compat,services,info,resolveNavigation,refreshWorkspaceInfo,onChooseOtherDevice,viewStorage}){
 if(typeof compat?.__codexOriginalMount!=='function'||typeof compat?.__codexOriginalPlatform!=='function')throw Error('原版手机入口尚未接入');
 if(typeof resolveNavigation!=='function')throw Error('本机导航接口尚未接入');
 let workspaces=workspaceEntries(info),workspaceRefresh;
 if(!workspaces.length)throw Error('没有可用的 Codex 项目或会话目录');
 const listeners=new Set(),mobileNavigationListeners=new Set();
 let active={workspacePath:info.initialWorkspaceAbsPath||workspaces[0].workspacePath,...(info.initialWorkspaceIdentity||workspaces[0].workspaceIdentity?{workspaceIdentity:info.initialWorkspaceIdentity||workspaces[0].workspaceIdentity}:{}),...(info.initialTaskId?{initialTaskId:info.initialTaskId}:{})},epoch=0,transportState='paired';
 const verify=context=>{
  if(!context||!workspaces.some(value=>value.workspacePath===context.workspacePath&&(value.workspaceIdentity||null)===(context.workspaceIdentity||null)))throw Error('导航目标不在已配对工作区范围内');
  return context;
 };
 verify(active);
 let mountKey='codex-original:'+keyOf(active)+':'+(active.initialTaskId||'home'),preparedContext;
 let disposed=false,viewGeneration=0,prepareVersion=0,renderedGeneration=-1,viewSwitcher,viewServices,renderedServices;
 const currentView=generation=>!disposed&&generation===viewGeneration;
 const staleNavigation=()=>Object.assign(Error('导航已切换，请在当前视图重试'),{code:'CODEX_NAVIGATION_STALE'});
 const refreshWorkspaces=()=>{
  if(!workspaceRefresh){
   const pending=Promise.resolve().then(()=>refreshWorkspaceInfo()).then(value=>{const next=workspaceEntries(value);if(!disposed)workspaces=next;});
   workspaceRefresh=pending;const clear=()=>{if(workspaceRefresh===pending)workspaceRefresh=undefined;};pending.then(clear,clear);
  }
  return workspaceRefresh;
 };
 const ensureWorkspace=async workspaceKey=>{
  if(!workspaces.some(value=>keyOf(value)===workspaceKey)&&refreshWorkspaceInfo)await refreshWorkspaces();
  if(!workspaces.some(value=>keyOf(value)===workspaceKey))throw Error('工作区不在配对范围内');
 };
 const verifyNavigation=async context=>{
  if(context&&!workspaces.some(value=>value.workspacePath===context.workspacePath&&(value.workspaceIdentity||null)===(context.workspaceIdentity||null))&&refreshWorkspaceInfo)await refreshWorkspaces();
  return verify(context);
 };
 // Per-tab state survives reload without making separate mobile tabs share navigation.
 let storage=viewStorage;
 if(storage===undefined)try{storage=globalThis.sessionStorage;}catch{}
 const storageKey='codex-mobile-current-view-v1';
 let unloading=false;
 const onUnload=()=>{unloading=true;};
 const onResume=()=>{unloading=false;};
 globalThis.addEventListener?.('beforeunload',onUnload);
 // Mobile WebKit can hide/freeze the document without a beforeunload event.
 // Capture pagehide before the original reporter emits its empty visibility view.
 globalThis.addEventListener?.('pagehide',onUnload,true);
 globalThis.addEventListener?.('pageshow',onResume,true);
 globalThis.document?.addEventListener?.('freeze',onUnload,true);
 globalThis.document?.addEventListener?.('resume',onResume,true);
 const removeLifecycleListeners=()=>{globalThis.removeEventListener?.('beforeunload',onUnload);globalThis.removeEventListener?.('pagehide',onUnload,true);globalThis.removeEventListener?.('pageshow',onResume,true);globalThis.document?.removeEventListener?.('freeze',onUnload,true);globalThis.document?.removeEventListener?.('resume',onResume,true);};
 const saveView=view=>{
  const value=view?{workspacePath:view.workspacePath,taskId:view.taskId}:null;
  try{if(value)storage?.setItem(storageKey,JSON.stringify(value));else storage?.removeItem(storageKey);}catch{}
  // The current history entry is per-tab too, and survives a lost storage write.
  try{const history=globalThis.history;if(history?.replaceState)history.replaceState({...history.state,codexMobileView:value?{kind:'task',...value}:{kind:'home'},...(!value?{zcodeMobilePage:'home'}:{})},'');}catch{}
 };
 if(!info.initialTaskId){
  let saved;try{saved=JSON.parse(storage?.getItem(storageKey)||'null');}catch{}
  const historyState=globalThis.history?.state,checkpoint=historyState?.codexMobileView;
  if(saved?.kind==='home'||checkpoint?.kind==='home')saved=null;
  else if(historyState?.zcodeMobilePage==='chat'&&checkpoint?.kind==='task')saved=checkpoint;
  if(typeof saved?.workspacePath==='string'&&typeof saved?.taskId==='string'&&saved.taskId.length<=256){
   try{
    const restored=await resolveNavigation({action:'workspace',workspaceKey:saved.workspacePath,options:{taskId:saved.taskId,mobileNavigationIntent:'chat'}});
    active=await verifyNavigation(restored);
    mountKey='codex-original:'+keyOf(active)+':'+active.initialTaskId;
   }catch(error){
    // Transient transport/auth failures must leave the original page recoverable.
    if((error?.status&&![400,404,410].includes(error.status))||['TypeError','AbortError','TimeoutError'].includes(error?.name)){removeLifecycleListeners();throw error;}
    saveView(null);
   }
  }
 }
 // Mounting the React root does not mean the restored task has committed.
 // Keep startup covered until its real visible-view reporter confirms the task.
 let initialViewReported=!active.initialTaskId,resolveInitialView;
 const initialViewReady=new Promise(resolve=>{resolveInitialView=resolve;if(initialViewReported)resolve();});
 // The original detach-project action resolves a directory, then moves the
 // composer itself. Do not remount here or call a native task-creation method.
 const prepareSession=async(project={},generation=viewGeneration)=>{
  if(!currentView(generation))throw staleNavigation();
  const navigationEpoch=epoch,version=++prepareVersion;
  const result=await resolveNavigation({action:'project-draft',project});
  if(!currentView(generation)||navigationEpoch!==epoch||version!==prepareVersion)throw staleNavigation();
  const context=await verifyNavigation(result);
  if(!currentView(generation)||navigationEpoch!==epoch||version!==prepareVersion)throw staleNavigation();
  preparedContext=context;
  return{workspacePath:context.workspacePath,projectId:context.initialTaskDraft.projectId,hostId:'local'};
 };
 const contentReadiness=createInitialContentReadiness({document:globalThis.document,getContext:()=>active,viewReported:()=>initialViewReported});
 let startupReads,modelCache,mountedServices;
 const replaceServices=next=>{
  if(disposed)return;
  modelCache?.dispose();startupReads?.dispose();services=next;
  startupReads=shareStartupReads(contentReadiness.wrap(services));modelCache=cacheNavigationModels(startupReads.services);
  mountedServices={...modelCache.services,projectService:new Proxy(modelCache.services.projectService||{},{get(target,property,receiver){return property==='prepareSession'?prepareSession:Reflect.get(target,property,receiver);}})};
 };
 replaceServices(services);
 const platform=compat.__codexOriginalPlatform();
 // No third-party account identity or JWT is supplied. Authentication is the
 // local paired Codex service's same-origin session cookie.
 const render=()=>{
  if(disposed)return;
  const generation=viewGeneration;
  if(renderedGeneration!==generation){
   // Navigation owns its reporters; reconnects keep that owner and composer.
   viewSwitcher={...switcher,
    updateMobileViewState:async(...args)=>{if(currentView(generation))return switcher.updateMobileViewState(...args);},
    updateMobileTaskView:async(...args)=>{if(currentView(generation))return switcher.updateMobileTaskView(...args);},
   };
  }
  if(renderedGeneration!==generation||renderedServices!==mountedServices){
   viewServices={...mountedServices,projectService:new Proxy(mountedServices.projectService,{get(target,property,receiver){return property==='prepareSession'?(project=>prepareSession(project,generation)):Reflect.get(target,property,receiver);}})};
   renderedServices=mountedServices;renderedGeneration=generation;
  }
  return compat.__codexOriginalMount({services:viewServices,platform,key:mountKey,props:{
  composerClientNamespace:'codex-local:'+String(info.deviceId||'paired-mac'),
  initialWorkspaceAbsPath:active.workspacePath,
  initialWorkspaceIdentity:active.workspaceIdentity,
  initialTaskId:active.initialTaskId,
  initialTaskDraft:active.initialTaskDraft,
  initialSidebarFileTreeOpen:active.fileTreeOpen===true,
  initialWebRemoteControlMobileNavigationIntent:active.navigationIntent,
  webRemoteControlTerminalTransportState:transportState,
  restoreSession:false,supportsSettings:false,supportsTerminal:false,supportsReview:false,allowOpenWorkspace:false,preferDirectoryBrowser:true,supportsEmbeddedBrowser:false,allowRemoteWorkspace:false,
  webRemoteControlWorkspaceSwitcher:viewSwitcher,
 }});
 };
 const navigate=async(request,initialComposerDraft)=>{
  if(disposed)throw staleNavigation();
  const current=++epoch;
  if((request.action==='workspace'||request.action==='draft')&&!workspaces.some(value=>keyOf(value)===request.workspaceKey))await ensureWorkspace(request.workspaceKey);
  if(disposed||current!==epoch)return;
  const result=await resolveNavigation(request);
  if(disposed||current!==epoch)return;
  const next=await verifyNavigation(result);
  if(disposed||current!==epoch)return;
  if(initialComposerDraft&&next.initialTaskDraft)next.initialTaskDraft={...next.initialTaskDraft,initialComposerDraft};
  // Repeated taps on the same draft must not tear down a pending first send.
  const sameDraft=!active.initialTaskId&&active.initialTaskDraft&&next.initialTaskDraft&&keyOf(active)===keyOf(next)&&['projectId','provider','taskGroupId'].every(field=>active.initialTaskDraft[field]===next.initialTaskDraft[field])&&!next.initialTaskDraft.initialComposerDraft&&!next.initialTaskDraft.initialPrompt;
  if(sameDraft){if(next.navigationIntent==='chat')for(const listener of mobileNavigationListeners)listener('chat');return;}
  active=next;preparedContext=undefined;viewGeneration++;prepareVersion++;mountKey='codex-original:'+keyOf(active)+':'+(active.navigationKey||active.initialTaskId||'home')+':'+current;render();
  if(next.navigationIntent==='chat')for(const listener of mobileNavigationListeners)listener('chat');
  for(const listener of listeners)listener(await switcher.listWorkspaces());
 };
 const switcher={
  ...(onChooseOtherDevice?{deviceNavigation:{deviceName:info.deviceName||'Codex · 当前 Mac',devicePlatform:info.devicePlatform||'darwin',chooseOtherDevice:onChooseOtherDevice}}:{}),
  async listWorkspaces(){return{workspaces,activeWorkspaceKey:keyOf(active),...(active.initialTaskId?{activeTaskId:active.initialTaskId}:{})};},
  onWorkspaceListUpdated(listener){listeners.add(listener);return()=>listeners.delete(listener);},
  onMobileNavigationRequested(listener){mobileNavigationListeners.add(listener);return()=>mobileNavigationListeners.delete(listener);},
  async switchWorkspace(workspaceKey,options={}){
   return navigate({action:'workspace',workspaceKey,options});
  },
  async openProjectDraft(project={}){
   const {initialComposerDraft,...options}=project;
   return navigate({action:'project-draft',project:options},initialComposerDraft);
  },
  async startDraft(workspaceKey,options={}){
   const {initialComposerDraft,...draftOptions}=options;
   return navigate({action:'draft',workspaceKey,options:draftOptions},initialComposerDraft);
  },
  async reconnectWorkspace(workspaceKey){return navigate({action:'reconnect',workspaceKey});},
  async updateMobileViewState(workspaceKey,taskId){
   if(disposed)return;
   const workspace=workspaces.find(value=>keyOf(value)===workspaceKey);
   if(!workspace||keyOf(active)!==workspaceKey&&(!preparedContext||keyOf(preparedContext)!==workspaceKey))return;
   const moved=keyOf(active)!==workspaceKey;
   const prepared=preparedContext&&keyOf(preparedContext)===workspaceKey;
   if(!moved&&(taskId||undefined)===active.initialTaskId&&(!prepared||taskId))return;
   // Empty passive reports cannot undo a selected task or first-send promotion.
   if(!taskId&&active.initialTaskId&&!prepared)return;
   if(moved||(taskId||undefined)!==active.initialTaskId||prepared)prepareVersion++;
   active={...active,workspacePath:workspace.workspacePath,workspaceIdentity:workspace.workspaceIdentity,initialTaskId:taskId||undefined,...(moved||taskId||prepared?{initialTaskDraft:taskId?undefined:preparedContext?.initialTaskDraft}:{})};
   preparedContext=undefined;
  },
  async updateMobileTaskView(view){
   if(disposed)return;
   // React's initial home/cleanup report must not erase the saved restore target.
   if(!initialViewReported&&!view)return;
   if(view&&(keyOf(view)!==keyOf(active)||view.taskId!==active.initialTaskId))return;
   active={...active,localMobileView:view};
   if(view&&!initialViewReported){initialViewReported=true;resolveInitialView();}contentReadiness.check();
   const hidden=globalThis.document?.visibilityState==='hidden';
   const stillOnChat=globalThis.history?.state?.zcodeMobilePage==='chat';
   if(view||!unloading&&!hidden&&!stillOnChat)saveView(view);
  },
 };
 render();
 // The bridge shell has no load-more affordance of its own. Keep one attached to
 // the live timeline so an upward drag always requests the next older page.
 const olderHistory=globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?installOlderHistoryLoader():{dispose(){}};
 return{initialViewReady,initialContentReady:contentReadiness.ready,getReadiness:contentReadiness.check,getReadinessDetails:contentReadiness.details,get switcher(){return viewSwitcher;},replaceServices(next){replaceServices(next);render();},getContext:()=>({...active}),setTransportState(value){if(!['idle','connecting','authenticating','waiting_terminal','paired','kicked','error'].includes(value))throw Error('连接状态无效');if(value!==transportState){modelCache.clear();startupReads.clear();}transportState=value;render();},dispose(){removeLifecycleListeners();olderHistory.dispose();contentReadiness.dispose();resolveInitialView();disposed=true;epoch++;viewGeneration++;prepareVersion++;preparedContext=undefined;listeners.clear();mobileNavigationListeners.clear();modelCache.dispose();startupReads.dispose();}};
}
