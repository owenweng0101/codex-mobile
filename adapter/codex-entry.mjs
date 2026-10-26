import {connectMobileServices} from './mobile-connection.mjs';
// The original UI and RPC remain in the versioned compatibility bundle.
const mainModule='/remote/v4/3.16.3/assets/index-BsmXQHMM.js';
const adapterModule='/codex-browser-adapter.mjs';
export function nativeAttachmentUrl(ref,sessionId,origin){
 if(typeof ref!=='string'||!ref||typeof sessionId!=='string'||!sessionId)return null;
 try{const url=new URL(ref,origin);if(url.origin!==origin||!/^https?:$/.test(url.protocol)||url.username||url.password||url.hash||url.pathname!=='/mobile/api/image'||url.searchParams.get('threadId')!==sessionId)return null;url.searchParams.set('preview','1');return url.href;}catch{return null;}
}
export const criticalPreloads=[
 '/remote/v4/3.16.3/assets/IntlProvider-itolvRb2.js',
 '/remote/v4/3.16.3/assets/validation-B6yV_dPD.js',
];
function deadline(promise,ms,message){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));}

// Importing the interface must not wait for pairing or a cold project catalogue.
// No command is sent by this bootstrap; native creation still waits for Send.
export async function loadCodexMobile({origin,token='',request=fetch,loadModule=path=>import(path),onPaired=()=>{},onStage=()=>{},onBrand=()=>{},onInfo=()=>{},resourceTimeoutMs=90000,connectTimeoutMs=30000}={}){
 onStage('resources','active');onStage('paired','active');
 const resources=deadline(Promise.all([loadModule(mainModule),loadModule(adapterModule)]),resourceTimeoutMs,'界面资源加载超时，请重试').then(value=>{onStage('resources');return value;});
 const metadata=(async()=>{
  if(token){
   const response=await request('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token}),credentials:'same-origin',signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('配对已失效，请重新扫描电脑模型网关中的二维码');
   onPaired();onStage('paired');
  }
  onStage('metadata','active');
  const ready=await request('/api/server-info',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(45000)});
  if(!ready.ok)throw Error(ready.status===401?'请重新扫描这台 Mac 模型网关中的二维码':'电脑上的项目暂时没有读取成功，请重试');
  if(!token)onStage('paired');
  const info=await ready.json();onInfo(info);onStage('metadata');return info;
 })();
 const [[compat,{mountCodexOriginalH5}],info]=await Promise.all([resources,metadata]);
 onBrand(compat.__codexBrandIcon);
 onStage('connecting');
 let controller;
 const connection=await connectMobileServices({connect:compat.__codexOriginalConnect,url:origin.replace(/^http/,'ws')+'/ws',connectTimeoutMs,onServices:services=>controller?.replaceServices?.(services),onState:state=>controller?.setTransportState?.(state)});
 const services=connection.services;
 try{controller=await mountCodexOriginalH5({compat,services,info,resolveNavigation:async navigation=>{
  const result=await request('/api/navigation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(navigation),credentials:'same-origin',signal:AbortSignal.timeout(45000)});
  const value=await result.json();if(!result.ok)throw Error(value.error||'无法打开所选会话');return value;
 }});}catch(error){connection.dispose();throw error;}
 const dispose=controller.dispose?.bind(controller);controller.dispose=()=>{connection.dispose();dispose?.();};
 onStage('mounted');return{controller,info,connection};
}

export function loadingSurface(){
 document.title='Codex';
 document.documentElement.dataset.codexMobile='true';
 const style=document.createElement('style');style.id='codex-mobile-shell';
 style.textContent=`html[data-codex-mobile="true"]{--color-background:#fff!important}html[data-codex-mobile="true"].dark,html[data-codex-mobile="true"].zai-dark{--color-background:#000!important}html[data-codex-mobile="true"],html[data-codex-mobile="true"] body{background-color:var(--color-background,#fff)}
 #codex-loading{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:28px;background:#fff;color:#1d1d1f;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
 #codex-loading section{width:min(100%,360px)}#codex-loading .brand{display:flex;align-items:center;gap:8px;margin-bottom:24px}#codex-loading .brand img{width:52px;height:52px;border-radius:14px}#codex-loading h1{margin:0;font-size:28px;font-weight:400;line-height:1;letter-spacing:-.035em}
 #codex-loading p{color:#6e6e73;margin:10px 0}#codex-loading ol{list-style:none;padding:0;margin:24px 0}#codex-loading li{display:flex;gap:12px;align-items:center;margin:16px 0;color:#86868b;transition:color .2s ease}#codex-loading li::before{content:"";box-sizing:border-box;width:14px;height:14px;border:1px solid #dedee3;border-radius:50%;flex:none}
 #codex-loading li[data-state="active"],#codex-loading li[data-state="done"]{color:#1d1d1f}#codex-loading li[data-state="active"]::before{border-color:currentColor;border-right-color:transparent;animation:codex-loading-spin 1s linear infinite}#codex-loading li[data-state="done"]::before{content:"✓";display:flex;align-items:center;justify-content:center;border:0;background:transparent;font-size:14px;line-height:1;font-weight:400;color:#86868b;transform:translateY(-1px)}#codex-loading li[data-state="done"]::after{content:none}#codex-loading li[data-state="error"]{color:#b34335}#codex-loading li[data-state="error"]::before{border-color:currentColor}
 #codex-loading #codex-loading-title,#codex-loading ol{margin-left:8px}
 #codex-loading button{border:1px solid #d2d2d7;border-radius:999px;background:transparent;color:inherit;font:inherit;padding:8px 20px;cursor:pointer}#codex-loading button[hidden]{display:none}#codex-loading .small{font-size:12px;line-height:1.8}
 @keyframes codex-loading-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#codex-loading li{transition:none}#codex-loading li[data-state="active"]::before{animation:none}}
 @media(prefers-color-scheme:dark){#codex-loading{background:#000;color:#f5f5f7}#codex-loading p,#codex-loading li{color:#98989d}#codex-loading li[data-state="active"],#codex-loading li[data-state="done"]{color:#f5f5f7}#codex-loading li::before,#codex-loading button{border-color:#3a3a3c}}`;
 document.head.appendChild(style);
 const root=document.createElement('div');root.id='codex-loading';root.setAttribute('role','status');root.setAttribute('aria-live','polite');root.setAttribute('aria-busy','true');
 root.innerHTML='<section><div class="brand"><img alt="" width="52" height="52"><h1>Codex</h1></div><p id="codex-loading-title">正在连接电脑并加载界面…</p><ol><li data-stage="paired" data-state="pending">连接本机</li><li data-stage="metadata" data-state="pending">准备工作区</li><li data-stage="resources" data-state="pending">加载手机界面</li><li data-stage="mounted" data-state="pending">准备会话</li></ol><p class="small" id="codex-loading-note" hidden></p><button type="button" id="codex-loading-retry" hidden>重新加载</button></section>';
 // The HTML embeds the existing Codex icon so it is available before the bundle downloads.
 root.querySelector('.brand img').src=document.querySelector('link[rel="icon"]').href;
 document.body.appendChild(root);
 const retry=root.querySelector('#codex-loading-retry');retry.onclick=()=>location.reload();
 const rows=[...root.querySelectorAll('[data-stage]')];
 let failed=false;
 const slowTimer=setTimeout(()=>{if(!failed){retry.hidden=false;}},30000);
 return{
  stage(name,state='done'){
   if(failed)return;
   if(name==='connecting'){name='mounted';state='active';}
   const item=rows.find(row=>row.dataset.stage===name);if(!item)return;
   item.dataset.state=state;item.dataset.done=String(state==='done');
   item.setAttribute('aria-label',item.textContent+'：'+(state==='active'?'正在进行':state==='done'?'已完成':'等待中'));
   const active=rows.filter(row=>row.dataset.state==='active');
   root.querySelector('#codex-loading-title').textContent=active.length?'正在'+active.map(row=>row.textContent).join('、')+'…':rows.every(row=>row.dataset.state==='done')?'Codex 已就绪':'正在准备下一步…';
  },
  complete(){clearTimeout(slowTimer);root.setAttribute('aria-busy','false');requestAnimationFrame(()=>requestAnimationFrame(()=>root.remove()));},
  error(error){failed=true;clearTimeout(slowTimer);root.setAttribute('aria-busy','false');for(const row of rows)if(row.dataset.state==='active'){row.dataset.state='error';row.setAttribute('aria-label',row.textContent+'：未完成');}root.querySelector('#codex-loading-title').textContent='暂时没有连接成功';root.querySelector('#codex-loading-note').hidden=false;root.querySelector('#codex-loading-note').textContent=String(error?.message||'请检查网络后重试');retry.textContent='重试';retry.hidden=false;},
 };
}

if(typeof window!=='undefined'&&typeof document!=='undefined'){
 const diagnostics=globalThis.__CODEX_BRIDGE_DIAGNOSTICS__={errors:[],rejections:[]};
 addEventListener('error',event=>diagnostics.errors.push(String(event.message).slice(0,300)));
 addEventListener('unhandledrejection',event=>diagnostics.rejections.push(String(event.reason?.message||event.reason).slice(0,300)));
 globalThis.__CODEX_NATIVE_ATTACHMENT_URL__=(ref,sessionId)=>nativeAttachmentUrl(ref,sessionId,location.origin);
 const loading=loadingSurface();
 for(const href of criticalPreloads){const link=document.createElement('link');link.rel='modulepreload';link.href=href;link.crossOrigin='anonymous';document.head.appendChild(link);}
 try{
  const result=await loadCodexMobile({origin:location.origin,token:location.hash.slice(1),onPaired:()=>history.replaceState(null,'',location.pathname+location.search),onStage:(name,state)=>loading.stage(name,state),onInfo:info=>{globalThis.__CODEX_ORIGINAL_BRIDGE__=info;},onBrand:icon=>{
   for(const rel of ['icon','apple-touch-icon']){for(const old of document.querySelectorAll('link[rel="'+rel+'"]'))old.remove();const link=document.createElement('link');link.rel=rel;link.href=icon;document.head.appendChild(link);}
  }});
  globalThis.__CODEX_ORIGINAL_BRIDGE__=result.info;globalThis.__CODEX_ORIGINAL_MOUNT__=result.controller;loading.complete();
 }catch(error){diagnostics.errors.push(String(error?.message||error).slice(0,300));loading.error(error);}
}
