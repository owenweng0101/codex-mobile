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
 // The original detach-project action resolves a directory, then moves the
 // composer itself. Do not remount here or call a native task-creation method.
 const prepareSession=async(project={})=>{
  const context=verify(await resolveNavigation({action:'project-draft',project}));
  preparedContext=context;
  return{workspacePath:context.workspacePath,projectId:context.initialTaskDraft.projectId,hostId:'local'};
 };
 const modelCache=cacheNavigationModels(services);
 const mountedServices={...modelCache.services,projectService:new Proxy(services.projectService||{},{get(target,property,receiver){return property==='prepareSession'?prepareSession:Reflect.get(target,property,receiver);}})};
 const platform=compat.__codexOriginalPlatform();
 // No third-party account identity or JWT is supplied. Authentication is the
 // local paired Codex service's same-origin session cookie.
 const render=()=>compat.__codexOriginalMount({services:mountedServices,platform,key:mountKey,props:{
  composerClientNamespace:'codex-local:'+String(info.deviceId||'paired-mac'),
  initialWorkspaceAbsPath:active.workspacePath,
  initialWorkspaceIdentity:active.workspaceIdentity,
  initialTaskId:active.initialTaskId,
  initialTaskDraft:active.initialTaskDraft,
  initialSidebarFileTreeOpen:active.fileTreeOpen===true,
  initialWebRemoteControlMobileNavigationIntent:active.navigationIntent,
  webRemoteControlTerminalTransportState:transportState,
  restoreSession:false,supportsSettings:false,supportsTerminal:false,supportsReview:false,allowOpenWorkspace:false,preferDirectoryBrowser:true,supportsEmbeddedBrowser:false,allowRemoteWorkspace:false,
  webRemoteControlWorkspaceSwitcher:switcher,
 }});
 const navigate=async(request,initialComposerDraft)=>{
  const current=++epoch,result=await resolveNavigation(request);
  if(current!==epoch)return;
  const next=verify(result);
  if(initialComposerDraft&&next.initialTaskDraft)next.initialTaskDraft={...next.initialTaskDraft,initialComposerDraft};
  // Repeated taps on the same draft must not tear down a pending first send.
  const sameDraft=!active.initialTaskId&&active.initialTaskDraft&&next.initialTaskDraft&&keyOf(active)===keyOf(next)&&['projectId','provider','taskGroupId'].every(field=>active.initialTaskDraft[field]===next.initialTaskDraft[field])&&!next.initialTaskDraft.initialComposerDraft&&!next.initialTaskDraft.initialPrompt;
  if(sameDraft){if(next.navigationIntent==='chat')for(const listener of mobileNavigationListeners)listener('chat');return;}
  active=next;preparedContext=undefined;mountKey='codex-original:'+keyOf(active)+':'+(active.navigationKey||active.initialTaskId||'home')+':'+current;render();
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
   const workspace=workspaces.find(value=>keyOf(value)===workspaceKey);
   if(!workspace||keyOf(active)!==workspaceKey&&(!preparedContext||keyOf(preparedContext)!==workspaceKey))return;
   const moved=keyOf(active)!==workspaceKey;
   active={...active,workspacePath:workspace.workspacePath,workspaceIdentity:workspace.workspaceIdentity,initialTaskId:taskId||undefined,...(moved||taskId?{initialTaskDraft:taskId?undefined:preparedContext?.initialTaskDraft}:{})};
   preparedContext=undefined;
  },
  async updateMobileTaskView(view){active={...active,localMobileView:view};},
 };
 render();
 return{switcher,getContext:()=>({...active}),setTransportState(value){if(!['idle','connecting','authenticating','waiting_terminal','paired','kicked','error'].includes(value))throw Error('连接状态无效');if(value!==transportState)modelCache.clear();transportState=value;render();},dispose(){epoch++;listeners.clear();mobileNavigationListeners.clear();modelCache.dispose();}};
}
