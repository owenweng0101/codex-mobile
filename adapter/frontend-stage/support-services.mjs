import {randomUUID} from 'node:crypto';
import {Emitter} from '../vendor/rpc.mjs';
import {createFileReadService} from '../read-services/files.mjs';

const reason='This ZCode-only capability is disabled in the paired Codex adapter';
function unsupported(channel,method){return Object.assign(Error(channel+'.'+method+': '+reason),{code:'CODEX_ADAPTER_UNSUPPORTED'});}
// Unknown methods reject synchronously through the original ProxyChannel; they
// must never be queued as an unknown service or silently report success.
function closedService(channel,methods={}){return new Proxy(methods,{get(target,key){if(key==='then')return undefined;if(typeof key!=='string'||Reflect.has(target,key))return Reflect.get(target,key);return()=>{throw unsupported(channel,key);};}});}

export function createSupportServices({api,baseServices={},writable=false}={}){
 if(typeof api?.get!=='function')throw Error('需要真实 Codex 读取客户端');
 const localMessages=new Emitter(),connectionId=randomUUID();
 let clientId=null;
 const disabled={available:false,enabled:false,disabled:true,reason:'not-applicable-to-codex',source:'codex-adapter-policy'};
 async function scope(params){
  const path=params?.workspacePath;
  if(typeof path!=='string'||!path.startsWith('/')||path.includes('\0'))throw Object.assign(Error('请选择真实 Codex 工作目录'),{code:'CODEX_WORKSPACE_MISMATCH'});
  if(typeof baseServices.project?.readTree!=='function')throw unsupported('scope','readTree');
  const tree=await baseServices.project.readTree();
  const roots=(tree.projects||[]).flatMap(project=>(project.roots||[]).map(root=>root.rootPath??root.path));
  const known=tree.conversationWorkspacePath===path||roots.includes(path)||(tree.tasks||[]).some(task=>task.workspacePath===path);
  if(!known||params.workspaceIdentity)throw Object.assign(Error('工作目录不在当前本机 Codex 范围内'),{code:'CODEX_WORKSPACE_MISMATCH'});
  return path;
 }
 async function initialize(params){
  const path=await scope(params),status=await api.get('/api/status');
  return{available:status.online===true,workspaceKey:path,backend:'codex-app',readOnly:!writable,capabilities:{readHistory:status.online===true,write:writable&&status.desktopOnline===true,nativeDialogs:false,localTerminal:false},...(status.online===true?{}:{reason:'codex-read-connection-unavailable'})};
 }
 async function skillCatalog(params){
  const path=await scope(params),result=await api.get('/api/skills?cwd='+encodeURIComponent(path));
  if(!Array.isArray(result?.data))throw Error('Codex 技能目录响应无效');
  const skills=result.data.map(skill=>{
   if(!skill||typeof skill.name!=='string'||!skill.name.trim()||typeof skill.path!=='string'||!skill.path.startsWith('/')||skill.path.includes('\0')||typeof skill.enabled!=='boolean'||!['user','repo','system','admin'].includes(skill.scope))throw Error('Codex 技能目录条目无效');
   // UI grouping only; keep exact native identity/path/scope. Never pretend a
   // Codex skill has a glm ID or lives in a ZCode directory to bypass UI filters.
   return{id:'codex:'+skill.path,name:skill.name,path:skill.path,description:typeof skill.description==='string'?skill.description:'',displayName:skill.displayName||skill.name,enabled:skill.enabled,scope:skill.pluginId?'plugin':skill.scope==='repo'?'workspace':'user',nativeScope:skill.scope,...(skill.pluginId?{pluginId:skill.pluginId}:{}),source:'codex'};
  });
  return{skills,capability:{userScopeAvailable:true,readOnly:true,source:'codex'},diagnostics:Array.isArray(result.errors)?result.errors:[]};
 }
 const services={
  file:closedService('file',createFileReadService({api,baseServices})),
  broadcast:closedService('broadcast',{
   async send(message){
    if(!message||typeof message.channel!=='string'||message.channel.length>200||Buffer.byteLength(JSON.stringify(message))>65536)throw Error('本适配器广播消息无效');
    localMessages.fire(message);
   },
   onMessage:localMessages.event,
  }),
  'coding-plan-subscription':closedService('coding-plan-subscription',{
   async getDynamicWorkflowClientConfig(){return{...disabled};},
   async getRequestVerificationConfig(){return{...disabled,skipModelRequest:true};},
  }),
  'marketing-touch':closedService('marketing-touch',{
   async query(){return{...disabled,scope:'codex-local-disabled',deliveries:[]};},
  }),
  'client-scenes':closedService('client-scenes',{
   async list(){return{...disabled,code:0,msg:'ZCode cloud suggestions are disabled for this Codex adapter',data:[]};},
  }),
  'onboarding-record':closedService('onboarding-record',{
   async getOnboardingEligibility(){return{...disabled,shouldOnboard:false,recordFileExisted:false};},
   async shouldOnboard(){return false;},
   async getLatestEntry(){return null;},
   async getRecords(){return null;},
   async syncSettingsFromRecord(){return null;},
   // claimAnonymousRecord/appendRecord/record mutation remain unavailable.
  }),
  'settings-sync':closedService('settings-sync',{
   // The original UI understands only `handled`; here it is an explicit
   // disabled-feature policy, not a claim of migrated settings or user action.
   async getFirstRunPromptState(){return{...disabled,handled:true,decision:'skip-zcode-settings-import'};},
  }),
  subagents:closedService('subagents',{
   async list(params){await scope(params);return{agents:[],capability:{supported:false,reason:'native-subagent-catalog-not-adapted'}};},
  }),
  skills:closedService('skills',{
   async list(params){return skillCatalog(params);},
  }),
  git:closedService('git'),
  'window-controller':closedService('window-controller'),
  'zcode-agent':closedService('zcode-agent',{
   async initialize(params){return initialize(params);},
   // The composer uses this method, not skills.list. This is a cwd catalog,
   // not a claim that a ZCode session runtime activated any of its skills.
   async getSkillReferenceCatalog(params){const result=await skillCatalog(params);return{...result,authority:null};},
   // The adapter owns no ZCode agent runtime and emits no restart events.
   onAgentRuntimeRestarted(){return{dispose(){}};},
   async helloConversationV4(){
    const status=await api.get('/api/status');
    if(status.online!==true)throw Object.assign(Error('Codex 只读连接暂不可用'),{code:'CODEX_OFFLINE'});
    return{kind:'hello',protocolVersion:3,connectionId,clientMode:'web-remote-replayable',deliveryProfile:'replayable',serverTime:Date.now(),capabilities:{nativeDialogs:false,localTerminal:false,binaryFrames:false,compression:'none',workspaceHookReview:false,independentPlanState:false,workflowRunDeltas:false,historyFirst:false},auth:{}};
   },
   async initializeConversationV4(hello){
    if(hello?.kind!=='clientHello'||hello.protocolVersion!==3||typeof hello.clientId!=='string'||!hello.clientId||hello.clientId.length>200)throw Error('客户端协议握手无效');
    if(clientId!==null&&clientId!==hello.clientId)throw Error('fault.connection.clientChanged');
    clientId=hello.clientId;
   },
  }),
  'zcode-session':closedService('zcode-session',{
   async initializeWorkspace(params){return initialize(params);},
   async readWorkspacePresentation(params){await scope(params);return{mode:'build',slashCommands:[],readOnly:!writable,backend:'codex-app',capabilities:{slashCommands:false,write:writable},presentationSource:'adapter-default'};},
  }),
 };
 // Complete the original platform's signed-out restore reads without touching
 // the real ZCode credential store or claiming a third-party account identity.
 if(baseServices.oauth)services.oauth=closedService('oauth',{
  ...baseServices.oauth,
  async restoreCachedSession(){return null;},
  async restoreCachedSessionState(){return{status:'signed-out'};},
  async restoreSession(){return null;},
 });
 return services;
}
