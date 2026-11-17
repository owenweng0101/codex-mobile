import {connectMobileServices} from './mobile-connection.mjs';
import {installImageRecovery,installMobilePreview} from './image-recovery.mjs';
// The original UI and RPC remain in the versioned compatibility bundle.
const mainModule='/remote/v4/3.16.3/assets/index-BsmXQHMM.js';
const adapterModule='/codex-browser-adapter.mjs';
export function nativeAttachmentUrl(ref,sessionId,origin){
 if(typeof ref!=='string'||!ref||typeof sessionId!=='string'||!sessionId)return null;
 try{const url=new URL(ref,origin);if(url.origin!==origin||!/^https?:$/.test(url.protocol)||url.username||url.password||url.hash||url.pathname!=='/mobile/api/image'||url.searchParams.get('threadId')!==sessionId)return null;url.searchParams.set('preview','1');return url.href;}catch{return null;}
}
// The compatibility bundle knows every in-memory attachment scope and the
// actual command lifecycle, including a send hidden by navigation. An empty
// disabled button is not evidence of a send. Pure text drafts remain reloadable.
export function trackCodexComposition(document=globalThis.document){
 let composing=null;
 const editorFor=target=>target?.closest?.('[data-testid="v4-composer-input"]')||null;
 const start=event=>{const editor=editorFor(event.target);if(editor)composing=editor;};
 const end=event=>{if(editorFor(event.target)===composing)composing=null;};
 const input=event=>{if(event.isComposing===true)start(event);else if(event.isComposing===false)end(event);};
 const listeners={compositionstart:start,compositionend:end,beforeinput:input,input,blur:end};
 for(const [type,listener]of Object.entries(listeners))document?.addEventListener?.(type,listener,true);
 return{
  isComposing(){
   // A detached/replaced editor or an actual focus move ends ownership even if
   // WebKit omitted compositionend. Merely hiding the iframe must not clear it.
   if(composing&&(composing.isConnected===false||document?.activeElement&&document.activeElement!==composing&&!composing.contains?.(document.activeElement)))composing=null;
   return composing!==null;
  },
  dispose(){composing=null;for(const [type,listener]of Object.entries(listeners))document?.removeEventListener?.(type,listener,true);}
 };
}
export function isCodexMobileReloadSafe({document=globalThis.document,check=globalThis.__CODEX_COMPOSER_RELOAD_SAFE__,composition}={}){
 try{
  if(composition?.isComposing())return false;
  if(typeof check==='function')return check()===true;
  // Existing installed assets can still identify visible unsent attachments;
  // the complete cross-scope/send guard becomes available with the new bundle.
  return !document?.querySelector?.('[data-composer-attachment-remove], [data-composer-attachment-kind]');
 }catch{return false;}
}
export const criticalPreloads=[
 '/remote/v4/3.16.3/assets/IntlProvider-itolvRb2.js',
 '/remote/v4/3.16.3/assets/validation-B6yV_dPD.js',
];
function deadline(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));}

// Importing the interface must not wait for pairing or a cold project catalogue.
// No command is sent by this bootstrap; native creation still waits for Send.
export async function loadCodexMobile({origin,token='',request=fetch,loadModule=path=>import(path),onPaired=()=>{},onStage=()=>{},onBrand=()=>{},onInfo=()=>{},onController=()=>{},resourceTimeoutMs=90000,connectTimeoutMs=30000}={}){
 const readWorkspaceInfo=async()=>{
  const ready=await request('/api/server-info',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(45000)});
  if(!ready.ok)throw Error(ready.status===401?'请重新扫描桌面「手机连接」文件夹中的统一二维码':'电脑上的项目暂时没有读取成功，请重试');
  const info=await ready.json();onInfo(info);return info;
 };
 onStage('resources','active');onStage('paired','active');
 const resources=deadline(Promise.all([loadModule(mainModule),loadModule(adapterModule)]),resourceTimeoutMs,'界面资源加载超时，请重试').then(value=>{onStage('resources');return value;});
 const metadata=(async()=>{
  if(token){
   const response=await request('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),credentials:'same-origin',signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('配对已失效，请重新扫描桌面「手机连接」文件夹中的统一二维码');
  }
  onStage('metadata','active');
  const info=await readWorkspaceInfo();
  if(token)onPaired();
  onStage('paired');
  onStage('metadata');return info;
 })();
 const [[compat,{mountCodexOriginalH5}],info]=await Promise.all([resources,metadata]);
 onBrand(compat.__codexBrandIcon);
 onStage('connecting');
 let controller;
 const connection=await connectMobileServices({connect:compat.__codexOriginalConnect,url:origin.replace(/^http/,'ws')+'/ws',connectTimeoutMs,onServices:services=>controller?.replaceServices?.(services),onState:state=>controller?.setTransportState?.(state)});
 const services=connection.services;
 const stopImageRecovery=typeof document==='undefined'?()=>{}:installImageRecovery();
 const stopPreview=typeof document==='undefined'?()=>{}:installMobilePreview();
 try{controller=await mountCodexOriginalH5({compat,services,info,refreshWorkspaceInfo:readWorkspaceInfo,resolveNavigation:async navigation=>{
  const result=await request('/api/navigation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(navigation),credentials:'same-origin',signal:AbortSignal.timeout(45000)});
  const value=await result.json();if(!result.ok)throw Object.assign(Error(value.error||'无法打开所选会话'),{status:result.status});return value;
 }});
  onController(controller);
  await deadline(Promise.all([controller.initialViewReady,controller.initialContentReady]),connectTimeoutMs,'原会话恢复超时，请重新加载');
 }catch(error){controller?.dispose?.();stopPreview();stopImageRecovery();connection.dispose();throw error;}
 const dispose=controller.dispose?.bind(controller);controller.dispose=()=>{stopPreview();stopImageRecovery();connection.dispose();dispose?.();};
 onStage('mounted');return{controller,info,connection};
}

// Change only this tab's navigation checkpoint. Drafts, auth and native sessions
// are not cleared, so a failed restore always has a non-destructive way out.
export function returnCodexHome({storage,history,reload}={}){
 let saved=false;
 try{const target=storage??globalThis.sessionStorage;if(target?.setItem){target.setItem('codex-mobile-current-view-v1',JSON.stringify({kind:'home'}));saved=true;}}catch{}
 try{const target=history??globalThis.history;if(target?.replaceState){target.replaceState({...target.state,codexMobileView:{kind:'home'},zcodeMobilePage:'home'},'');saved=true;}}catch{}
 if(!saved)throw Error('无法保存首页位置，请允许此页面使用会话存储后重试');
 (reload||(()=>location.reload()))();
 return true;
}

export function loadingSurface(){
 document.title='Codex';
 document.documentElement.dataset.codexMobile='true';
 const style=document.createElement('style');style.id='codex-mobile-shell';
 // A readiness/error boundary, not a branded launch screen. The restored-view
 // reporter still owns completion so an initial empty draft never flashes.
 style.textContent=`#codex-loading{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:28px;--load-canvas:#f9fafb;--load-ink:#0f1115;--load-muted:#61666b;--load-line:#d2d2d7;background:var(--cm-canvas,var(--load-canvas));color:var(--cm-muted,var(--load-muted));font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-align:center}
 #codex-loading section{width:min(100%,360px)}#codex-loading p{margin:10px 0;overflow-wrap:anywhere}
 #codex-loading .actions{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}#codex-loading button{min-height:44px;border:1px solid var(--cm-line,var(--load-line));border-radius:12px;background:transparent;color:var(--cm-ink,var(--load-ink));font:inherit;padding:8px 14px;cursor:pointer}#codex-loading button[hidden]{display:none}#codex-loading button:focus-visible{outline:2px solid currentColor;outline-offset:3px}#codex-loading .small{font-size:12px;line-height:1.8}
 #codex-loading-retry{background:var(--cm-ink,var(--load-ink))!important;color:var(--cm-canvas,var(--load-canvas))!important;border-color:var(--cm-ink,var(--load-ink))!important}
 @media(prefers-color-scheme:dark){#codex-loading{--load-canvas:#151517;--load-ink:#f0f1f2;--load-muted:#aaafb7;--load-line:#3a3a3c}}`;
 document.head.appendChild(style);
 const root=document.createElement('div');root.id='codex-loading';root.setAttribute('role','status');root.setAttribute('aria-live','polite');root.setAttribute('aria-busy','true');
 root.innerHTML='<section><p id="codex-loading-title">正在加载…</p><p class="small" id="codex-loading-note" hidden></p><div class="actions"><button type="button" id="codex-loading-retry" hidden>重试</button><button type="button" id="codex-loading-home" hidden>返回首页</button></div></section>';
 document.body.appendChild(root);
 const retry=root.querySelector('#codex-loading-retry');retry.onclick=()=>location.reload();
 const home=root.querySelector('#codex-loading-home');
 home.onclick=()=>{
  try{return typeof globalThis.__mobileHubHome==='function'?globalThis.__mobileHubHome():returnCodexHome();}
  catch(error){const note=root.querySelector('#codex-loading-note');note.hidden=false;note.textContent=String(error?.message||'无法返回首页，请重试');}
 };
 let failed=false;
 const slowTimer=setTimeout(()=>{if(!failed){retry.hidden=false;home.hidden=false;}},30000);
 return{
  // Preserve diagnostics without exposing a launch checklist or animation.
  stage(name,state='done'){if(!failed){root.dataset.stage=name;root.dataset.stageState=state;}},
  complete(){clearTimeout(slowTimer);root.setAttribute('aria-busy','false');root.remove();style.remove();},
  error(error){failed=true;clearTimeout(slowTimer);root.setAttribute('aria-busy','false');root.querySelector('#codex-loading-title').textContent='暂时没有连接成功';root.querySelector('#codex-loading-note').hidden=false;root.querySelector('#codex-loading-note').textContent=String(error?.message||'请检查网络后重试');retry.textContent='重试';retry.hidden=false;home.hidden=false;},
 };
}

if(typeof window!=='undefined'&&typeof document!=='undefined'){
 const diagnostics=globalThis.__CODEX_BRIDGE_DIAGNOSTICS__={errors:[],rejections:[]};
 addEventListener('error',event=>diagnostics.errors.push(String(event.message).slice(0,300)));
 addEventListener('unhandledrejection',event=>diagnostics.rejections.push(String(event.reason?.message||event.reason).slice(0,300)));
 globalThis.__CODEX_NATIVE_ATTACHMENT_URL__=(ref,sessionId)=>nativeAttachmentUrl(ref,sessionId,location.origin);
 const loading=loadingSurface();
 let mobileLoadState='loading',mobileController;
 window.__mobileHubReadiness=()=>mobileLoadState==='error'?'error':mobileController?.getReadiness?.()||mobileLoadState;
 const composition=trackCodexComposition(document);
 window.__codexMobileReloadSafe=()=>isCodexMobileReloadSafe({composition});
 // Counts and booleans only: no conversation text, IDs, paths or credentials.
 window.__mobileHubReadinessDetails=()=>({phase:mobileLoadState,content:mobileController?.getReadinessDetails?.()||null});
 window.__mobileHubHome=()=>{try{if(mobileLoadState!=='error')mobileController?.dispose?.();}catch{}return returnCodexHome();};
 for(const href of criticalPreloads){const link=document.createElement('link');link.rel='modulepreload';link.href=href;link.crossOrigin='anonymous';document.head.appendChild(link);}
 try{
  const result=await loadCodexMobile({origin:location.origin,token:location.hash.slice(1),onController:controller=>{mobileController=controller;},onStage:(name,state)=>loading.stage(name,state),onInfo:info=>{globalThis.__CODEX_ORIGINAL_BRIDGE__=info;},onBrand:icon=>{
   for(const rel of ['icon','apple-touch-icon']){for(const old of document.querySelectorAll('link[rel="'+rel+'"]'))old.remove();const link=document.createElement('link');link.rel=rel;link.href=icon;document.head.appendChild(link);}
  }});
  globalThis.__CODEX_ORIGINAL_BRIDGE__=result.info;globalThis.__CODEX_ORIGINAL_MOUNT__=result.controller;mobileLoadState='ready';loading.complete();
 }catch(error){mobileLoadState='error';diagnostics.errors.push(String(error?.message||error).slice(0,300));loading.error(error);}
}
