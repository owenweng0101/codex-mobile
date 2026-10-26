import {Emitter} from '../vendor/rpc.mjs';

const unavailable=()=>{throw Object.assign(Error('此入口使用已配对的本机 Codex；该 ZCode 账户或模型配置操作未开放'),{code:'CODEX_ADAPTER_UNSUPPORTED'});};
const noCloudEvent=()=>({dispose(){}});
export function createPlatformServices({api,stateDir}={}){
 if(typeof api?.get!=='function')throw Error('需要本机 Codex 读取客户端');
 const preferences=new Emitter(),modelsChanged=new Emitter(),providerChanged=new Emitter();
 let settings={locale:'zh-CN',theme:'system',uiFontSizePx:14,recentProjects:[],providerFamilyDomainMigrated:true,restoreSession:false},pending;
 async function catalogue(){
  if(pending)return pending;
  pending=Promise.all([api.get('/api/models'),api.get('/api/status')]).then(([result,status])=>{
   const source=Array.isArray(result.data)?result.data:Array.isArray(result.models)?result.models:null;
   if(!source)throw Error('Codex 模型目录响应无效');
   const models=source.map(model=>{
    const modelId=model.model||model.id;
    if(typeof modelId!=='string'||!modelId)return null;
    const levels=[...new Set((model.supportedReasoningEfforts||[]).map(value=>typeof value==='string'?value:value.reasoningEffort).filter(value=>typeof value==='string'&&value))];
    if(!levels.length)return null;
    const defaultReasoningEffort=levels.includes(model.defaultReasoningEffort)?model.defaultReasoningEffort:levels[0];
    return{modelId,defaultReasoningEffort,config:{enabled:true,properties:{inputFormat:{supportsText:true,supportsImage:Array.isArray(model.inputModalities)&&model.inputModalities.includes('image')},outputFormat:{supportsText:true},...(Number.isFinite(model.contextWindow)?{contextWindow:model.contextWindow}:{})},optionSpecs:{reasoningLevel:{values:levels}}}};
   }).filter(Boolean);
   const config={group:'standard-personal',access:null,api:{type:'openai-responses'},visibility:'visible'};
   const provider={providerId:'codex-app',providerName:'Codex 本机',config,models};
   const preferredModel=models.find(model=>source.some(native=>(native.model||native.id)===model.modelId&&native.isDefault))||models[0];
   const preferredSelection=preferredModel?{providerId:'codex-app',modelId:preferredModel.modelId,options:{reasoningLevel:preferredModel.defaultReasoningEffort}}:undefined;
   const revision=1;
   return{modelView:{revision,...(preferredSelection?{preferredSelection}:{}),providers:models.length?[provider]:[]},providerView:{revision,providerTemplates:[],providerOrder:models.length?['codex-app']:[],providers:models.length?[{providerId:provider.providerId,providerName:provider.providerName,enabled:true,executable:status.desktopOnline===true,effectiveConfig:config,issues:[],models:models.map(model=>({kind:'builtin',modelId:model.modelId,builtin:true,effectiveBuiltinConfig:model.config,effectiveConfig:model.config,enabled:true,executable:status.desktopOnline===true,selectable:status.desktopOnline===true,issues:[]}))}]:[]}};
  }).finally(()=>{pending=null;});
  return pending;
 }
 const services={
  setting:{
   async get(){return{...settings};},
   async update(patch){
    const allowed=['locale','theme','uiFontSizePx','recentProjects','providerFamilyDomainMigrated'];
    if(!patch||typeof patch!=='object'||Object.keys(patch).some(key=>!allowed.includes(key)))return unavailable();
    if(patch.locale!==undefined&&!['zh-CN','en-US'].includes(patch.locale))throw Error('语言设置无效');
    if(patch.theme!==undefined&&!['system','light','dark','zai-light','zai-dark'].includes(patch.theme))throw Error('主题设置无效');
    settings={...settings,...patch,providerFamilyDomainMigrated:true};preferences.fire({...settings});return{...settings};
   },
   onDidChange:preferences.event,
   updateDataBaseDir:unavailable,
  },
  oauth:{getProviders:async()=>[],getActiveProvider:async()=>null,getUserInfo:async()=>null,getSession:async()=>null,refreshToken:async()=>null,onDidChangeSession:noCloudEvent,startOAuthWithPolling:unavailable,logoutAll:unavailable},
  credential:{load:async()=>null,save:unavailable,delete:unavailable},
  'model-selection':{
   async getView(input={}){
    const view=(await catalogue()).modelView,requested=input?.selection??view.preferredSelection;
    const model=view.providers.find(provider=>provider.providerId===requested?.providerId)?.models.find(model=>model.modelId===requested?.modelId);
    let effectiveSelection=null;
    if(model){
     const levels=model.config.optionSpecs.reasoningLevel.values,level=requested.options?.reasoningLevel;
     effectiveSelection={providerId:requested.providerId,modelId:requested.modelId,options:{reasoningLevel:levels.includes(level)?level:model.defaultReasoningEffort}};
    }
    return{...view,effectiveSelection};
   },
   onDidChange:modelsChanged.event,
  },
  'provider-settings':{getView:async()=> (await catalogue()).providerView,refresh:async()=> (await catalogue()).providerView,onDidChange:providerChanged.event},
  system:{getSystemInfo:async()=>({platform:process.platform,arch:process.arch,isDesktop:false,backend:'codex-app'}),getPlatform:async()=>process.platform},
 };
 return services;
}
export {createPlatformServices as createCodexPlatformServices};
