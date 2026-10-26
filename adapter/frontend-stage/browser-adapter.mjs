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
export async function mountCodexOriginalH5({compat,services,info,resolveNavigation,onChooseOtherDevice}){
 if(typeof compat?.__codexOriginalMount!=='function'||typeof compat?.__codexOriginalPlatform!=='function')throw Error('原版手机入口尚未接入');
 if(typeof resolveNavigation!=='function')throw Error('本机导航接口尚未接入');
 const workspaces=workspaceEntries(info);
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
 // The original detach-project action resolves a directory, then moves the
 // composer itself. Do not remount here or call a native task-creation method.
 const prepareSession=async(project={},generation=viewGeneration)=>{
  if(!currentView(generation))throw staleNavigation();
  const navigationEpoch=epoch,version=++prepareVersion;
  const result=await resolveNavigation({action:'project-draft',project});
  if(!currentView(generation)||navigationEpoch!==epoch||version!==prepareVersion)throw staleNavigation();
  const context=verify(result);
  preparedContext=context;
  return{workspacePath:context.workspacePath,projectId:context.initialTaskDraft.projectId,hostId:'local'};
 };
 let startupReads,modelCache,mountedServices;
 const replaceServices=next=>{
  if(disposed)return;
  modelCache?.dispose();startupReads?.dispose();services=next;
  startupReads=shareStartupReads(services);modelCache=cacheNavigationModels(startupReads.services);
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
  const current=++epoch,result=await resolveNavigation(request);
  if(disposed||current!==epoch)return;
  const next=verify(result);
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
   if(!workspaces.some(value=>keyOf(value)===workspaceKey))throw Error('工作区不在配对范围内');
   return navigate({action:'workspace',workspaceKey,options});
  },
  async openProjectDraft(project={}){
   const {initialComposerDraft,...options}=project;
   return navigate({action:'project-draft',project:options},initialComposerDraft);
  },
  async startDraft(workspaceKey,options={}){
   if(!workspaces.some(value=>keyOf(value)===workspaceKey))throw Error('工作区不在配对范围内');
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
   if(view&&(keyOf(view)!==keyOf(active)||view.taskId!==active.initialTaskId))return;
   active={...active,localMobileView:view};
  },
 };
 render();
 return{get switcher(){return viewSwitcher;},replaceServices(next){replaceServices(next);render();},getContext:()=>({...active}),setTransportState(value){if(!['idle','connecting','authenticating','waiting_terminal','paired','kicked','error'].includes(value))throw Error('连接状态无效');if(value!==transportState){modelCache.clear();startupReads.clear();}transportState=value;render();},dispose(){disposed=true;epoch++;viewGeneration++;prepareVersion++;preparedContext=undefined;listeners.clear();mobileNavigationListeners.clear();modelCache.dispose();startupReads.dispose();}};
}
