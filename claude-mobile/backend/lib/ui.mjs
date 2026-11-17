import {readFileSync} from 'node:fs';
import {installMobileHubReadiness} from './hub-readiness.mjs';
import {hubReloadSafe} from './hub-reload-safety.mjs';
const MARKED=readFileSync(new URL('../vendor/marked.umd.js',import.meta.url),'utf8').replace(/<\/script/gi,'<\\/script');
const HUB_CHROME=readFileSync(new URL('./hub-chrome.js',import.meta.url),'utf8');
const ASSISTANT_VIEW=readFileSync(new URL('./assistant-view.js',import.meta.url),'utf8');
const MEDIA_PREVIEW=readFileSync(new URL('./media-preview.js',import.meta.url),'utf8').replace(/<\/script/gi,'<\\/script');
const UNREAD_INDICATOR=readFileSync(new URL('./unread-indicator.js',import.meta.url),'utf8');
const RENDERER=readFileSync(new URL('./message-renderer.js',import.meta.url),'utf8');
/**
 * 手机页面：/m/ 三合一轻量切换入口，/claude/ 会话列表与聊天。
 * Claude 对齐 Codex 的基础排版，采用紧凑过程区、原位待办及一体式输入区。
 */

const BASE_CSS=`
:root{color-scheme:light dark;--bg:#f9fafb;--surface:#ffffff;--text:#0f1115;--muted:#61666b;--faint:#81858c;--line:#0000000f;--capsule:rgba(252,253,254,.72);--capsule-active:#ffffff;--bubble:#edf3fe;--hover:#ebeef2;--accent:#4176e6;--accent-text:#ffffff;--shadow:0 8px 32px rgba(24,30,40,.08),0 1px 3px rgba(24,30,40,.03)}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--surface:#232324;--text:#f0f1f2;--muted:#aaafb7;--faint:#999fa8;--line:#393d43;--capsule:rgba(48,49,54,.72);--capsule-active:#3a3b40;--bubble:#2b3444;--hover:#33363b;--accent:#4176e6;--accent-text:#ffffff;--shadow:0 8px 32px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.25)}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
button,textarea{-webkit-appearance:none;appearance:none}
button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
html,body{height:100%;margin:0}
body{font:14px/1.5 -apple-system,system-ui,"SF Pro Text","PingFang SC",sans-serif;background:var(--bg);color:var(--text);overscroll-behavior:none}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.hidden{display:none!important}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const HUB_HTML=`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6f7f8" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#151517" media="(prefers-color-scheme:dark)">
<title>手机连接</title>
<style>${BASE_CSS}
body{background:var(--bg)}
/* 三合一入口自身不滚动：外层固定，滚动只发生在当前 iframe 内。否则 iOS 和
   内置浏览器拖拽时会连同 tab 栏一起上下回弹，露出大片空白。 */
html,body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none}
.shell{position:fixed;left:0;right:0;top:0;display:flex;flex-direction:column;height:var(--app-height,100dvh);padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);background:var(--surface);overflow:hidden}
.hub-bar{display:flex;align-items:center;gap:4px;height:34px;flex:none;padding:2px 8px;background:var(--surface)}
.hub-actions{display:none;align-items:center;flex:none}
.hub-action{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;color:var(--muted)}
.hub-action:active{background:var(--hover)}
.hub-action svg{width:16px;height:16px}
:root[data-active="claude"]{--bg:#f9fafb;--surface:#f9fafb;--capsule-active:#ffffff;--text:#0f1115;--muted:#61666b;--line:#e5e7ea}
@media(prefers-color-scheme:dark){:root[data-active="claude"]{--bg:#151517;--surface:#151517;--capsule-active:#232324;--text:#f0f1f2;--muted:#aaafb7;--line:#393d43}}
.capsule{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:2px;flex:1;min-width:0;height:30px;margin:0;padding:2px;border-radius:999px;background:var(--bg);border:.5px solid var(--line)}
.capsule button{position:relative;min-width:0;height:24px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:400;line-height:24px;color:var(--muted)}
.capsule button[aria-selected=true]{background:var(--capsule-active);color:var(--text);font-weight:500;box-shadow:0 1px 2px #0000000a}
.capsule button:active{background:var(--hover)}
.stage{position:relative;flex:1;min-height:0}
.stage iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--surface);display:none}
.stage iframe.active{display:block}
#loading{z-index:2;background:var(--surface)}
#error{z-index:3}
#refreshNotice{position:absolute;z-index:4;top:8px;left:16px;right:16px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text);box-shadow:var(--shadow);font-size:13px;line-height:20px;text-align:center;pointer-events:none}
.notice{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center;color:var(--muted)}
.notice strong{color:var(--text);font-size:16px}
.recovery-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:8px}
.notice button{min-height:44px;padding:10px 18px;border:1px solid transparent;border-radius:12px;background:var(--text);color:var(--bg);font-weight:500;font-size:14px}
.notice button[data-secondary]{background:transparent;color:var(--text);border-color:var(--line)}

</style></head>
<body>
<div class="shell">
  <div class="hub-bar"><div class="capsule" role="tablist" aria-label="切换入口">
    <button role="tab" data-tab="codex">Codex</button>
    <button role="tab" data-tab="dsh">DSH</button>
    <button role="tab" data-tab="claude">Claude</button>
  </div>
  <div class="hub-actions" id="hubActions" aria-label="当前入口操作"></div></div>
  <div class="stage" id="stage">
    <div class="notice" id="loading" role="status" aria-live="polite">正在加载…</div>
    <div id="refreshNotice" role="status" aria-live="polite" hidden></div>
    <div class="notice hidden" id="error"><strong id="errorTitle">暂时无法加载</strong><span id="errorText"></span><div class="recovery-actions"><button id="returnHome" data-secondary>返回首页</button><button id="retry">重试</button></div></div>
    <iframe data-frame="codex" title="Codex" allow="clipboard-read; clipboard-write; fullscreen 'none'"></iframe>
    <iframe data-frame="dsh" title="DSH" allow="clipboard-read; clipboard-write; fullscreen 'none'"></iframe>
    <iframe data-frame="claude" title="Claude" allow="clipboard-read; clipboard-write; fullscreen 'none'"></iframe>
  </div>
</div>
<script>${HUB_CHROME}</script>
<script>(${installMobileHubReadiness.toString()})(window);</script>
<script>
(() => {
  const names = {codex:'Codex',dsh:'DSH',claude:'Claude'};
  const buttons = [...document.querySelectorAll('.capsule button')];
  const stage = document.getElementById('stage');
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  let appBuild = null, pendingBuild = false;
  const framesReloadSafe = ${hubReloadSafe.toString()};
  function applyPendingBuild(){
    if(!pendingBuild)return;
    if(!document.hidden&&document.activeElement?.tagName==='IFRAME')return;
    if(!framesReloadSafe(document.querySelectorAll('iframe[data-frame]')))return;
    pendingBuild=false;location.reload();
  }
  async function checkBuild(){
    try {
      const response = await fetch('/m/api/build', {cache:'no-store', credentials:'same-origin'});
      if (!response.ok) return;
      const value = await response.json();
      if (!value.build) return;
      if (appBuild === null) { appBuild = value.build; return; }
      if (value.build !== appBuild) { appBuild=value.build;pendingBuild=true;applyPendingBuild(); }
    } catch {}
  }
  // Backgrounding or clicking another capsule is not permission to discard a
  // child draft, an upload, or an in-flight interaction.
  document.addEventListener('visibilitychange',applyPendingBuild);
  window.addEventListener('pageshow',applyPendingBuild);
  setInterval(applyPendingBuild,3000);
  checkBuild();
  setInterval(() => { if (!document.hidden) checkBuild(); }, 10000);

  const frames = new Map([...document.querySelectorAll('iframe')].map(f => [f.dataset.frame, f]));
  const updateHubChrome=window.installMobileHubChrome(frames);
  let entries = null, entriesAt = 0, entriesRequest = null;
  let current = localStorage.getItem('desk-tab') || 'codex';
  if(!frames.has(current)) current='codex';

  let viewportFrame;
  function syncViewport(){
    cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(()=>{
      const view=window.visualViewport;
      // 只跟随可视高度（键盘弹出时收缩）；不再把 offsetTop 当作外层位置，
      // 否则拖拽/回弹时 visualViewport 的偏移会把整个 tab 栏往下推。
      document.documentElement.style.setProperty('--app-height',(view?.height||innerHeight)+'px');
      if(window.scrollY)window.scrollTo(0,0);
    });
  }
  window.visualViewport?.addEventListener('resize',syncViewport);
  window.visualViewport?.addEventListener('scroll',syncViewport);
  window.addEventListener('resize',syncViewport);window.addEventListener('pageshow',syncViewport);syncViewport();
  function notifyFrames(){for(const [name,frame] of frames){try{frame.contentWindow.postMessage({type:'mobile-hub-active',active:name===current},location.origin);}catch{}}}
  // 子页面加载完成后再握手一次：首条 active 消息可能在 iframe 还没装好监听时
  // 就发出去了，丢了会让 Claude 页的轮询永远不启动。
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin)return;
    if(![...frames.values()].some(frame=>frame.contentWindow===event.source))return;
    if(event.data?.type==='mobile-hub-hello')notifyFrames();
  });
  // 再点当前胶囊只刷新当前视图。新适配优先原位读取或加载前恢复状态；
  // 旧版 DSH 缺少准备钩子时，才在加载后按刷新前状态收回抽屉。
  function afterLoad(frame){
    notifyFrames();
    const state=frame.dataset.refreshDrawer;
    const prepared=frame.dataset.refreshPrepared==='1';
    delete frame.dataset.refreshPrepared;
    if(state===undefined)return;
    delete frame.dataset.refreshDrawer;
    // Updated shells restore before first layout; do not flash/toggle their drawer.
    if(prepared)return;
    if(frame.dataset.frame!=='dsh'||state!=='closed')return;
    let tries=0;
    const close=()=>{
      try{
        const doc=frame.contentDocument;
        if(!doc)return;
        if(doc.documentElement?.dataset?.dshmDrawer==='open'){
          // The phone shell owns the drawer state; its back arrow calls closeList().
          // Clicking the host app's collapse button re-expands via the shell's layout().
          const shellMenu=doc.querySelector('[data-dshm-menu]');
          if(shellMenu){shellMenu.click();return;}
          const button=doc.querySelector('button[aria-label="收起侧边栏"]');
          if(button){button.click();return;}
        }
        if(tries++<12)setTimeout(close,250);
      }catch{}
    };
    setTimeout(close,300);
  }
  function setRefreshing(frame,active){
    frame.dataset.refreshing=active?'1':'';
    const button=buttons.find(button=>button.dataset.tab===frame.dataset.frame);
    button?.setAttribute('aria-busy',String(active));
    // Only the visible app owns the shared, unbranded refresh feedback.
    if(current===frame.dataset.frame)loading.classList.toggle('hidden',!active);
  }
  function retryLoad(frame){
    if(frames.get(current)!==frame||!childRefreshSafe(frame))return;
    frame.dataset.loaded='';entries=null;load();
  }
  function finishLoad(frame){
    // A slow Codex/DSH child may recover after the shell deadline. Its own
    // readiness/error boundary is authoritative; never leave it under a stale error.
    if(frame.dataset.frame!=='claude'&&frame.dataset.loadError){
      if(current===frame.dataset.frame&&document.getElementById('errorText').textContent===frame.dataset.loadError){error.classList.add('hidden');error._retry=null;}
      delete frame.dataset.loadError;
    }
    frame.dataset.ready='1';clearTimeout(frame._watchdog);setRefreshing(frame,false);
  }
  function watchLoad(frame){
    clearTimeout(frame._watchdog);frame._cancelReady?.();
    frame._loadGeneration=(frame._loadGeneration||0)+1;
    setRefreshing(frame,true);
    delete frame.dataset.loadError;
    frame.dataset.ready='';
    frame._watchdog=setTimeout(()=>{
      if(frame.dataset.ready==='1')return;
      // Keep observing Codex/DSH: a tunnel deadline is not proof the app failed.
      // Preserve Claude's existing lifecycle while fixing the other two tabs.
      if(frame.dataset.frame==='claude'){frame._cancelReady?.();frame.dataset.loaded='';}
      setRefreshing(frame,false);
      frame.dataset.loadError=names[frame.dataset.frame]+' 加载超时，请检查电脑上的服务';
      // An inactive iframe must never replace the current app with its error.
      if(current===frame.dataset.frame)showError(frame.dataset.loadError,frame.dataset.frame==='claude'?undefined:()=>retryLoad(frame));
    },frame.dataset.frame==='claude'?15000:90000);
  }
  for(const frame of frames.values()) frame.addEventListener('load',()=>{
    if(!frame.dataset.loaded)return;
    const generation=frame._loadGeneration,doc=frame.contentDocument;
    afterLoad(frame);
    frame._cancelReady?.();
    // load only means HTML/scripts arrived. Keep the *same* full-screen text
    // over restoration and initial history, then reveal the finished view once.
    frame._cancelReady=window.waitMobileHubReady(frame,()=>{
      if(generation!==frame._loadGeneration||doc!==frame.contentDocument||!frame.dataset.loaded)return;
      finishLoad(frame);
    });
  });
  let refreshNoticeTimer;
  function childRefreshSafe(frame){
    if(!['codex','dsh'].includes(frame.dataset.frame))return true;
    let safe=true;
    try{
      const guard=frame.contentWindow[frame.dataset.frame==='dsh'?'__dshMobileReloadSafe':'__codexMobileReloadSafe'];
      if(typeof guard==='function')safe=guard()===true;
    }catch{safe=false;}
    if(safe)return true;
    const notice=document.getElementById('refreshNotice');
    if(notice){notice.textContent='已保留当前消息和附件，发送完成或移除附件后再刷新。';notice.hidden=false;clearTimeout(refreshNoticeTimer);refreshNoticeTimer=setTimeout(()=>{notice.hidden=true;},4000);}
    return false;
  }
  function refreshActive(){
    const frame=frames.get(current);
    if(!frame||frame.dataset.refreshing==='1')return;
    if(!frame.dataset.loaded){entries=null;load();return;}
    // Coalesce repeat taps during the initial document load as well.
    if(frame.dataset.ready!=='1')return;
    if(!childRefreshSafe(frame))return;
    // A module may still be restoring its view after the document load event.
    try{if(current==='codex'&&frame.contentDocument?.getElementById('codex-loading')?.getAttribute('aria-busy')==='true')return;}catch{}
    error.classList.add('hidden');
    let refresh;
    try{if(current==='claude')refresh=frame.contentWindow.__claudeMobileRefresh;}catch{}
    if(typeof refresh==='function'){
      setRefreshing(frame,true);
      // Claude can re-read in place: retain live attachments, composer and DOM.
      Promise.resolve().then(()=>refresh()).catch(failure=>{
        if(current===frame.dataset.frame)showError(failure?.message||'刷新失败，已保留当前内容',refreshActive);
      }).finally(()=>setRefreshing(frame,false));
      return;
    }
    let drawer=null;
    if(current==='dsh'){
      try{
        drawer=frame.contentDocument?.documentElement?.dataset?.dshmDrawer||null;
        const prepared=frame.contentWindow.__dshMobilePrepareRefresh?.();
        if(prepared?.page==='list'||prepared?.page==='chat')frame.dataset.refreshPrepared='1';
      }catch{}
    }
    if(current==='claude'){try{frame.contentWindow.__claudeMobileHubDeactivate?.();}catch{}}
    frame.dataset.refreshDrawer=drawer===null?'':drawer;
    // Keep this same iframe; a second mounted app can allocate business state.
    setRefreshing(frame,true);watchLoad(frame);
    try{frame.contentWindow.location.reload();}catch{frame.src=frame.src;}
  }
  async function returnHome(){
    const frame=frames.get(current);
    if(!frame?.contentWindow){entries=null;load();return;}
    if(!childRefreshSafe(frame))return;
    const name=current;
    error.classList.add('hidden');frame.dataset.loaded='1';watchLoad(frame);
    try{
      const view=frame.contentWindow,doc=frame.contentDocument;
      let reloading;
      if(typeof view.__mobileHubHome==='function')reloading=await view.__mobileHubHome();
      else{
        // Compatibility with an already-open older child: reset only its view
        // checkpoint, never its drafts, files, selected model or native history.
        if(name==='dsh'){view.sessionStorage.setItem('dsh-mobile-current-page-v1','list');view.history.replaceState({...view.history.state,dshMobilePage:'list'},'');}
        else if(name==='codex'){view.sessionStorage.setItem('codex-mobile-current-view-v1',JSON.stringify({kind:'home'}));view.history.replaceState({...view.history.state,codexMobileView:{kind:'home'},zcodeMobilePage:'home'},'');}
        else{const state={kind:'list'};view.sessionStorage.setItem('clm-current-view-v1',JSON.stringify(state));view.history.replaceState({...view.history.state,claudeMobileView:state},'');}
        view.location.reload();reloading=true;
      }
      if(reloading===true)return;
      const generation=frame._loadGeneration;
      frame._cancelReady=window.waitMobileHubReady(frame,()=>{
        if(frame.contentDocument!==doc||generation!==frame._loadGeneration)return;
        finishLoad(frame);
      });
    }catch(failure){clearTimeout(frame._watchdog);setRefreshing(frame,false);if(current===name)showError('无法返回首页，请重新打开手机连接',returnHome);}
  }
  function showError(text,retry){
    error._retry=retry;
    loading.classList.add('hidden');
    error.classList.remove('hidden');
    document.getElementById('errorText').textContent = text;
  }
  function apply(){
    const refreshNotice=document.getElementById('refreshNotice');if(refreshNotice)refreshNotice.hidden=true;
    // Capture the outgoing app's reading position while it is still laid out;
    // postMessage would run after the iframe is already hidden.
    for(const [name,frame] of frames)if(name!==current){try{frame.contentWindow.__claudeMobileHubDeactivate?.();}catch{}}
    updateHubChrome(current);
    for(const button of buttons) button.setAttribute('aria-selected', String(button.dataset.tab === current));
    for(const [name, frame] of frames) frame.classList.toggle('active', name === current);
    loading.classList.toggle('hidden',Boolean(entries)&&frames.get(current)?.dataset.refreshing!=='1');
    notifyFrames();
    if(!entries) return;
    const entry = entries[current] || {};
    const frame = frames.get(current);
    if(!entry.ready){
      frame.classList.remove('active');
      showError(entry.reason || (names[current] + ' 入口未就绪'));
      return;
    }
    error.classList.add('hidden');
    if(!frame.dataset.loaded || (frame.dataset.ready==='1' && frame.dataset.currentUrl && frame.dataset.currentUrl !== entry.url)){
      // Entry credentials/URLs can change while discovery is pending. Recheck at
      // the actual navigation boundary, not only at the earlier capsule click.
      if(frame.dataset.currentUrl&&!childRefreshSafe(frame)){frame.classList.add('active');return;}
      frame.dataset.loaded = '1';
      frame.dataset.currentUrl = entry.url;
      // A 401/503 or a dead tunnel used to leave a blank frame forever.
      watchLoad(frame);
      frame.src = entry.url;
    }
    if(current!=='claude'&&frame.dataset.loadError&&frame.dataset.ready!=='1')showError(frame.dataset.loadError,()=>retryLoad(frame));
    frame.classList.add('active');
  }
  function load(){
    if(entriesRequest)return entriesRequest;
    loading.classList.remove('hidden');
    error.classList.add('hidden');
    entriesRequest=(async()=>{
      const controller=new AbortController();let deadline;
      try{
        const expired=new Promise((_,reject)=>{deadline=setTimeout(()=>{controller.abort();reject(Object.assign(new Error('entry timeout'),{code:'ENTRY_TIMEOUT'}));},15000);});
        const value=await Promise.race([(async()=>{
          const response = await fetch('/m/api/entries', {cache:'no-store', credentials:'same-origin',signal:controller.signal});
          if(!response.ok) throw Object.assign(new Error('HTTP ' + response.status),{code:response.status===401?'ENTRY_AUTH':'ENTRY_FAILED'});
          return response.json();
        })(),expired]);
        entries = {codex:value.codex, dsh:value.dsh, claude:value.claude};entriesAt=Date.now();
        loading.classList.add('hidden');
        apply();
      }catch(e){
        showError(e.code==='ENTRY_AUTH'?'连接已失效，请重新扫描电脑上的手机连接二维码':e.code==='ENTRY_TIMEOUT'?'读取入口超时，请检查网络后重试':'读取入口失败，请检查电脑上的服务后重试');
      }finally{clearTimeout(deadline);entriesRequest=null;}
    })();
    return entriesRequest;
  }
  for(const button of buttons){
    button.addEventListener('click', () => {
      const next = button.dataset.tab;
      if(next === current){ refreshActive(); return; }
      current = next;
      localStorage.setItem('desk-tab', current);
      if(entries && Date.now() - entriesAt > 60000){ entries = null; apply(); load(); }
      else apply();
    });
  }
  document.getElementById('retry').addEventListener('click', () => { if(error._retry){error._retry();return;} entries = null; load(); });
  document.getElementById('returnHome')?.addEventListener('click',()=>{void returnHome();});
  load();
})();
</script>
</body></html>`;

const CHAT_HTML=`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f6f7f8" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#151517" media="(prefers-color-scheme:dark)">
<title>Claude</title>
<style>${BASE_CSS}
:root{--bg:#f9fafb;--surface:#ffffff;--floating:#fcfdfe;--text:#0f1115;--muted:#61666b;--faint:#81858c;--line:#e5e7ea;--bubble:#eceef1;--hover:#eceef0;--accent:#c15f3c;--accent-text:#ffffff;--conversation-gutter:16px;--conversation-width:calc(100% - var(--conversation-gutter) - var(--conversation-gutter))}
@media(prefers-color-scheme:dark){:root{--bg:#151517;--surface:#232324;--floating:#303136;--text:#f0f1f2;--muted:#aaafb7;--faint:#999fa8;--line:#393d43;--bubble:#2d3035;--hover:#33363b;--accent:#da8a67;--accent-text:#241b16}}
/* Shared neutral palette and compact mobile workspace list. */
html,body{overflow-x:clip}
body{height:var(--chat-height,100dvh);display:flex;flex-direction:column;overflow:hidden;overflow-x:clip;background:var(--bg);font-size:16px;line-height:24px}
.bar{display:flex;align-items:center;gap:0;height:48px;min-height:48px;padding:env(safe-area-inset-top) 12px 0 8px;background:var(--bg);border-bottom:1px solid var(--line);flex:none}
.bar .title{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar .icon{width:32px}
.bar .icon svg{width:16px;height:16px}
html[data-mobile-hub] .bar{border-bottom:1px solid var(--line)!important}
.icon{display:flex;align-items:center;justify-content:center;width:36px;height:44px;border-radius:8px;color:var(--muted);flex:none}
.icon:active{background:var(--hover)}
.icon svg{width:18px;height:18px;display:block}
.view{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;overflow-anchor:none}
#list[data-loaded="false"] .group{visibility:hidden}
#list{padding:0 12px calc(env(safe-area-inset-bottom) + 16px);background:var(--bg)}
.group{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;min-height:40px;font-size:13px;font-weight:400;color:var(--muted);margin:0 -12px;padding:0 12px 0 20px;line-height:19.5px;background:var(--bg)}
.group>span{flex:1}
#workspaceView,#workspaceNew,.workspace-create{display:grid;place-items:center;width:32px;height:36px;flex:none;color:var(--muted);border-radius:8px}
#workspaceNew svg,.workspace-create svg{width:14px;height:14px}
#workspaceNew:active,.workspace-create:active{background:var(--hover)}
.workspace{margin:0 -4px 4px;flex-shrink:0;overflow-anchor:none}
.workspace-header{display:flex;align-items:center;gap:4px;height:36px;padding-right:4px;border-radius:8px}
.workspace-content{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows 300ms cubic-bezier(.4,0,.2,1),opacity 150ms cubic-bezier(.4,0,.2,1)}
.workspace[data-expanded="true"]>.workspace-content{grid-template-rows:1fr;opacity:1}
.workspace-items{min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:4px}
.workspace-items::before{content:"";height:0;flex:none}
.workspace-title{line-height:21px;flex:1;min-width:0;text-align:left;display:flex;align-items:center;gap:8px;height:36px;margin:0;padding:0 4px 0 11px;border:1px solid transparent;border-radius:8px;cursor:pointer;color:var(--text);font-size:14px;font-weight:400}
.workspace-title .workspace-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.workspace-folder{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px;color:var(--muted)}
.workspace-folder svg{display:block;width:16px;height:16px;flex:none}
.workspace-folder .folder-open,.workspace[data-expanded="true"] .workspace-folder .folder-closed{display:none}
.workspace[data-expanded="true"] .workspace-folder .folder-open{display:block}
.workspace-header .workspace-create{height:32px}
.workspace-header:active{background:var(--hover)}
.workspace-create:disabled{opacity:.5;cursor:not-allowed}
@media(hover:hover){.workspace-header:hover{background:var(--hover)}}
.row{display:flex;align-items:center;gap:8px;padding:2px 4px 2px 12px;border-radius:8px;height:36px;min-height:36px;width:100%;text-align:left;transition:background-color 150ms cubic-bezier(.4,0,.2,1)}
.row-status{display:grid;place-items:center;width:16px;height:16px;flex:0 0 16px;color:var(--muted)}
.row-status .spark{width:14px;height:14px}
.waiting-indicator{display:grid;place-items:center;width:14px;height:14px;border:1px solid currentColor;border-radius:50%;font-size:10px;line-height:12px;font-weight:500}
.row:active{background:var(--hover)}
.row .name{flex:1;min-width:0;font-size:14px;font-weight:400;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .time{font-size:11px;line-height:18px;color:var(--muted);flex:none;white-space:nowrap;font-variant-numeric:tabular-nums}
.dot{width:6px;height:6px;border-radius:50%;background:#3b82f6;display:inline-block;flex:none}
@media(hover:hover){.row:hover,.icon:hover{background:var(--hover)}}
.list-status{display:flex;align-items:center;gap:8px;padding:8px 8px;font-size:12px;line-height:18px;color:var(--muted)}
.list-status button{margin-left:auto;min-height:32px;padding:0 8px;border-radius:8px;font-size:12px;color:var(--text)}
.waiting-status{min-height:24px;display:flex;align-items:center;gap:6px;color:var(--faint);font-size:12px;line-height:20px}
.waiting-status:before{content:"";width:10px;height:10px;border:1.5px solid var(--line);border-top-color:var(--faint);border-radius:50%;animation:spin .8s linear infinite}
.empty{padding:80px 32px;text-align:center;color:var(--muted)}
#chat{display:flex;flex-direction:column;overflow:hidden}
#messages{min-width:0;min-height:0;flex:1;overflow:auto;overflow-anchor:none;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:20px var(--conversation-gutter) 24px;display:flex;flex-direction:column;gap:20px}
/* Same 16px outer axis as the measured Codex conversation; never a full-width status rail. */
#waitingStatus,#planDock,#composer{width:var(--conversation-width);min-width:0;margin-left:auto;margin-right:auto}
.msg{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;flex:none}
.msg.user{align-items:flex-end}
.bubble{max-width:86%;padding:10px 16px;border-radius:18px;background:var(--bubble);white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:24px}
.msg.user .bubble{max-width:90%}
.user-text.collapsed{max-height:132px;overflow:hidden;mask-image:linear-gradient(#000 75%,transparent)}
.expand-message{display:block;min-height:32px;font-size:12px;color:var(--muted);margin-top:4px}
.msg.assistant .bubble{background:transparent;padding:0;max-width:100%;border-radius:0;white-space:normal;font-size:14px;line-height:24px}
.bubble p{margin:0 0 10px}.bubble p:last-child{margin-bottom:0}
.bubble pre{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 12px;overflow:auto;font-size:12.5px;line-height:1.5;margin:8px 0}
.bubble code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
.bubble :not(pre)>code{background:var(--bubble);border-radius:6px;padding:1px 5px}
.bubble .imgs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.bubble .imgs img{width:96px;height:96px;object-fit:cover;border-radius:12px;background:var(--surface)}
.think{color:var(--faint);font-size:13px;line-height:22px}
.think summary,.activity>summary{list-style:none;display:flex;align-items:center;gap:6px;min-height:32px;cursor:pointer;color:var(--faint);font-size:13px;font-weight:400}
.think summary::-webkit-details-marker,.activity>summary::-webkit-details-marker,.tool summary::-webkit-details-marker{display:none}
.think summary:after,.activity>summary:after{content:'';display:block;flex:none;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);margin:0 3px;transition:transform .15s}
.think[open]>summary:after,.activity[open]>summary:after{transform:rotate(45deg)}
.think .body{white-space:pre-wrap;margin:4px 0 8px;padding-left:12px;border-left:1px solid var(--line);overflow-wrap:anywhere;font-size:13px;line-height:22px}
.spark{width:12px;height:12px;border:1.5px solid var(--line);border-top-color:var(--faint);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.activity{margin:0;color:var(--faint)}
.process-content{padding-left:8px;border-left:1px solid var(--line)}
.process-content>.tools{padding-left:0;border-left:0}
.tool.unconfirmed .status:after{content:"…"}
.tools{display:flex;flex-direction:column;gap:0;margin:2px 0 8px;padding-left:8px;border-left:1px solid var(--line)}
.tool{min-width:0;font-size:13px}
.tool summary{display:flex;gap:6px;align-items:center;min-height:32px;list-style:none;cursor:pointer}
.tool .name{font-weight:400;color:var(--muted);flex:none;max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool .detail{color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:12px}
.tool .status{width:14px;height:14px;display:grid;place-items:center;flex:none;color:var(--faint);font-size:11px}
.tool.failed .status{color:#b04432}
.tool.failed .status:after{content:'!'}
.tool .status:after{content:'✓'}
.tool.pending .status{border:1.5px solid var(--line);border-top-color:var(--faint);border-radius:50%;animation:spin .8s linear infinite}
.tool.pending .status:after{content:''}
.tool.failed .status:after{content:'!'}
.tool .chev{color:var(--faint);font-size:14px;line-height:1;flex:none;transition:transform .15s ease}
.tool[open] .chev{transform:rotate(90deg)}
.tool pre{margin:2px 0 8px;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/20px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.plan-btn{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:0 6px 5px;margin:0 0 6px;border-bottom:.5px solid var(--line);color:var(--muted);font-size:12px;text-align:left}
.plan-btn svg{width:14px;height:14px;flex:none}
#planLabel{white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
#planTask{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--faint)}
.plan-btn:after{content:'';width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(-45deg);flex:none;margin-right:4px;transition:transform .15s}
.plan-details .plan-row{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;font-size:13px;line-height:20px}
.plan-details .plan-row .txt{flex:1;min-width:0;overflow-wrap:anywhere}
.plan-details .plan-row .ico{width:16px;flex:none;text-align:center;color:var(--faint)}
.plan-details .plan-row.done .txt{color:var(--faint);text-decoration:line-through}
.plan-details .plan-row.in_progress .ico{color:var(--accent)}
.plan-details .plan-row.in_progress .txt{font-weight:600}
.plan-details .plan-title{font-size:12px;font-weight:600;color:var(--muted);margin:16px 20px 4px;letter-spacing:.02em}
.typing{display:inline-flex;gap:4px;align-items:center;height:18px}
.typing i{width:5px;height:5px;border-radius:50%;background:var(--faint);animation:blink 1.2s infinite}
.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,60%,100%{opacity:.25}30%{opacity:1}}
.message-delivery,.queued-status{display:flex;align-items:center;gap:8px;max-width:90%;min-width:0;color:var(--muted);font-size:12px;line-height:18px;overflow-wrap:anywhere}.message-delivery>span{min-width:0}.message-delivery.failed{color:var(--text)}.message-delivery button{flex:none;min-height:32px;padding:2px 6px;color:var(--text);white-space:nowrap;border-radius:8px}.message-delivery button:active{background:var(--hover)}
.session-status{display:flex;align-items:center;gap:8px;min-height:28px;padding:0 0 8px;color:var(--muted);font-size:13px;line-height:20px;flex:none}
.runtime-icon{flex:none}.runtime-text{flex:1;min-width:0;overflow-wrap:anywhere}.runtime-duration{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--faint)}
.session-status button{flex:none;min-height:32px;padding:0 8px;border-radius:8px;color:var(--text)}.session-status button:active{background:var(--hover)}
#readStatus{width:var(--conversation-width);margin:0 auto;padding:8px 0;flex:none}
.err{color:#c0392b;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.recovery-error{justify-content:center;padding:24px 16px;text-align:center;color:var(--muted)}
.recovery-error>span{flex-basis:100%;margin-bottom:6px}
.recovery-error>button{min-height:44px;padding:10px 18px;border:1px solid transparent;border-radius:12px;background:var(--text);color:var(--bg);font-size:14px}
.recovery-error>button[data-secondary]{background:transparent;color:var(--text);border-color:var(--line)}
.err:not(.recovery-error) button{padding:5px 12px;border-radius:999px;background:var(--bubble);color:var(--text);font-size:12px;font-weight:600}
#composer{max-height:calc(var(--ui-height,100dvh) - 68px);overflow-y:auto;overscroll-behavior:contain;flex:none;display:flex;flex-direction:column;gap:4px;margin-bottom:calc(env(safe-area-inset-bottom) + 16px);padding:10px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 2px 10px rgba(24,30,40,.025)}
.attachments{display:flex;gap:8px;padding:0 0 4px;overflow-x:auto}
.thumb{position:relative;width:56px;height:56px;border-radius:9px;overflow:hidden;background:var(--bubble);flex:none}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb .rm{position:absolute;top:3px;right:3px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center}
.thumb .up{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);color:#fff;font-size:11px}
.box{display:flex;min-width:0;padding:0}
#input{flex:1;min-width:0;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--text);font:inherit;font-size:16px;line-height:24px;height:44px;min-height:44px;max-height:44px;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;padding:2px 0 14px}
#input::placeholder{color:var(--faint);font-size:16px}
#send{position:relative;width:32px;height:32px;border:0;border-radius:50%;background:var(--accent);color:var(--accent-text);display:grid;place-items:center;flex:none}
#send:before,.tool-btn:before{content:"";position:absolute;inset:-6px}
#send svg{width:17px;height:17px;display:block}
#send.is-sending svg{display:none}
#send.is-sending:after{content:"";width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
#send:disabled{opacity:.4;cursor:default}
.tools-row{position:sticky;bottom:0;background:var(--surface);z-index:1;display:grid;grid-template-columns:32px minmax(0,1fr) 32px;align-items:center;gap:4px;min-height:32px;padding:0}
#modeChip{display:none!important}
.tool-btn{position:relative;width:32px;height:32px;border-radius:8px;border:0;background:transparent;color:var(--muted);display:grid;place-items:center}
.tool-btn svg{width:18px;height:18px;display:block}
.tool-btn:active{background:var(--hover)}
.model-btn{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;flex:1 1 auto;width:auto;height:32px;padding:0 4px;font-size:14px;font-weight:400;color:var(--muted)}
.model-btn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-btn .model-provider{flex:none;font-size:10px;color:var(--faint)}.model-provider:empty{display:none}
.model-btn svg{width:12px;height:12px;flex:none;color:var(--faint)}
.spacer{flex:1}
.note{font-size:12px;color:var(--faint);text-align:center;padding:2px 0}
.history-top{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--muted);font:inherit;font-size:13px;line-height:18px;cursor:pointer}
.history-top.loading{color:var(--muted)}
.history-top .spinner{width:14px;height:14px;border:1.5px solid var(--line);border-top-color:var(--muted);border-radius:50%;animation:spin .8s linear infinite}
.image-placeholder{display:flex;align-items:center;justify-content:center;min-width:120px;height:64px;padding:0 12px;border-radius:12px;background:var(--bubble);color:var(--faint);font-size:12px}
.options-menu{position:fixed;z-index:25;width:max-content;min-width:170px;max-width:calc(100vw - 20px);max-height:min(400px,55dvh);overflow-y:auto;overscroll-behavior:contain;padding:8px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:16px;box-shadow:0 5px 24px rgba(15,17,21,.1);animation:menu-in 120ms ease-out}
.options-menu.model-menu{width:max-content;min-width:min(160px,calc(100vw - 16px));max-width:min(240px,calc(100vw - 16px));overflow-x:hidden}
.model-menu .menu-option .check{order:2}.model-menu .model-source{order:1;flex:none;font-size:11px;color:var(--faint);white-space:nowrap}
.model-menu .menu-option>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;overflow-wrap:normal}
.workspace-path-form{display:flex;gap:6px;padding:8px 2px 2px;border-top:.5px solid var(--line);margin-top:4px}
.workspace-path-form input{min-width:0;width:200px;font-family:inherit;font-size:12px;line-height:20px;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px}
.workspace-path-form button{padding:0 6px;min-height:32px;color:var(--accent);font-size:12px;white-space:nowrap}
.options-menu .menu-option{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:36px;padding:7px 10px;border-radius:8px;font-size:14px;line-height:20px;text-align:left}
.options-menu .menu-option:active,.options-menu .menu-option:focus-visible{background:var(--hover);outline:1px solid var(--faint);outline-offset:-1px}
@media(hover:hover){.options-menu .menu-option:hover{background:var(--hover)}}
.menu-option>span:first-child{min-width:0;flex:1;overflow-wrap:anywhere}
.menu-option .check{flex:none;width:14px;color:var(--muted)}
.options-menu .hint{padding:7px 10px;font-size:11px;line-height:18px}
@keyframes menu-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
/* 展开的待办是浮层：绝对定位在卡片上方，不参与文档流，背后的对话
   文字和滚动位置保持不动，只有清单本身从底部升起。 */
.plan-details{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:5;display:grid;grid-template-rows:0fr;opacity:0;pointer-events:none;overflow:hidden;background:var(--surface);border:.5px solid var(--line);border-radius:18px;box-shadow:0 10px 30px rgba(24,30,40,.14),0 1px 3px rgba(24,30,40,.05);transition:grid-template-rows 200ms ease,opacity 160ms ease}
.plan-details[data-expanded="true"]{grid-template-rows:1fr;opacity:1;pointer-events:auto}
.plan-inner{min-height:0;overflow:hidden}
/* 待办和输入框分开挂载：待办在上方独立成卡片，输入框保持原来的空高度。 */
.plan-dock{position:relative;flex:none;margin-bottom:8px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:0 2px 10px rgba(24,30,40,.025)}
.plan-dock .plan-btn{min-height:40px;padding:0 10px;margin:0;border-bottom:0;border-radius:15px;font-size:13px;line-height:20px}
.plan-dock .plan-btn[aria-expanded="true"]{border-bottom:.5px solid var(--line)}
.plan-dock .plan-list{margin:6px 8px 8px;max-height:min(46dvh,360px)}
.plan-list{max-height:min(160px,calc(var(--ui-height,100dvh) * .24));overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;margin:0 4px 8px;padding:4px 0;border-radius:8px;background:var(--bg)}
.plan-btn[aria-expanded="true"]:after{transform:rotate(45deg)}
.hint{padding:10px 20px;font-size:12px;color:var(--faint);line-height:1.5}
.bubble h1,.bubble h2,.bubble h3,.bubble h4{font-weight:500;line-height:1.5;margin:20px 0 8px}
.bubble h1{font-size:22px}.bubble h2{font-size:19px}.bubble h3{font-size:17px}.bubble h4{font-size:15px}
.bubble ul,.bubble ol{padding-left:22px;margin:10px 0}.bubble li{margin:5px 0}
.bubble blockquote{margin:12px 0;padding-left:12px;border-left:2px solid var(--line);color:var(--muted)}
.bubble a,.file-link{color:var(--accent);text-decoration:none;overflow-wrap:anywhere}
.file-link{display:inline-flex;align-items:center;gap:0;max-width:100%;font-size:inherit;cursor:pointer;vertical-align:baseline}
.file-link:has(img){display:block}
.file-link:has(img):before{display:none}
.file-link:before{display:none}.file-link span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bubble hr{border:0;border-top:.5px solid var(--line);margin:20px 0}
.table-scroll{width:100%;overflow:auto;margin:12px 0;border:.5px solid var(--line);border-radius:10px}
.bubble table{width:100%;border-collapse:collapse;font-size:13px;line-height:21px}
.bubble th,.bubble td{padding:8px 10px;text-align:left;border-bottom:.5px solid var(--line);min-width:90px;vertical-align:top}
.bubble th{font-weight:500;background:var(--bg)}.bubble tr:last-child td{border:0}
.bubble img{display:block;max-width:100%;height:auto;border-radius:10px;margin:10px 0;cursor:zoom-in}
.file-view{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;background:var(--surface)}
.file-bar{height:48px;display:flex;align-items:center;gap:8px;border-bottom:.5px solid var(--line);padding:0 12px;flex:none}
.file-bar strong{font-size:13px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-bar button{min-width:44px;min-height:44px;color:var(--muted);font-size:14px}
.file-content{position:relative;flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.file-content iframe{width:100%;height:100%;border:0;background:var(--surface)}
.markdown-preview{max-width:100%;border-radius:0;background:transparent;white-space:normal;padding:20px 24px;min-height:100%;font-size:14px;line-height:1.65}
.preview-status{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:32px 20px;min-height:100%;text-align:center;color:var(--muted);font-size:13px}
.preview-retry{min-height:36px;padding:6px 14px;border:1px solid var(--line);border-radius:8px;color:var(--text);background:var(--surface);font-size:13px}
.media-status{position:absolute;inset:auto 12px 12px;min-height:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:12px;z-index:2}
.inline-image-error{display:flex;align-items:center;gap:8px;margin:8px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:12px;color:var(--muted)}
.file-content>img{max-width:100%;display:block;margin:auto;touch-action:pinch-zoom}
.image-stage{width:100%;height:100%;display:grid;place-items:center;overflow:hidden;touch-action:none}
.image-stage img{width:100%;height:100%;object-fit:contain;transform-origin:center;user-select:none}
.image-controls{position:absolute;bottom:12px;right:12px;display:flex;gap:2px;padding:2px;border-radius:12px;background:var(--surface);box-shadow:0 2px 12px #00000015}
.image-controls button{min-width:40px;min-height:40px;font-size:13px;color:var(--muted)}
.file-content pre{padding:16px;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/22px ui-monospace,SFMono-Regular,Menlo,monospace}
</style></head>
<body>
<header class="bar">
  <button class="icon" id="back" aria-label="会话列表" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5m7-7-7 7 7 7"/></svg></button>
  <div class="title" id="title">Claude</div>
  <button class="icon" id="new" aria-label="新建会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
</header>
<div id="readStatus" class="list-status hidden" role="status" aria-live="polite"></div>
<main class="view" id="list" data-loaded="false">
  <div class="group"><span>工作区</span><button type="button" id="workspaceView" aria-label="视图选项"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1" aria-hidden="true"><path d="M2.3 5h5.85M12.05 5h1.65"/><circle cx="9.95" cy="5" r="1.45"/><path d="M2.3 11h1.65M7.85 11h5.85"/><circle cx="5.75" cy="11" r="1.45"/></svg></button><button type="button" id="workspaceNew" aria-label="新建会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>
  <div id="listStatus" class="list-status hidden" role="status"></div>
  <div id="rows"></div>
  <div class="empty hidden" id="empty">还没有会话，点右上角 ＋ 新建</div>
</main>
<main class="view hidden" id="chat">
  <div id="messages"></div>
</main>
<div id="waitingStatus" class="waiting-status hidden" role="status" aria-live="polite"></div>
<div id="planDock" class="plan-dock hidden">
  <button type="button" class="plan-btn hidden" id="planChip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1.2 1.2L7.5 4.9M4 12l1.2 1.2L7.5 10.9M4 18l1.2 1.2L7.5 16.9"/></svg><span id="planLabel">待办</span><span id="planTask"></span></button>
  <div id="planDetails" class="plan-details" data-expanded="false" inert><div class="plan-inner"><div class="plan-list" id="planList" role="region" aria-label="待办清单"></div></div></div>
</div>
<form id="composer" class="hidden">
  <div class="attachments hidden" id="attachments"></div>
  <div class="box"><textarea id="input" rows="1" placeholder="发消息，继续你的任务…" enterkeyhint="send"></textarea></div>
  <div class="tools-row">
    <button type="button" class="tool-btn" id="attach" aria-label="添加图片"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button>
    <button type="button" class="tool-btn" id="modeChip" aria-label="权限"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5.2c0 4.4-2.9 7.9-7 9.8-4.1-1.9-7-5.4-7-9.8V6z"/></svg></button>


    <button type="button" class="model-btn" id="modelChip"><span id="modelLabel">模型</span><span id="modelProvider" class="model-provider"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></button>
    <button id="send" type="submit" aria-label="发送"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
  </div>
  <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
</form>
<div class="options-menu hidden" id="optionsMenu" role="menu" aria-label="选项"></div>
<script>${MARKED}</script>
<script>${MEDIA_PREVIEW}</script>
<script>${UNREAD_INDICATOR}</script>
<script>${RENDERER}</script>
<script>${ASSISTANT_VIEW}</script>
<script>
(() => {
  const state = {
    sessions:[], listView:localStorage.getItem('clm-list-view')==='recent'?'recent':'project', sessionId:null, cwd:null, sending:false, loading:false, viewVersion:0,
    capabilities:null,modelsLoaded:false,modelsError:null,priority:'now',control:null,actualModel:null,deliveryViewId:null,models:[], model:localStorage.getItem('clm-model')||'',
    mode:localStorage.getItem('clm-mode')||'', defaultMode:null,
    attachments:[], draftRevision:null, plan:null, planOpen:false, running:false, since:0, cursorAnchor:null, pollTimer:null, before:null, hasOlder:false, loadingOlder:false,
  };
  const $ = id => document.getElementById(id);
  const listView = $('list'), chatView = $('chat'), composer = $('composer');
  const rows = $('rows'), messages = $('messages'), title = $('title'), input = $('input');

  let claudeBuild=null, claudePendingBuild=false;
  function buildReloadSafe(){
    return !state.sending&&!state.loading&&!input.value.trim()&&!state.attachments.length&&!composing&&![...deliveryCommands.values()].some(request=>request.posting)&&![...drafts.values()].some(draft=>draft.attachments?.some(item=>item.uploading||(!item.id&&item.file)));
  }
  window.__claudeMobileReloadSafe=buildReloadSafe;
  async function checkClaudeBuild(){
    try{
      const response=await fetch('/claude/api/build',{cache:'no-store',credentials:'same-origin'});
      if(!response.ok)return;
      const value=await response.json();
      if(!value.build)return;
      if(claudeBuild===null){claudeBuild=value.build;return;}
      if(value.build!==claudeBuild){
        claudeBuild=value.build;
        // A background upload or IME edit is still unsaved work, not an empty composer.
        if(buildReloadSafe())location.reload();
        else claudePendingBuild=true;
      }
    }catch{}
  }
  checkClaudeBuild();
  setInterval(()=>{if(hubActive&&!document.hidden)checkClaudeBuild();},10000);
  setInterval(()=>{if(claudePendingBuild&&buildReloadSafe()&&!document.hidden)location.reload();},3000);
  let hubActive=parent===window;
  state.unread=window.claudeUnread;
  if(parent!==window)document.documentElement.style.setProperty('--chat-height','100%');
  else{const resize=()=>document.documentElement.style.setProperty('--chat-height',(visualViewport?.height||innerHeight)+'px');visualViewport?.addEventListener('resize',resize);window.addEventListener('resize',resize);resize();}
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='mobile-hub-active')return;
    if(event.data.active===hubActive)return;
    if(!event.data.active)state.navigation.capture();
    hubActive=Boolean(event.data.active);
    if(!hubActive){state.unread?.pause?.();closeMenu();input.blur();stopPoll();}else{state.navigation.restore();if(!state.loading)poll();startPoll();}
  });
  // 主动向父页面确认一次激活状态；父页面收到后回发当前 active，避免首条消息
  // 丢失导致聊天页再也不轮询。
  if(parent!==window){try{parent.postMessage({type:'mobile-hub-hello'},location.origin);}catch{}}
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function updateHistoryTop(){
    let top=$('historyTop');
    if(!state.hasOlder){top?.remove();return;}
    if(!top){
      top=document.createElement('button');top.type='button';top.id='historyTop';top.className='history-top';
      top.addEventListener('click',()=>loadOlder());
    }
    if(messages.firstElementChild!==top)messages.prepend(top);
    top.classList.toggle('loading',state.loadingOlder);
    top.disabled=state.loadingOlder;
    top.setAttribute('aria-label',state.loadingOlder?'正在加载更早的消息':'加载更早的消息');
    top.replaceChildren();
    if(state.loadingOlder){const spinner=document.createElement('span');spinner.className='spinner';spinner.setAttribute('aria-hidden','true');top.append(spinner);}
    const text=document.createElement('span');text.textContent=state.loadingOlder?'正在加载更早的消息…':'加载更早的消息';top.append(text);
  }
  function resetHistoryPaging(){
    state.historyController?.abort();state.historyController=null;
    state.loadingOlder=false;state.before=null;state.hasOlder=false;
    state.readStatus?.('history');
  }
  async function loadOlder(){
    if(state.loadingOlder||!state.hasOlder||state.loading||!state.before||!state.sessionId)return;
    const id=state.sessionId,version=state.viewVersion,controller=new AbortController();
    state.historyController=controller;state.loadingOlder=true;state.readStatus?.('history');updateHistoryTop();
    let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    try{
      const {response,value}=await Promise.race([(async()=>{
        const response=await fetch('/claude/api/session/'+encodeURIComponent(id)+'?before='+encodeURIComponent(state.before),{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        return {response,value:await response.json()};
      })(),timeout]);
      if(version!==state.viewVersion||state.sessionId!==id||controller.signal.aborted)return;
      if(!response.ok)throw Error(value.error||'读取失败');
      const batch=Array.isArray(value.messages)?value.messages:[];
      if(batch.length){
        const holder=document.createElement('div'),anchor=messages.scrollHeight;
        const previousAssistant=historyAssistant;historyAssistant=null;
        try{for(const message of batch)appendMessage(message,holder);}finally{historyAssistant=previousAssistant;}
        messages.prepend(...[...holder.childNodes]);
        messages.scrollTop+=messages.scrollHeight-anchor;
      }
      state.before=Number.isFinite(value.before)?value.before:null;
      state.hasOlder=value.hasMore===true;
    }catch(error){
      if(version===state.viewVersion&&state.sessionId===id&&(timedOut||!controller.signal.aborted))state.readStatus?.('history','更早的消息加载失败。',()=>loadOlder(),()=>state.sessionId===id&&state.viewVersion===version&&state.hasOlder);
    }finally{
      clearTimeout(timer);
      if(state.historyController===controller){state.historyController=null;state.loadingOlder=false;updateHistoryTop();}
    }
  }
  function renderText(container, text){
    window.claudeRender(container, text, state.sessionId);
    if(!container.dataset.scrollKey)container.dataset.scrollKey='text:'+renderingMessageId;
    [...container.children].forEach((child,index)=>{child.dataset.scrollKey=container.dataset.scrollKey+':'+index;});
  }
  function timeText(ms){
    const d = new Date(ms), now = new Date();
    const hm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    if(d.toDateString() === now.toDateString()) return hm;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate()-1);
    if(d.toDateString() === yesterday.toDateString()) return '昨天 ' + hm;
    if(d.getFullYear() !== now.getFullYear()) return d.getFullYear() + '年' + (d.getMonth()+1) + '月' + d.getDate() + '日';
    return (d.getMonth()+1) + '月' + d.getDate() + '日';
  }
  // Keep reading state outside hidden DOM metrics. Layout/focus changes never
  // count as user intent, and an async restore belongs to one view version only.
  state.navigation=(() => {
    const storage='clm-reading-positions-v1';
    let positions;try{positions=new Map(JSON.parse(sessionStorage.getItem(storage)||'[]'));}catch{positions=new Map();}
    let frame=0,restoring=false;
    const key=()=>listView.classList.contains('hidden')?(draftKey?'chat:'+draftKey:null):'list:'+state.listView;
    const node=()=>listView.classList.contains('hidden')?messages:listView;
    const visible=element=>hubActive&&!document.hidden&&element.getClientRects().length>0;
    const blocked=()=>chatView.inert||composer.inert;
    const persist=()=>{try{sessionStorage.setItem(storage,JSON.stringify([...positions].slice(-40)));}catch{}};
    function capture(){
      const element=node(),id=key();
      if(!id||!visible(element)||restoring||(element===listView&&rows.dataset.listView!==state.listView)||(element===messages&&(state.loading||blocked())))return;
      const top=element.getBoundingClientRect().top;
      let anchor=null;
      for(const child of element.querySelectorAll('[data-scroll-key]')){
        const rect=child.getBoundingClientRect();
        if(!child.getClientRects().length||rect.bottom<=top||rect.top>=top+element.clientHeight)continue;
        if(!anchor||rect.top<=top)anchor={key:child.dataset.scrollKey,offset:rect.top-top};
        if(rect.top>top)break;
      }
      positions.set(id,{top:Math.max(0,element.scrollTop),anchor,follow:element===messages&&followOutput});persist();
    }
    function apply(){
      const element=node(),saved=positions.get(key());
      if(!saved||!visible(element)||(element===messages&&state.loading))return;
      restoring=true;
      if(element===messages)followOutput=Boolean(saved.follow);
      let target=saved.top;
      if(element===messages&&saved.follow)target=element.scrollHeight;
      else if(saved.anchor){
        const anchor=[...element.querySelectorAll('[data-scroll-key]')].find(child=>child.dataset.scrollKey===saved.anchor.key&&child.getClientRects().length);
        if(anchor)target=element.scrollTop+anchor.getBoundingClientRect().top-element.getBoundingClientRect().top-saved.anchor.offset;
      }
      element.scrollTop=target;restoring=false;
    }
    function restore(){
      cancelAnimationFrame(frame);apply();const version=state.viewVersion,id=key();
      frame=requestAnimationFrame(()=>{if(version===state.viewVersion&&id===key())apply();});
    }
    for(const element of [listView,messages]){
      element.addEventListener('scroll',()=>{if(element===listView)capture();},{passive:true});
      for(const type of ['wheel','touchmove','keydown'])element.addEventListener(type,()=>{cancelAnimationFrame(frame);},{passive:true});
    }
    document.addEventListener('pointerdown',capture,true);
    document.addEventListener('click',event=>{if(messages.contains(event.target))capture();},true);
    window.addEventListener('pagehide',capture);
    window.addEventListener('pageshow',restore);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){restore();if(hubActive&&!state.loading){poll();startPoll();}}else{closeMenu();stopPoll();}});
    // Preview focus return and late media/layout measurements must retain the
    // stored anchor. No preview implementation is coupled to navigation here.
    new MutationObserver(restore).observe(document.body,{attributes:true,subtree:true,attributeFilter:['inert']});
    messages.addEventListener('load',restore,true);
    new ResizeObserver(restore).observe(messages);
    return {capture,restore,has:()=>positions.has(key()),resetFollow:()=>{followOutput=true;userScrolling=false;clearTimeout(scrollIntentTimer);}};
  })();
  window.__claudeMobileHubDeactivate=()=>{try{state.navigation.capture();}catch{}};

  // Recoverable read failures never change a command's delivery outcome.
  state.readStatus=(() => {
    const errors=new Map();
    const render=()=>{
      const box=$('readStatus');box.replaceChildren();
      const active=[...errors.values()].find(error=>!error.visible||error.visible());
      box.classList.toggle('hidden',!active);if(!active)return;
      const text=document.createElement('span');text.textContent=active.text;
      const retry=document.createElement('button');retry.type='button';retry.textContent='重试';
      retry.onclick=async()=>{retry.disabled=true;try{await active.retry();}catch{}finally{if(retry.isConnected)retry.disabled=false;}};
      box.append(text,retry);
    };
    const set=(key,text,retry,visible)=>{if(text)errors.set(key,{text,retry,visible});else errors.delete(key);render();};
    set.render=render;return set;
  })();

  function rememberView(view){try{sessionStorage.setItem('clm-current-view-v1',JSON.stringify(view));history.replaceState({...history.state,claudeMobileView:view},'');}catch{}}
  function readRememberedView(){try{return JSON.parse(sessionStorage.getItem('clm-current-view-v1')||'null')||history.state?.claudeMobileView;}catch{return history.state?.claudeMobileView||null;}}
  function projectName(cwd){
    if(!cwd) return '';
    const parts = cwd.split('/').filter(Boolean);
    return parts[parts.length-1] || cwd;
  }

  const drafts=new Map(),pendingRequests=new Map();let draftKey=null;
  const draftStorage='clm-drafts-v1';
  try{
    for(const [key,value] of Object.entries(JSON.parse(sessionStorage.getItem(draftStorage)||'{}'))){
      if(!value||typeof value.text!=='string')continue;
      const attachments=(Array.isArray(value.attachments)?value.attachments:[]).filter(item=>item&&typeof item==='object').map(item=>item.id&&!item.uploading?item:{...item,uploading:false,failed:true,error:item.error||'图片上传已中断，请重新选择图片'});
      drafts.set(key,{...value,attachments});
    }
  }catch{}

  function currentRequest(){return [...pendingRequests.values()].find(request=>request.posting&&requestInView(request))||null;}
  // CSS owns the original fixed height; empty drafts only reset inner scrolling.
  function syncInputHeight(){if(!input.value)input.scrollTop=0;}
  function afterComposerVisible(){const key=draftKey,version=state.viewVersion;requestAnimationFrame(()=>{if(key!==draftKey||version!==state.viewVersion||chatView.classList.contains('hidden'))return;syncInputHeight();viewportChanged();state.navigation?.restore();});}
  function persistDrafts(){
    // File objects and blob URLs cannot survive a document reload. Keep them in
    // memory only; an interrupted selection is restored honestly as retryable.
    try{sessionStorage.setItem(draftStorage,JSON.stringify(Object.fromEntries([...drafts].slice(-40)),(key,value)=>key==='file'||key==='preview'?undefined:value));}catch{}
  }
  function saveDraft(changed=false){
    if(!draftKey)return;
    const previous=drafts.get(draftKey);
    // Comparing snapshots detects programmatic edits; delivery matching uses
    // only the revision, never text equality. Every input event advances it.
    if(changed||!state.draftRevision||(previous&&(previous.text!==input.value||previous.attachments.length!==state.attachments.length||previous.attachments.some((item,index)=>item!==state.attachments[index]))))state.draftRevision=crypto.randomUUID();
    drafts.set(draftKey,{text:input.value,attachments:state.attachments.slice(),viewId:state.deliveryViewId,revision:state.draftRevision});
    persistDrafts();
  }
  function restoreDraft(key){
    draftKey=key;const value=drafts.get(key);input.value=value?.text||'';state.attachments=value?.attachments?.slice()||[];
    state.draftRevision=value?.revision||crypto.randomUUID();
    input.scrollTop=0;renderAttachments();afterComposerVisible();
  }
  function showList(){
    state.navigation?.capture();
    rememberView({kind:'list'});closeMenu();saveDraft(); draftKey=null;
    state.sessionController?.abort();state.viewVersion++; state.loading=false;resetHistoryPaging();
    stopPoll();
    state.sessionId = null;state.since=0;state.cursorAnchor=null;state.control=null;setWaitingStatus(null);
    state.deliveryViewId = null;
    state.running = false;
    $('back').hidden = true;
    title.textContent = 'Claude';
    listView.classList.remove('hidden');
    chatView.classList.add('hidden');
    composer.classList.add('hidden');
    $('planDock').classList.add('hidden');$('planChip').classList.add('hidden');
    $('empty').classList.toggle('hidden',!state.listLoaded||Boolean(state.sessions.length));
    if(state.unread)renderSessions();state.navigation?.restore();state.readStatus?.render();return refreshSessions();
  }
  window.__mobileHubHome=async()=>{await showList();return false;};
  const closedWorkspaces = new Set((() => { try{return JSON.parse(sessionStorage.getItem('clm-closed-workspaces')||'[]');}catch{return [];} })());
  let listRequest=0,listController=null;
  function listStatus(text,retry){
    const status=$('listStatus');status.replaceChildren();status.classList.toggle('hidden',!text);
    if(text){const label=document.createElement('span');label.textContent=text;status.append(label);if(retry){const button=document.createElement('button');button.type='button';button.textContent='重试';button.onclick=refreshSessions;status.append(button);}}
  }
  async function refreshSessions(){
    state.listLoadError=false;
    const version=state.viewVersion,request=++listRequest;listController?.abort();const controller=new AbortController();listController=controller;let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    state.navigation?.capture();$('list').setAttribute('aria-busy','true');listStatus(state.sessions.length?'':'正在加载…');state.navigation?.restore();
    try{
      const value=await Promise.race([(async()=>{const response=await fetch('/claude/api/sessions',{cache:'no-store',credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error('会话列表读取失败');return response.json();})(),timeout]);
      if(version!==state.viewVersion||request!==listRequest||listView.classList.contains('hidden'))return;
      const next=Array.isArray(value.sessions)?value.sessions:[];
      state.sessions=next;state.listLoaded=true;if(listView.dataset)listView.dataset.loaded='true';renderSessions();
      listStatus('');state.navigation?.restore();$('empty').textContent='还没有会话，点工作区右侧 ＋ 新建';$('empty').classList.toggle('hidden',Boolean(state.sessions.length));
    }catch(error){
      if((controller.signal.aborted&&!timedOut)||version!==state.viewVersion||request!==listRequest)return;
      state.listLoadError=true;
      listStatus(timedOut?'会话列表读取超时，请重试':state.sessions.length?'刷新失败，保留上次列表':'会话暂时无法加载',true);$('empty').classList.add('hidden');state.navigation?.restore();
    }finally{clearTimeout(timer);if(listController===controller)listController=null;if(version===state.viewVersion&&request===listRequest)$('list').setAttribute('aria-busy','false');}
  }
  setInterval(()=>{if(hubActive&&!document.hidden&&!listView.classList.contains('hidden')&&!listView.inert&&!listController&&$('optionsMenu').classList.contains('hidden'))refreshSessions();},8000);
  window.__mobileHubReadiness=()=>{
    if(state.loading||state.hubRefreshing)return 'loading';
    if(!listView.classList.contains('hidden'))return state.listLoadError?'error':listController||!state.listLoaded?'loading':'ready';
    if(state.sessionId)return state.chatLoadError?'error':state.chatLoadedSessionId===state.sessionId?'ready':'loading';
    return state.modelsLoaded?'ready':state.modelsError?'error':'loading';
  };
  window.__claudeMobileRefresh=async()=>{
    // Refresh reads, not the document: live File/IME/composer state must survive.
    // The hub covers the view while reading; do not acknowledge unseen replies.
    state.hubRefreshing=true;
    try{
      state.navigation?.capture();saveDraft();
      if(!listView.classList.contains('hidden'))return await refreshSessions();
      if(state.sessionId)return await poll();
      // An unsent draft has no conversation to reopen or create.
      return await loadModels();
    }finally{state.hubRefreshing=false;}
  };
  function updateSendState(){
    state.sending=Boolean(currentRequest());
    const uploading=state.attachments.some(item=>item.uploading),failed=state.attachments.some(item=>item.failed),binding=unboundRequest();
    $('send').classList.toggle('is-sending',state.sending);
    $('send').disabled=!state.modelsLoaded||state.sending||state.loading||Boolean(binding)||uploading||failed||(state.attachments.length>0&&state.capabilities?.attachments!==true)||(!input.value.trim()&&!state.attachments.some(item=>item.id));
    $('send').setAttribute('aria-label',failed?'图片上传失败，请重试或移除':uploading?'图片上传中':state.sending?'正在提交':binding?'等待会话确认，草稿已保留':'发送');
    if(binding&&!binding.posting)state.readStatus?.('session-binding','首条消息的会话尚未确认，草稿已保留。',()=>checkDelivery(binding),()=>unboundRequest()===binding);
    else state.readStatus?.('session-binding');
    $('new').disabled=state.loading;
  }
  let workspacePanelId=0;
  function renderSessions(){
    const scrollTop=listView.scrollTop,groups=new Map(),recent=state.listView==='recent';
    // Tie ordering must not depend on a catalog's incidental iteration order.
    const ordered=state.sessions.slice().sort((a,b)=>b.updatedAt-a.updatedAt||String(a.id).localeCompare(String(b.id)));
    for(const session of ordered){
      const key=recent?'':session.cwd||'';
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(session);
    }
    const live=new Map(ordered.map(session=>{
      const status=runtimeStatus(session);
      // The left status slot owns activity/unread; the right edge is always time.
      return [session.id,{...status,label:timeText(session.updatedAt)}];
    }));
    // Snapshot revisions, process attachment and ticking server clocks alone do
    // not rerender rows. Only the visible runtime state joins the fingerprint.
    const fingerprint=JSON.stringify([state.listView,[...groups].map(([cwd,sessions])=>[cwd,sessions.map(session=>[
      session.id,session.title,session.messageCount,live.get(session.id).label,live.get(session.id).running,live.get(session.id).phase==='waiting',live.get(session.id).permission,session.unreadKnown!==false,state.unread?.isUnread(session)===true,
    ])])]);
    if(rows.dataset.fingerprint===fingerprint)return;
    const previousGroups=new Map([...rows.children].map(group=>[group.dataset.cwd,group]));
    const previousRows=new Map([...rows.querySelectorAll('.row')].map(row=>[row.dataset.scrollKey,row]));
    // Retain live buttons even when content or ordering changes during a click.
    const reconcile=(parent,children)=>{
      children.forEach((child,index)=>{if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);});
      while(parent.children.length>children.length)parent.lastElementChild.remove();
    };
    const groupLabels=new Map();
    {
      const base=cwd=>projectName(cwd)||'其他会话',counts=new Map();
      for(const cwd of groups.keys())counts.set(base(cwd),(counts.get(base(cwd))||0)+1);
      for(const cwd of groups.keys()){
        const parts=String(cwd||'').split('/').filter(Boolean);
        groupLabels.set(cwd,counts.get(base(cwd))>1&&parts.length>1?parts.slice(-2).join('/'):base(cwd));
      }
    }
    const nextGroups=[];
    for(const [cwd,sessions] of groups){
      let group=previousGroups.get(cwd);
      if(!group){
        group=document.createElement('section');group.className='workspace';group.dataset.cwd=cwd;
        const header=document.createElement('div');header.className='workspace-header';
        const panel=document.createElement('div');panel.className='workspace-content';panel.id='workspace-panel-'+(++workspacePanelId);
        const items=document.createElement('div');items.className='workspace-items';panel.appendChild(items);
        const heading = document.createElement('button');heading.type='button'; heading.className = 'workspace-title';
        heading.innerHTML = '<span class="workspace-folder" aria-hidden="true"><svg class="folder-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><svg class="folder-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></span>';
        const label = document.createElement('span'); label.className = 'workspace-label'; label.textContent = groupLabels.get(cwd);
        heading.title = cwd; heading.appendChild(label);heading.setAttribute('aria-controls',panel.id);
        const setExpanded=expanded=>{group.dataset.expanded=String(expanded);heading.setAttribute('aria-expanded',String(expanded));panel.inert=!expanded;};
        heading.addEventListener('click',()=>{const expanded=group.dataset.expanded!=='true';setExpanded(expanded);if(expanded)closedWorkspaces.delete(cwd);else closedWorkspaces.add(cwd);try{sessionStorage.setItem('clm-closed-workspaces',JSON.stringify([...closedWorkspaces]));}catch{}});
        const create=document.createElement('button');create.type='button';create.className='workspace-create';create.disabled=!cwd;create.setAttribute('aria-label','在“'+groupLabels.get(cwd)+'”中新建会话');create.title=cwd?'在 '+cwd+' 新建会话':'未提供工作目录';
        create.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M8 12h8M12 8v8"/></svg>';
        create.onclick=()=>newChat(cwd);header.append(heading,create);group.append(header,panel);
      }
      const header=group.firstElementChild,panel=group.lastElementChild,items=panel.firstElementChild,heading=header.firstElementChild;
      const expanded=recent||!closedWorkspaces.has(cwd);
      if(group.dataset.expanded!==String(expanded)){group.dataset.expanded=String(expanded);heading.setAttribute('aria-expanded',String(expanded));panel.inert=!expanded;}
      header.hidden=recent;
      const nextRows=[];
      for(const session of sessions){
        const key='session:'+session.id;
        let row=previousRows.get(key);
        if(!row){
          row=document.createElement('button');row.type='button';row.className='row';row.dataset.scrollKey=key;
          const slot=document.createElement('span');slot.className='row-status';
          const dot=document.createElement('span');dot.className='dot';slot.append(dot);
          const name=document.createElement('span');name.className='name';
          const time=document.createElement('time');time.className='time';row.append(slot,name,time);
          const id=session.id;
          row.addEventListener('click',()=>{const current=state.sessions.find(item=>item.id===id);if(current)openSession(current);});
        }
        const slot=row.firstElementChild,dot=slot.firstElementChild,name=row.children[1],time=row.lastElementChild,status=live.get(session.id);
        const title=session.title+' · '+session.messageCount+' 条',label=status.label,known=session.unreadKnown!==false,unread=state.unread?.isUnread(session)===true;
        // Attention > running > native unread. Keep the last authoritative unread
        // value through an unknown read; stopping a spinner must not mark it read.
        if(known)row.dataset.unread=String(unread);
        const waiting=status.phase==='waiting',visible=waiting||status.running||row.dataset.unread==='true';
        const indicator=waiting?'waiting-indicator':status.running?'spark':'dot';
        const description=waiting?(status.permission?'等待你在电脑端确认':'等待继续'):status.running?'任务进行中':'未读回复';
        if(row.title!==title)row.title=title;
        if(name.textContent!==session.title)name.textContent=session.title;
        if(time.textContent!==label)time.textContent=label;
        if(dot.className!==indicator)dot.className=indicator;
        const mark=waiting?(status.permission?'!':'–'):'';if(dot.textContent!==mark)dot.textContent=mark;
        dot.title=visible?description:'';
        if(dot.style.visibility!==(visible?'visible':'hidden'))dot.style.visibility=visible?'visible':'hidden';
        slot.setAttribute('aria-hidden',String(!visible));
        if(visible){slot.setAttribute('role','img');slot.setAttribute('aria-label',description);}
        else{slot.removeAttribute('role');slot.removeAttribute('aria-label');}
        nextRows.push(row);
      }
      reconcile(items,nextRows);nextGroups.push(group);
    }
    reconcile(rows,nextGroups);rows.dataset.listView=state.listView;rows.dataset.fingerprint=fingerprint;listView.scrollTop=scrollTop;state.navigation?.restore();
  }

  function syncPlanExpansion(){$('planDetails').dataset.expanded=String(state.planOpen);$('planDetails').inert=!state.planOpen;$('planChip').setAttribute('aria-expanded',String(state.planOpen));$('planChip').setAttribute('aria-controls','planDetails');}
  let planSignature='';
  function planStatus(value){
    return value==='done'||value==='completed'||value==='complete'?'done'
      :value==='in_progress'||value==='in-progress'||value==='inProgress'||value==='running'?'in_progress'
      :'pending';
  }
  function renderPlan(items){
    const signature=JSON.stringify(items||[]);state.plan=items;
    if(!items||!items.length){planSignature=signature;$('planList').replaceChildren();state.planOpen=false;syncPlanExpansion();updatePlanActivity();$('planDock').classList.add('hidden');$('planChip').classList.add('hidden');return;}
    if(signature===planSignature){updatePlanActivity();return;}planSignature=signature;
    const list=$('planList'),scroll=list.scrollTop;list.setAttribute('aria-label','任务清单');
    const normalized=items.map(item=>({...item,status:planStatus(item.status)}));
    for(let index=0;index<normalized.length;index++){
      const item=normalized[index];let row=list.children[index];if(!row){row=document.createElement('div');const icon=document.createElement('span');icon.className='ico';const text=document.createElement('span');text.className='txt';row.append(icon,text);list.append(row);}
      row.className='plan-row '+item.status;const mark=item.status==='done'?'✓':item.status==='in_progress'?'●':'○';if(row.firstChild.textContent!==mark)row.firstChild.textContent=mark;if(row.lastChild.textContent!==item.content)row.lastChild.textContent=item.content;
    }
    while(list.children.length>normalized.length)list.lastElementChild.remove();list.scrollTop=scroll;
    syncPlanExpansion();updatePlanActivity();
    $('planDock').classList.remove('hidden');$('planChip').classList.remove('hidden');
    const done=normalized.filter(item=>item.status==='done').length,progress=normalized.filter(item=>item.status==='in_progress').length;
    const active=normalized.find(item=>item.status==='in_progress')||normalized.find(item=>item.status!=='done');
    const summary=done+' 已完成 · '+progress+' 进行中 · '+(normalized.length-done-progress)+' 待处理';
    $('planLabel').textContent='任务';$('planTask').textContent=summary;
    $('planChip').title=active?.content||'全部完成';
    $('planChip').setAttribute('aria-label','任务，'+summary+(active?'，当前：'+active.content:'')+(state.planOpen?'，收起清单':'，展开清单'));
  }

  function newAssistant(container=messages){const owner=window.createClaudeAssistant({container,renderText});placeNativeRow(owner.wrap,container);assistantOwners.add(owner);return owner;}

  function addUserMessage(text, attachments, attachmentDelivery, container){
    const wrap = document.createElement('div'); wrap.className = 'msg user';
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    if(attachments && attachments.length){
      const imgs = document.createElement('div'); imgs.className = 'imgs';
      for(const item of attachments){
        if(item.placeholder){const note=document.createElement('div');note.className='image-placeholder';note.textContent='图片过大，未在手机上内联';imgs.appendChild(note);continue;}
        const img = document.createElement('img'); img.src = item.url; img.alt = item.name || '图片';
        img.tabIndex=0;img.setAttribute('role','button');img.onclick=()=>window.claudePreviewImage(item.url,item.name);img.onkeydown=event=>{if(event.key==='Enter')img.click();};
        imgs.appendChild(img);
      }
      bubble.appendChild(imgs);
    }
    if(text){
      const t=document.createElement('div');t.className='user-text';t.textContent=text;bubble.appendChild(t);
      if(text.length>280||text.split('\\n').length>7){
        t.classList.add('collapsed');const toggle=document.createElement('button');toggle.type='button';toggle.className='expand-message';toggle.textContent='展开消息';toggle.setAttribute('aria-expanded','false');
        toggle.onclick=()=>{const collapsed=t.classList.toggle('collapsed');toggle.textContent=collapsed?'展开消息':'收起消息';toggle.setAttribute('aria-expanded',String(!collapsed));};bubble.appendChild(toggle);
      }
    }
    // The preview is the image receipt. Transport type is not proof of reading;
    // do not turn it into an extra “read” or native-delivery claim in the bubble.
    wrap.appendChild(bubble); (container||messages).appendChild(wrap);
    userMessageViews.set(wrap,{text:typeof text==='string'?text:'',attachments:mergeUserAttachments(attachments)});return wrap;
  }

  let followOutput=true,userScrolling=false,scrollIntentTimer;
  function userScrollIntent(){userScrolling=true;clearTimeout(scrollIntentTimer);scrollIntentTimer=setTimeout(()=>{userScrolling=false;},250);}
  for(const type of ['wheel','touchmove','pointerdown','keydown'])messages.addEventListener(type,userScrollIntent,{passive:true});
  messages.addEventListener('scroll',()=>{if(userScrolling&&hubActive&&!chatView.inert&&messages.getClientRects().length){followOutput=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;state.navigation?.capture();}},{passive:true});
  messages.addEventListener('scroll',()=>{if(!document.hidden&&!state.loading&&messages.scrollTop<=64&&state.hasOlder&&!state.loadingOlder)loadOlder();},{passive:true});
  function scrollDown(force){
    if(force)followOutput=true;
    if(!hubActive||document.hidden||chatView.inert)return;
    if(followOutput){messages.scrollTop=messages.scrollHeight;state.navigation?.capture();}
  }

  let historyAssistant = null;
  let renderingMessageId=null;
  const assistantOwners=new Set(),seenMessages=new Set(),nativeUserRows=new Map(),queuedUserRows=new Map();
  const userMessageViews=new WeakMap();
  function mergeUserAttachments(...sources){
    const merged=[];
    for(const source of sources){
      const matched=new Set();
      for(const item of Array.isArray(source)?source:[]){
        if(!item||typeof item!=='object')continue;
        const id=typeof item.id==='string'?item.id:'',url=typeof item.url==='string'?item.url:typeof item.preview==='string'?item.preview:'';
        const index=merged.findIndex((old,i)=>!matched.has(i)&&(id&&old.id?id===old.id:Boolean(url&&url===old.url)));
        const previous=index<0?null:merged[index];
        const next={id:id||previous?.id||'',url:url||previous?.url||'',name:item.name||previous?.name||'图片',placeholder:!url&&!previous?.url&&(item.placeholder===true||previous?.placeholder===true)};
        if(index<0){matched.add(merged.length);merged.push(next);}else{matched.add(index);merged[index]=next;}
      }
    }
    return merged;
  }
  function syncUserMessage(row,message={},request=null){
    if(!row)return;
    const previous=userMessageViews.get(row);
    const text=typeof message.text==='string'?message.text:previous?.text??request?.text??'';
    // A file-reference echo can precede attachment enrichment. Empty/partial
    // arrays are not deletion receipts. Only an O/N-bound request may contribute
    // optimistic images; never borrow them from another row with matching text.
    const attachments=mergeUserAttachments(request?.attachments,previous?.attachments,message.attachments);
    if(previous?.text===text&&JSON.stringify(previous.attachments)===JSON.stringify(attachments))return;
    const holder=document.createElement('div'),next=addUserMessage(text,attachments,message.attachmentDelivery,holder);
    const bubble=row.querySelector('.bubble'),nextBubble=next.querySelector('.bubble');
    const images=bubble?.querySelector('.imgs'),nextImages=nextBubble?.querySelector('.imgs');
    // Keep already-loaded images (and their open preview) stable, including when
    // a late receipt moves an optimistic image to an earlier native user row.
    const reusable=[...(images?.querySelectorAll('img')||[]),...(request?.wrap&&request.wrap!==row?request.wrap.querySelectorAll('img'):[])];
    for(const image of [...(nextImages?.querySelectorAll('img')||[])]){
      const index=reusable.findIndex(old=>old.src===image.src);if(index<0)continue;
      const old=reusable.splice(index,1)[0];old.alt=image.alt;old.onclick=image.onclick;old.onkeydown=event=>{if(event.key==='Enter')old.click();};image.replaceWith(old);
    }
    if(bubble&&previous?.text===text){
      if(nextImages){if(images)images.replaceChildren(...nextImages.childNodes);else bubble.prepend(nextImages);}
    }else if(bubble)bubble.replaceChildren(...nextBubble.childNodes);
    else if(nextBubble)row.prepend(nextBubble);
    userMessageViews.set(row,{text,attachments});
  }
  function setQueuedUserRow(row,queued){
    if(!row)return;
    if(row.dataset){if(queued){row.dataset.queued='true';delete row.dataset.nativeMessageId;}else delete row.dataset.queued;}
    let label=row.querySelector('.queued-status');
    if(queued&&!label){label=document.createElement('div');label.className='queued-status';label.textContent='排队中';label.setAttribute('role','status');row.append(label);}
    else if(!queued)label?.remove();
  }
  function placeNativeRow(row,container){
    if(!row||!container)return;
    // Queued desktop inputs and unobserved local sends stay below the confirmed
    // timeline, including when the first assistant chunk arrives after the queue.
    const pending=[...container.children].find(child=>child!==row&&(child.dataset?.queued==='true'||child.dataset?.requestId&&!child.dataset.nativeMessageId));
    if(pending)container.insertBefore(row,pending);
    else if(row.parentNode!==container||container.lastElementChild!==row)container.appendChild(row);
  }
  function requestForNativeMessage(message){
    const id=message.id||message.nativeMessageId;
    if(!id||(message.nativeMessageId&&message.nativeMessageId!==id))return null;
    const request=message.requestId?deliveryCommands.get(message.requestId):deliveryCommands.get(id)||[...deliveryCommands.values()].find(item=>item.nativeMessageId===id&&(!item.sessionId||item.sessionId===state.sessionId));
    if(!request||(request.nativeMessageId&&request.nativeMessageId!==id)||(request.sessionId&&state.sessionId&&request.sessionId!==state.sessionId))return null;
    request.nativeMessageId=id;
    if(state.sessionId)request.sessionId=state.sessionId;
    if(message.attachmentDelivery)request.attachmentDelivery=message.attachmentDelivery;
    return request;
  }
  function reconcileDeliveryRow(request){
    if(!requestInView(request))return;
    const native=nativeUserRows.get(request.nativeMessageId),row=native||queuedUserRows.get(request.nativeMessageId);
    if(!row)return;
    syncUserMessage(row,{},request);
    if(request.wrap&&request.wrap!==row)request.wrap.remove();
    request.wrap=row;request.nativeObserved=Boolean(native);
    if(row.dataset)row.dataset.requestId=request.requestId;
    renderDelivery(request);setQueuedUserRow(row,!native);
  }
  function appendMessage(message,target){
    const container=target||(typeof messages!=='undefined'?messages:null);
    if(message.role==='user'){
      const id=message.id||message.nativeMessageId,request=requestForNativeMessage(message);
      if(message.queued===true){
        // A queue is visible input, not a consumed user turn. Replayed queue
        // records cannot downgrade a user that has already become formal.
        if(id&&nativeUserRows.has(id))return;
        let row=queuedUserRows.get(id)|| (request?.wrap?.isConnected?request.wrap:null);
        if(!row)row=addUserMessage(message.text,message.attachments||[],message.attachmentDelivery,container);
        syncUserMessage(row,message,request);setQueuedUserRow(row,true);
        if(row?.dataset){row.dataset.scrollKey='user:'+(id||'anonymous');if(request)row.dataset.requestId=request.requestId;}
        if(row&&row.parentNode!==container)container.appendChild(row);
        if(id)queuedUserRows.set(id,row);
        if(request){if(request.wrap&&request.wrap!==row)request.wrap.remove();request.wrap=row;request.nativeObserved=false;renderDelivery(request);persistCommands();}
        return;
      }
      if(id&&nativeUserRows.has(id)){
        syncUserMessage(nativeUserRows.get(id),message,request);
        if(request){reconcileDeliveryRow(request);persistCommands();}
        return;
      }
      // Only the formal user record commits the boundary. Its stable source UUID
      // promotes the queued row in place; never infer this from equal text.
      historyAssistant=null;renderingMessageId=id||'anonymous';
      let row=queuedUserRows.get(id)|| (request?.wrap?.isConnected?request.wrap:null);
      if(!row)row=addUserMessage(message.text,message.attachments||[],message.attachmentDelivery,container);
      syncUserMessage(row,message,request);setQueuedUserRow(row,false);
      if(row?.dataset){row.dataset.scrollKey='user:'+renderingMessageId;row.dataset.nativeMessageId=id||'';if(request)row.dataset.requestId=request.requestId;}
      placeNativeRow(row,container);
      if(id){queuedUserRows.delete(id);nativeUserRows.set(id,row);seenMessages.add(id);}
      if(request){if(request.wrap&&request.wrap!==row)request.wrap.remove();request.wrap=row;request.nativeObserved=true;renderDelivery(request);persistCommands();}
      return;
    }
    if(message.id&&seenMessages.has(message.id))return;
    renderingMessageId=message.id||'anonymous';
    const box = historyAssistant || (historyAssistant = newAssistant(container));
    if(box.wrap.dataset&&!box.wrap.dataset.scrollKey)box.wrap.dataset.scrollKey='assistant:'+renderingMessageId;
    const tools=new Map((message.tools||[]).map(tool=>[tool.id,tool]));
    const blocks=message.blocks||[...(message.thinking?[{type:'thinking',text:message.thinking}]:[]),...(message.tools||[]).map(tool=>({type:'tool',id:tool.id})),...(message.text?[{type:'text',text:message.text}]:[])];
    for(const block of blocks){
      if(block.type==='thinking')box.appendThinking(block.text,message.id);
      else if(block.type==='tool'){const tool=tools.get(block.id);if(tool){box.addTool(tool.id,tool.name,tool.detail);if(tool.result!==null&&tool.result!==undefined)box.toolResult(tool.id,tool.result,tool.isError);}}
      else if(block.type==='text')box.appendText(block.text,message.id);
    }
    box.thinkDone();if(message.terminal)box.finish(message.interrupted?'interrupted':'complete');
    box.removeIfEmpty();
    if(message.id)seenMessages.add(message.id);
  }

  function nativeReadVisible(id,version,marker){
    // Initial restoration is covered by the parent too, not only soft refresh.
    if(typeof parent!=='undefined'&&typeof window!=='undefined'&&parent!==window){
      try{if(parent.document?.getElementById('loading')?.classList.contains('hidden')===false)return false;}catch{return false;}
    }
    return state.sessionId===id&&state.viewVersion===version&&state.nativeReadMarker===marker&&hubActive&&!state.hubRefreshing&&!document.hidden&&!chatView.inert&&!composer.inert&&!chatView.classList.contains('hidden')&&chatView.getClientRects().length>0&&$('optionsMenu').classList.contains('hidden');
  }
  function acknowledgeRead(value,fullHistory=false){
    const marker=value.readMarker,id=state.sessionId,version=state.viewVersion;
    state.nativeReadMarker=marker;
    if(!state.unread||marker?.id!==id)return;
    const key='native-read:'+id;
    const current=()=>state.sessionId===id&&state.viewVersion===version&&state.nativeReadMarker===marker;
    const options={fullHistory,isVisible:()=>nativeReadVisible(id,version,marker),refresh:poll,
      onStatus:(text,retry)=>{if(current())state.readStatus?.(key,text,retry,()=>nativeReadVisible(id,version,marker));},
      onVerified:()=>refreshSessions(),
    };
    // Read failures are independent of transcript loading and never clear a dot.
    try{Promise.resolve(state.unread.acknowledge(marker,seenMessages,value,options)).catch(()=>{if(current())state.readStatus?.(key,'原生已读同步失败，结果尚未确认。',poll,()=>nativeReadVisible(id,version,marker));});}
    catch{if(current())state.readStatus?.(key,'原生已读同步失败，结果尚未确认。',poll,()=>nativeReadVisible(id,version,marker));}
  }

  let pollController=null;
  function updateTranscriptCursor(value){
    if(!Number.isFinite(value.cursor))return;
    state.since=value.cursor;state.cursorAnchor=typeof value.anchor==='string'?value.anchor:null;
  }
  function stopPoll(){
    pollController?.abort();pollController=null;state.polling=false;
    if(state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  function startPoll(){
    if(!state.sessionId||!hubActive||document.hidden||state.pollTimer)return;
    state.pollTimer=setInterval(poll,2500);
  }
  async function poll(){
    // Sending never blocks native reads. User rows are reconciled by O/N in the
    // same append path as full history; text equality is not delivery evidence.
    if(!hubActive || document.hidden || !state.sessionId) return;
    if(state.loading)return state.sessionCompletion;
    const id = state.sessionId, version=state.viewVersion;
    if(state.polling)return state.pollCompletion;
    state.chatLoadError=false;
    state.polling=true;const controller=new AbortController();pollController=controller;
    // A capsule tap can join the active read instead of spawning/aborting it.
    let finishRead;
    const completion=state.pollCompletion=new Promise(resolve=>{finishRead=resolve;});
    let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    try{
      const value=await Promise.race([(async()=>{
        const query='?since='+state.since+(typeof state.cursorAnchor==='string'?'&anchor='+encodeURIComponent(state.cursorAnchor):'');
        const response=await fetch('/claude/api/session/'+encodeURIComponent(id)+query,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        if(!response.ok)throw Error('HTTP '+response.status);return response.json();
      })(),timeout]);
      if(state.sessionId!==id || version!==state.viewVersion || controller.signal.aborted) return;
      state.readStatus?.('poll');state.navigation?.capture();applyControl(value.control);
      let changed=false;
      if(value.plan!==undefined){
        const signature=JSON.stringify(value.plan??null);
        if(signature!==JSON.stringify(state.plan??null)){renderPlan(value.plan??null);changed=true;}
      }
      for(const update of value.toolUpdates||[]){
        for(const owner of assistantOwners)if(owner.toolMap.has(update.id)){owner.toolResult(update.id,update.text,update.isError);changed=true;}
      }
      if(value.reset){
        // 桌面重写了会话文件（行号重新开始），增量游标已失效：整段重载。
        state.since=0;state.cursorAnchor=null;
        return await finallyReloadSession({id:state.sessionId,cwd:state.cwd,title:title.textContent});
      }
      if(value.sinceTruncated){
        // More than 400 messages arrived between polls: a delta would drop the middle.
        state.since=0;state.cursorAnchor=null;
        const target={id:state.sessionId,cwd:state.cwd,title:title.textContent};
        return await finallyReloadSession(target);
      }
      if(value.messages.length){
        for(const message of value.messages)appendMessage(message);
        scrollDown();changed=true;
      }
      // Idle polls must not rewrite scrollTop; it interrupts an in-progress drag.
      if(changed&&state.navigation?.has())state.navigation.restore();
      const atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<=80;
      // A poll is a delta, never full history: only the bottom position decides when to acknowledge.
      if(state.unread&&(state.since===0||atBottom))acknowledgeRead(value,false);
      // Commit the native sequence and its prefix digest only after the whole response.
      updateTranscriptCursor(value);
    }catch(error){
      if(pollController===controller&&state.sessionId===id&&version===state.viewVersion&&(timedOut||!controller.signal.aborted)){state.chatLoadError=true;invalidateRuntime(state.control);state.readStatus?.('poll',timedOut?'对话更新超时，已保留当前内容。':'暂时无法更新对话，已保留当前内容。',poll,()=>state.sessionId===id);}
    }finally{
      clearTimeout(timer);finishRead();
      if(state.pollCompletion===completion)state.pollCompletion=null;
      if(pollController===controller){pollController=null;state.polling=false;}
    }
  }

  let reloadTarget=null;
  async function finallyReloadSession(session){
    const version=state.viewVersion;reloadTarget=session;
    await Promise.resolve();
    if(reloadTarget!==session)return;reloadTarget=null;
    if(version===state.viewVersion&&state.sessionId===session.id)await openSession(session);
  }
  async function openSession(session){
    state.navigation?.capture();
    rememberView({kind:'chat',id:session.id,cwd:session.cwd,title:session.title});closeMenu();saveDraft();
    state.sessionController?.abort();const controller=new AbortController();state.sessionController=controller;
    const version=++state.viewVersion; state.loading=true;resetHistoryPaging();
    state.chatLoadError=false;
    let finishSession;
    const completion=state.sessionCompletion=new Promise(resolve=>{finishSession=resolve;});
    state.sessionId = session.id;
    state.deliveryViewId = null;restoreDraft(session.id);updateSendState();
    state.readStatus?.('poll');state.readStatus?.render();
    state.cwd = session.cwd;state.control=null;setWaitingStatus(null);state.actualModel=null;state.actualModelLabel=null;state.mode=null;updateChips();
    state.running = Boolean(session.running);
    state.since = 0;state.cursorAnchor=null;
    $('back').hidden = false;
    title.textContent = session.title;
    listView.classList.add('hidden');
    chatView.classList.remove('hidden');
    composer.classList.remove('hidden');
    messages.textContent = ''; historyAssistant = null; assistantOwners.clear(); seenMessages.clear();nativeUserRows.clear();queuedUserRows.clear();
    messages.scrollTop = 0;
    const loading=document.createElement('div');loading.className='waiting-status';loading.setAttribute('role','status');loading.textContent='正在加载…';messages.append(loading);
    renderPlan(null);
    stopPoll();
    let timer,timedOut=false,rendering=false;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},20000);});
    try{
      const {response,value}=await Promise.race([(async()=>{const response=await fetch('/claude/api/session/'+encodeURIComponent(session.id),{cache:'no-store',credentials:'same-origin',signal:controller.signal});const value=await response.json();return {response,value};})(),timeout]);
      if(version!==state.viewVersion) return;
      if(!response.ok) throw new Error(value.error || '读取失败');
      rendering=true;loading.remove();
      applyControl(value.control);renderPlan(value.plan || null);
      for(const message of value.messages)appendMessage(message);
      // Restoring an older reading position must not clear the unread dot for a reply below the fold.
      if(state.unread&&!state.navigation?.has())acknowledgeRead(value,true);
      state.before=Number.isFinite(value.before)?value.before:(value.messages?.[0]?.seq??null);
      state.hasOlder=value.hasMore===true;
      updateHistoryTop();
      restorePendingMessages();
      updateTranscriptCursor(value);
      state.chatLoadedSessionId=session.id;
      startPoll();
    }catch(e){
      if(version!==state.viewVersion) return;
      state.chatLoadError=true;
      loading.remove();
      errorLine(timedOut||e.name==='AbortError'?'会话加载超时，请重试。':rendering?'消息显示失败，请重试。':'暂时无法加载会话，请检查电脑端连接后重试。',()=>openSession(session),true);
    }finally{
      clearTimeout(timer);if(state.sessionController===controller)state.sessionController=null;
      if(version===state.viewVersion){state.loading=false;if(state.navigation?.has())state.navigation.restore();else{state.navigation?.resetFollow();scrollDown(true);state.navigation?.capture();}updateSendState();}
      finishSession();if(state.sessionCompletion===completion)state.sessionCompletion=null;
    }
  }

  function newChat(cwd=null,restored=null){
    state.navigation?.capture();
    const key=restored?.scope||'new:'+(cwd||''),viewId=restored?.viewId||crypto.randomUUID();
    rememberView({kind:'new',cwd,scope:key,viewId});closeMenu();saveDraft();
    state.sessionController?.abort();state.viewVersion++; state.loading=false;resetHistoryPaging();
    stopPoll();
    state.sessionId = null;state.since=0;state.cursorAnchor=null;state.control=null;setWaitingStatus(null);
    state.deliveryViewId = viewId;state.control=null;state.mode=state.defaultMode||'bypassPermissions';state.actualModelLabel=null;state.actualModel=null;
    restoreDraft(key);saveDraft(!restored);
    state.cwd = cwd;state.since=0;state.readStatus?.('poll');state.readStatus?.render();
    state.running = false;
    $('back').hidden = false;
    title.textContent = cwd?'新会话 · '+projectName(cwd):'新会话';title.title=cwd||'';
    listView.classList.add('hidden');
    chatView.classList.remove('hidden');
    composer.classList.remove('hidden');
    messages.textContent = ''; historyAssistant = null; assistantOwners.clear(); seenMessages.clear();nativeUserRows.clear();queuedUserRows.clear();
    renderPlan(null);
    restorePendingMessages();
    state.navigation?.resetFollow();state.navigation?.restore();afterComposerVisible();updateSendState();updateChips();input.focus({preventScroll:true});
  }

  function errorLine(text, retry, home=false){
    const line = document.createElement('div'); line.className = home?'err recovery-error':'err';
    const span = document.createElement('span'); span.textContent = text;
    line.appendChild(span);
    if(home){const button=document.createElement('button');button.type='button';button.textContent='返回首页';button.dataset.secondary='true';button.addEventListener('click',()=>{void showList();});line.appendChild(button);}
    if(retry){
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '重试';
      button.addEventListener('click', () => { line.remove(); retry(); });
      line.appendChild(button);
    }
    messages.appendChild(line); scrollDown();
  }

  const deliveryCommands=new Map();
  const pendingStorage='clm-pending-desktop-commands-v1';
  function persistCommands(){
    try{
      // Never evict an uncertain operation. Accepted operations retain their
      // O/N association until the native row has actually been observed.
      const records=[...deliveryCommands.values()].filter(r=>r.state!=='rejected'&&(r.state!=='accepted'||!r.nativeObserved)).map(r=>({requestId:r.requestId,nativeMessageId:r.nativeMessageId||null,nativeObserved:Boolean(r.nativeObserved),sessionId:r.sessionId,scope:r.scope,viewId:r.viewId,draftRevision:r.draftRevision,text:r.text,cwd:r.cwd,attachments:(r.attachments||[]).map(a=>({id:a.id,name:a.name,url:a.url})),attachmentDelivery:r.attachmentDelivery,state:r.state,notDispatched:r.notDispatched,transport:r.transport,queueMode:r.queueMode,model:r.model,permissionMode:r.permissionMode,priority:r.priority,createdAt:r.createdAt}));
      localStorage.setItem(pendingStorage,JSON.stringify(records));return true;
    }catch{return false;}
  }
  function requestInView(request){
    if(!draftKey||!listView.classList.contains('hidden'))return false;
    return state.sessionId?request.sessionId===state.sessionId:request.scope===draftKey&&Boolean(request.viewId)&&request.viewId===state.deliveryViewId;
  }
  function matchingDraft(value,request){return Boolean(request.draftRevision&&value?.revision===request.draftRevision&&(!value.viewId||!request.viewId||value.viewId===request.viewId));}
  function clearMatchingDrafts(request){
    for(const key of new Set([request.scope,request.key,request.sessionId])){
      if(key&&matchingDraft(drafts.get(key),request))drafts.delete(key);
    }
    persistDrafts();
  }
  function pendingSame(){
    // Same submission revision, not same text. Legacy uncertain records without
    // a revision must be resolved before the old composer can be submitted.
    return [...deliveryCommands.values()].find(r=>!['accepted','rejected'].includes(r.state)&&requestInView(r)&&(!r.draftRevision||r.draftRevision===state.draftRevision));
  }
  function unboundRequest(){return state.sessionId?null:[...deliveryCommands.values()].find(r=>requestInView(r)&&!(r.state==='rejected'&&r.notDispatched));}
  function bindDeliverySession(request){
    if(!request.sessionId||!requestInView(request))return false;
    if(!state.sessionId){
      saveDraft();const previousKey=draftKey;
      state.sessionId=request.sessionId;draftKey=request.sessionId;
      if(drafts.get(previousKey)?.viewId===state.deliveryViewId)drafts.delete(previousKey);
      title.textContent=request.text.slice(0,72);saveDraft();
    }
    request.key=request.sessionId;
    rememberView({kind:'chat',id:request.sessionId,cwd:request.cwd,title:title.textContent});
    state.readStatus?.('session-binding');return true;
  }
  function renderDelivery(request){
    if(!request.wrap?.isConnected)return;
    request.wrap.querySelectorAll?.('.attachment-delivery').forEach(node=>node.remove());
    let label=request.wrap.querySelector('.message-delivery');if(!label){label=document.createElement('div');label.className='message-delivery';request.wrap.append(label);}
    label.replaceChildren();label.classList.toggle('failed',request.state==='rejected');
    if(request.state==='accepted'){label.remove();return;}
    if(request.state==='rejected'){
      const text=document.createElement('span');text.textContent=(request.error||'发送失败，请检查电脑端连接。')+' 草稿已保留。';label.append(text);
      if(!request.notDispatched)return;
      const version=state.viewVersion;
      const action=document.createElement('button');action.type='button';action.textContent='重试';action.onclick=()=>{
        if(state.sending||version!==state.viewVersion||!requestInView(request)||request.state!=='rejected'||!request.notDispatched)return;
        send(request.text,{attachments:request.attachments,preserveDraft:true,draftRevision:request.draftRevision,sessionId:request.sessionId,cwd:request.cwd,model:request.model,permissionMode:request.permissionMode,priority:request.priority,viewVersion:version,retryOf:request});
      };label.append(action);
      return;
    }
    if(request.state==='unknown'){
      const text=document.createElement('span');text.textContent='还没收到发送结果，请查询';label.append(text);
      const version=state.viewVersion;
      const action=document.createElement('button');action.type='button';action.textContent='查询状态';action.onclick=async()=>{
        if(version!==state.viewVersion||!requestInView(request))return;
        action.disabled=true;
        try{await checkDelivery(request);}finally{if(action.isConnected)action.disabled=false;}
      };label.append(action);
      return;
    }
    if(request.state==='prepared'){
      const text=document.createElement('span');text.textContent='正在连接电脑会话…';label.append(text);
      return;
    }
    // dispatched/waiting is a normal state while a long desktop turn finishes.
    // The phone keeps polling; do not make the user chase it with a button.
    label.remove();
  }
  const runtimeSnapshots=new WeakMap();
  function observeRuntime(source,refresh=false){
    if(!source||typeof source!=='object')return null;
    let observed=runtimeSnapshots.get(source);
    if(!observed||refresh||observed.serverNowMs!==source.runtime?.serverNowMs){observed={at:performance.now(),serverNowMs:source.runtime?.serverNowMs,failed:false};runtimeSnapshots.set(source,observed);}
    return observed;
  }
  function runtimeStatus(source){
    const observed=observeRuntime(source),runtime=source?.runtime;
    const age=observed?performance.now()-observed.at:Infinity;
    const fresh=Boolean(observed&&!observed.failed&&age>=0&&age<15000);
    const permission=fresh&&source?.waitingFor==='permission prompt';
    const known=fresh&&runtime?.known===true;
    const phase=permission?'waiting':known&&['running','idle','waiting'].includes(runtime.phase)?runtime.phase:'unknown';
    const running=known&&phase==='running'&&runtime.running===true&&source.running!==false;
    let seconds=null;
    // Only engine turn timestamps are clocks. Monotonic receipt age + serverNow
    // avoids the phone's timezone/wall-clock skew and never invents a start.
    if(known&&(running||phase==='waiting')&&Number.isFinite(runtime.startedAtMs)&&Number.isFinite(runtime.serverNowMs)&&runtime.startedAtMs<=runtime.serverNowMs){seconds=Math.floor((runtime.serverNowMs+age-runtime.startedAtMs)/1000);}
    else if(known&&phase==='idle'){
      const duration=Number.isFinite(runtime.durationMs)?runtime.durationMs:Number.isFinite(runtime.startedAtMs)&&Number.isFinite(runtime.endedAtMs)?runtime.endedAtMs-runtime.startedAtMs:null;
      if(Number.isFinite(duration)&&duration>=0)seconds=Math.floor(duration/1000);
    }
    return {available:Boolean(source),phase,known:known||permission,running,permission,seconds,stale:!fresh,disconnected:fresh&&source?.nativeInputReady===false};
  }
  function invalidateRuntime(source){const observed=observeRuntime(source);if(observed)observed.failed=true;setWaitingStatus(state.control);updatePlanActivity();}
  function formatRuntime(seconds){return seconds<60?seconds+'秒':Math.floor(seconds/60)+'分'+seconds%60+'秒';}
  function setWaitingStatus(control){
    const box=$('waitingStatus');if(!box)return;
    const runtime=runtimeStatus(control);
    const observed=runtime.running||runtime.phase==='waiting'||runtime.phase==='idle'&&runtime.seconds!==null;
    const disconnected=runtime.disconnected&&!observed;
    const visible=Boolean(state.sessionId&&(observed||disconnected)&&!chatView.classList.contains('hidden'));
    box.classList.remove('waiting-status');box.classList.add('session-status');box.classList.toggle('hidden',!visible);
    box.dataset.phase=visible?(disconnected?'disconnected':runtime.phase):'unknown';
    // No clock/phase is not “running” or “finished”. Read failures already have
    // a retry above the conversation; don't leave a second vague status below it.
    if(!visible){box.replaceChildren();return;}
    let text=box.querySelector('.runtime-text');
    if(!text){
      text=document.createElement('span');text.className='runtime-text';
      const label=document.createElement('span');label.className='runtime-label';label.setAttribute('aria-live','polite');
      const duration=document.createElement('time');duration.className='runtime-duration';duration.setAttribute('aria-live','off');text.append(label,duration);box.append(text);
      box.setAttribute('aria-live','off');
    }
    let icon=box.querySelector('.runtime-icon');
    if(runtime.running&&!icon){icon=document.createElement('i');icon.className='spark runtime-icon';icon.setAttribute('aria-hidden','true');box.prepend(icon);}
    else if(!runtime.running)icon?.remove();
    const pending=runtime.permission?accountPendingTool():null;
    const label=runtime.permission?'等待你在电脑端确认':runtime.running?'进行中':runtime.phase==='waiting'?'等待继续':disconnected?'电脑端未连接':'本轮已结束';
    const labelNode=text.querySelector('.runtime-label'),duration=text.querySelector('.runtime-duration');
    if(labelNode.textContent!==label)labelNode.textContent=label;
    labelNode.title=runtime.permission?(pending?'请在 Claude 电脑端确认：'+pending:'请在 Claude 电脑端确认后继续'):disconnected?'请打开电脑端此会话后重试':'';
    const elapsed=runtime.seconds===null?'':' · '+formatRuntime(runtime.seconds);
    if(duration.textContent!==elapsed)duration.textContent=elapsed;
    duration.hidden=runtime.seconds===null;
    if(runtime.seconds!==null)duration.setAttribute('datetime','PT'+runtime.seconds+'S');else duration.removeAttribute('datetime');
    let retry=box.querySelector('.runtime-retry');
    if(disconnected&&!retry){
      retry=document.createElement('button');retry.type='button';retry.className='runtime-retry';retry.textContent='重试';
      retry.onclick=async()=>{const id=state.sessionId,version=state.viewVersion;retry.disabled=true;try{await poll();}finally{if(retry.isConnected&&state.sessionId===id&&state.viewVersion===version)retry.disabled=false;}};box.append(retry);
    }else if(!disconnected)retry?.remove();
  }
  function updatePlanActivity(){
    const list=$('planList'),chip=$('planChip');if(!list||!chip)return;
    const runtime=runtimeStatus(state.control);let active=false;
    for(const row of list.children){
      const progressing=row.classList.contains('in_progress'),spinning=progressing&&runtime.running,icon=row.firstElementChild;
      active=active||progressing;icon.classList.toggle('typing',spinning);
      if(spinning){
        if(!icon.querySelector('.spark')){const spinner=document.createElement('span');spinner.className='spark';spinner.setAttribute('aria-hidden','true');icon.replaceChildren(spinner);}
      }else{
        const mark=row.classList.contains('done')?'✓':progressing?'●':'○';if(icon.textContent!==mark)icon.textContent=mark;
      }
    }
    const spinning=active&&runtime.running,original=chip.querySelector('svg');original?.classList.toggle('hidden',spinning);
    let indicator=chip.querySelector('.plan-running');
    if(spinning&&!indicator){indicator=document.createElement('span');indicator.className='spark plan-running';indicator.setAttribute('aria-hidden','true');chip.prepend(indicator);}
    else if(!spinning)indicator?.remove();
  }
  function tickRuntime(){
    if(!hubActive||document.hidden)return;
    setWaitingStatus(state.control);updatePlanActivity();
    if(!listView.classList.contains('hidden'))renderSessions();
  }
  function accountPendingTool(){
    const owners=[...assistantOwners];
    for(let index=owners.length-1;index>=0;index--){
      const toolMap=owners[index]?.toolMap;if(!toolMap)continue;
      for(const tool of toolMap.values())if(tool&&tool.result==null&&tool.name)return tool.name;
      break;
    }
    return null;
  }
  function applyControl(control){
    if(!control)return;state.control=control;state.running=Boolean(control.running);observeRuntime(control,true);
    setWaitingStatus(control);updatePlanActivity();
    state.mode=control.permissionMode||null;
    state.actualModel=control.actualModel||control.model||null;
    if(control.selectedModel)state.model=control.selectedModel;
    state.actualModelLabel=control.modelLabel||null;
    updateChips();updateSendState();
  }
  function receiveDelivery(request,value){
    if(value?.requestId!==request.requestId)return false;
    const transport=value.transport||request.transport;
    const nativeId=value.nativeMessageId||(value.messageId&&value.messageId!==request.requestId?value.messageId:null)||request.nativeMessageId||(transport!=='native-user-v1'?value.messageId:null);
    if((value.sessionId&&request.sessionId&&value.sessionId!==request.sessionId)||(nativeId&&typeof nativeId!=='string')||(nativeId&&request.nativeMessageId&&nativeId!==request.nativeMessageId))return false;
    const previous=request.state;
    let next=['prepared','dispatched','accepted','rejected','unknown'].includes(value.state)?value.state:'unknown';
    if(next==='rejected'&&(value.notDispatched!==true||request.nativeObserved))next='unknown';
    if(next==='accepted'&&(!(value.sessionId||request.sessionId)||(transport==='native-user-v1'&&!nativeId)))next='unknown';
    if(previous==='accepted'||(previous==='rejected'&&request.notDispatched&&next!=='accepted'))next=previous;
    if(previous==='dispatched'&&next==='prepared')next=previous;
    request.state=next;request.error=next==='accepted'?null:value.error||null;
    request.notDispatched=next==='rejected'&&(request.notDispatched||value.notDispatched===true);
    if(nativeId)request.nativeMessageId=nativeId;
    if(transport)request.transport=transport;
    if(value.queueMode)request.queueMode=value.queueMode;
    if(value.attachmentDelivery)request.attachmentDelivery=value.attachmentDelivery;
    if(value.sessionId)request.sessionId=value.sessionId;
    const current=requestInView(request);
    if(current)saveDraft();
    if(['accepted','rejected'].includes(next)){state.readStatus?.('delivery:'+request.requestId);request.nextCheckAt=0;request.checkDelay=0;}
    if(next==='accepted'||next==='dispatched'){
      const clearInput=current&&matchingDraft({revision:state.draftRevision,viewId:state.deliveryViewId},request);
      clearMatchingDrafts(request);
      if(clearInput){input.value='';state.attachments=[];state.draftRevision=null;saveDraft();renderAttachments();syncInputHeight();}
    }
    if(current){
      bindDeliverySession(request);reconcileDeliveryRow(request);
      if(request.sessionId&&next!=='rejected'){
        if(value.control)applyControl(value.control);
        startPoll();poll();
      }
    }
    renderDelivery(request);persistCommands();updateSendState();
    if(previous!=='accepted'&&next==='accepted'&&!listView.classList.contains('hidden'))refreshSessions();
    return true;
  }
  async function checkDelivery(request){
    if(request.checking||['accepted','rejected'].includes(request.state))return;
    request.checking=true;const controller=new AbortController();let timer,timedOut=false;
    const key='delivery:'+request.requestId;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    try{
      const value=await Promise.race([(async()=>{
        const response=await fetch('/claude/api/command/'+encodeURIComponent(request.requestId),{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        if(!response.ok)throw Error('HTTP '+response.status);return response.json();
      })(),timeout]);
      if(value?.requestId!==request.requestId)throw Error('回执编号不匹配');
      if(!['accepted','rejected'].includes(request.state)&&!receiveDelivery(request,value))throw Error('回执目标不匹配');
      state.readStatus?.(key);
    }catch{
      state.readStatus?.(key,timedOut?'投递状态查询超时，尚未确认结果。':'暂时无法查询投递状态，尚未确认结果。',()=>checkDelivery(request),()=>requestInView(request)&&!['accepted','rejected'].includes(request.state));
    }finally{clearTimeout(timer);request.checking=false;}
  }

  function showPendingMessage(request){
    request.wrap=addUserMessage(request.text,request.attachments||[]);
    if(request.wrap?.dataset){request.wrap.dataset.requestId=request.requestId;request.wrap.dataset.scrollKey='pending:'+request.requestId;}
    renderDelivery(request);
  }
  function restorePendingMessages(){
    let bound=false;
    for(const request of deliveryCommands.values()){
      if(!requestInView(request)||request.state==='rejected')continue;
      bound=bindDeliverySession(request)||bound;
      if(request.nativeMessageId&&nativeUserRows.has(request.nativeMessageId)){reconcileDeliveryRow(request);continue;}
      if(!request.nativeObserved&&!request.wrap?.isConnected)showPendingMessage(request);
    }
    persistCommands();
    if(bound&&!state.loading){startPoll();poll();}
  }
  async function send(text,options={}){
    if(!draftKey||!listView.classList.contains('hidden')||(options.viewVersion!==undefined&&options.viewVersion!==state.viewVersion))return;
    saveDraft();updateSendState();const attachments=(options.attachments||state.attachments).map(item=>({...item}));
    if(!state.modelsLoaded){openMenu('attachment',$('attach'));return;}
    if(attachments.length&&state.capabilities?.attachments!==true){openMenu('attachment',$('attach'));return;}
    text=text.trim()||(attachments.some(a=>a.id)?'请查看这张图片。':'');if(!text)return;
    const prior=unboundRequest()||(!options.retryOf&&pendingSame());
    if(prior){
      if(!state.sessionId)state.readStatus?.('session-binding','首条消息的会话尚未确认，草稿已保留。',()=>checkDelivery(prior),()=>unboundRequest()===prior);
      checkDelivery(prior);return;
    }
    if(state.sending||state.loading||attachments.some(a=>a.uploading||a.failed))return;

    const sessionId=Object.hasOwn(options,'sessionId')?options.sessionId:state.sessionId;
    // New sessions retain the desktop gateway's default permission intent.
    const mode=sessionId?state.mode:(state.mode||state.defaultMode||'bypassPermissions');
    const request={requestId:crypto.randomUUID(),nativeMessageId:null,nativeObserved:false,transport:'native-user-v1',queueMode:'next',sessionId,scope:draftKey,key:draftKey,viewId:state.deliveryViewId,draftRevision:options.preserveDraft?options.draftRevision:state.draftRevision,text,cwd:options.cwd??state.cwd,attachments,model:options.model??state.model,permissionMode:options.permissionMode??mode,priority:options.priority??state.priority??'now',version:state.viewVersion,state:'prepared',createdAt:Date.now(),posting:true};
    deliveryCommands.set(request.requestId,request);pendingRequests.set(request.key,request);
    if(!persistCommands()){
      request.posting=false;request.state='rejected';request.notDispatched=true;request.error='无法保存发送记录，消息尚未发送。';pendingRequests.delete(request.key);
      showPendingMessage(request);updateSendState();return;
    }
    if(options.retryOf?.wrap?.isConnected)options.retryOf.wrap.remove();
    showPendingMessage(request);scrollDown(true);updateSendState();
    const payload={requestId:request.requestId,sessionId:request.sessionId,cwd:request.cwd||undefined,text,attachments:attachments.map(a=>a.id),model:request.model,permissionMode:request.permissionMode,priority:request.priority};
    const controller=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('提交超时'));},45000);});
    try{
      const value=await Promise.race([(async()=>{
        const response=await fetch('/claude/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin',signal:controller.signal});return response.json();
      })(),timeout]);
      const receipt=value?.notDispatched===true&&(!value.requestId||value.requestId===request.requestId)?{...value,requestId:request.requestId,state:'rejected'}:value;
      if(!receiveDelivery(request,receipt))throw Error('回执尚未确认');
      if(request.state==='unknown')checkDelivery(request);
    }catch{
      if(!['accepted','rejected'].includes(request.state)){request.state='unknown';renderDelivery(request);checkDelivery(request);}
      persistCommands();
    }finally{
      clearTimeout(timer);request.posting=false;
      if(pendingRequests.get(request.scope)===request)pendingRequests.delete(request.scope);
      if(pendingRequests.get(request.key)===request)pendingRequests.delete(request.key);
      updateSendState();
      if(requestInView(request)){
        startPoll();poll();
        if(request.version===state.viewVersion&&hubActive&&!chatView.inert)try{input.focus({preventScroll:true});}catch{}
      }
    }
  }
  try{for(const saved of JSON.parse(localStorage.getItem(pendingStorage)||'[]'))if(saved?.requestId&&/^[0-9a-f-]{36}$/i.test(saved.requestId))deliveryCommands.set(saved.requestId,{...saved,state:saved.state||'unknown',posting:false});}catch{}
  async function pollDeliveries(){
    if(!hubActive||document.hidden)return;
    const now=Date.now();
    for(const request of deliveryCommands.values()){
      if(request.posting||['accepted','rejected'].includes(request.state))continue;
      if(request.nextCheckAt&&now<request.nextCheckAt)continue;
      await checkDelivery(request);
      if(!['accepted','rejected'].includes(request.state)){
        request.checkDelay=Math.min((request.checkDelay||1500)*2,15000);
        request.nextCheckAt=Date.now()+request.checkDelay;
      }
    }
  }
  setInterval(pollDeliveries,1500);
  setInterval(tickRuntime,1000);
  setInterval(()=>{if(hubActive&&!document.hidden&&!state.modelsLoaded&&state.modelsError&&!state.modelsLoading)loadModels().catch(()=>{});},6000);

  function attachmentPreview(item){
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    const img = document.createElement('img'); img.src = item.url || item.preview; img.alt = item.name || '图片';
    thumb.appendChild(img);
    if(item.uploading){
      const up=document.createElement('div');up.className='up';up.textContent='上传中';thumb.append(up);
    }else if(item.failed){
      const retry=document.createElement('button');retry.type='button';retry.className='up';retry.textContent=item.file?'重试上传':'重新选择';retry.title=item.error||'上传失败';retry.setAttribute('aria-label','重新上传 '+item.name);retry.onclick=()=>uploadFile(item.file,item);thumb.append(retry);
    }
    const rm=document.createElement('button');rm.type='button';rm.className='rm';rm.textContent='×';rm.setAttribute('aria-label','移除 '+item.name);
    rm.onclick=()=>{state.attachments=state.attachments.filter(x=>x!==item);saveDraft(true);renderAttachments();};thumb.append(rm);
    return thumb;
  }
  function renderAttachments(){
    const strip = $('attachments');
    updateSendState();
    strip.textContent = '';
    if(!state.attachments.length){ strip.classList.add('hidden'); return; }
    strip.classList.remove('hidden');
    for(const item of state.attachments) strip.appendChild(attachmentPreview(item));
  }
  async function uploadFile(file,existing=null){
    if(!state.modelsLoaded||state.capabilities?.attachments!==true){openMenu('attachment',$('attach'));return;}
    if(existing&&!state.attachments.includes(existing))return;
    if(!file||typeof file.name!=='string'||!Number.isFinite(file.size)){
      if(existing){state.attachmentSelection={item:existing,key:draftKey,version:state.viewVersion};anchorFileInput();}
      return;
    }
    const item=existing||{};
    if(item.file!==file)Object.assign(item,{name:file.name,preview:URL.createObjectURL(file),file,id:undefined,url:undefined});
    if(file.size>10*1024*1024){Object.assign(item,{uploading:false,failed:true,error:'图片超过 10MB，请压缩后再发送'});if(!state.attachments.includes(item))state.attachments.push(item);saveDraft(true);renderAttachments();return;}
    Object.assign(item,{uploading:true,failed:false,error:null});if(!state.attachments.includes(item))state.attachments.push(item);saveDraft(true);renderAttachments();
    const controller=new AbortController();let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('上传超时'));},30000);});
    try{
      const value=await Promise.race([(async()=>{
        const data=await new Promise((resolve,reject)=>{
          const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取图片失败'));reader.readAsDataURL(file);
        });
        if(controller.signal.aborted)throw Error('上传已取消');
        const response=await fetch('/claude/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,data}),credentials:'same-origin',signal:controller.signal});
        const value=await response.json();if(!response.ok||!value.id)throw Error(value.error||('HTTP '+response.status));return value;
      })(),timeout]);
      Object.assign(item,{id:value.id,url:value.url,uploading:false});
    }catch(e){
      Object.assign(item,{uploading:false,failed:true,error:timedOut?'上传超时，请重试':e.message});
    }finally{clearTimeout(timer);persistDrafts();}
    if(state.attachments.includes(item))renderAttachments();
  }

  function modeText(){
    return ({bypassPermissions:'完全放行',acceptEdits:'自动接受编辑',default:'执行前确认',plan:'计划模式'})[state.mode]||'电脑端权限';
  }
  function updateChips(){
    const model = state.models.find(item => item.model === state.model);
    const fullName = model ? model.label : (state.model || '模型');
    const modelParts=(state.sessionId?(state.actualModelLabel||state.actualModel||'跟随电脑端'):fullName).split(' · ');
    $('modelLabel').textContent=modelParts[0].replace(/-joybuilder/gi,'');$('modelProvider').textContent=modelParts.slice(1).join(' · ');
    $('modelChip').title=state.sessionId?(state.actualModel||'模型跟随电脑端设置'):('实际模型由电脑端接管时决定；当前创建意图：'+fullName);
    $('modelChip').setAttribute('aria-label',state.sessionId?'电脑端模型：'+(state.actualModelLabel||state.actualModel||'尚未确认'):'新会话模型仅表示创建意图，实际由电脑端决定：'+fullName);
    const modeButton = $('modeChip');
    modeButton.title = state.sessionId?modeText():('实际权限由电脑端接管时决定；当前创建意图：'+modeText());
    modeButton.setAttribute('aria-label', state.sessionId?('权限：' + modeText()):('新会话权限仅表示创建意图，实际由电脑端决定：'+modeText()));
    modeButton.style.color = state.mode === 'bypassPermissions' ? '#c0392b' : '';
  }
  let menuAnchor=null,menuKind=null,menuVersion=0;
  function closeMenu(restoreFocus=false){
    menuVersion++;
    $('optionsMenu').classList.add('hidden');menuAnchor?.setAttribute('aria-expanded','false');
    const anchor=menuAnchor;menuAnchor=null;menuKind=null;
    if(restoreFocus&&anchor?.isConnected&&anchor.getClientRects().length)anchor.focus({preventScroll:true});
  }
  function positionMenu(){
    if(!menuAnchor||!menuAnchor.getClientRects().length){closeMenu();return;}
    const menu=$('optionsMenu'),rect=menuAnchor.getBoundingClientRect(),viewport=window.visualViewport;
    const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,visibleWidth=Math.min(innerWidth,viewport?.width||innerWidth),visibleHeight=Math.min(innerHeight,viewport?.height||innerHeight);
    const bottom=top+visibleHeight,right=left+visibleWidth;
    if(rect.bottom<top||rect.top>bottom){closeMenu();return;}
    const below=bottom-rect.bottom,above=rect.top-top;
    menu.style.minWidth=menuKind==='model'?Math.max(0,Math.min(160,visibleWidth-16))+'px':'';
    menu.style.maxWidth=(menuKind==='model'?Math.max(0,Math.min(240,visibleWidth-16)):Math.max(120,visibleWidth-16))+'px';menu.style.maxHeight=Math.max(64,Math.min(400,Math.max(above,below)-12,visibleHeight-16))+'px';
    const width=menu.offsetWidth,height=menu.offsetHeight;
    const y=(below>=height+8||below>above)?Math.min(bottom-height-8,rect.bottom+5):Math.max(top+8,rect.top-height-5);
    const label=menuKind==='model'?$('modelLabel')?.getBoundingClientRect():null;
    const x=menuKind==='model'?(label?.width?label.left:rect.left):rect.right-width;
    menu.style.left=Math.max(left+8,Math.min(right-width-8,x))+'px';menu.style.top=Math.max(top+8,y)+'px';
  }
  function openMenu(kind,anchor,keyboard=false){
    if(menuAnchor===anchor&&menuKind===kind){closeMenu();return;}
    closeMenu();menuAnchor=anchor;menuKind=kind;anchor.setAttribute('aria-haspopup','menu');anchor.setAttribute('aria-expanded','true');
    const menu=$('optionsMenu');menu.replaceChildren();menu.classList.toggle('model-menu',kind==='model');menu.setAttribute('aria-label',kind==='view'?'列表视图':kind==='model'?'选择模型':kind==='workspace'?'选择工作区':kind==='attachment'?'图片接收':'权限');
    const add=(label,selected,action)=>{const option=document.createElement('button');option.type='button';option.className='menu-option';option.setAttribute('role','menuitemradio');option.setAttribute('aria-checked',String(selected));const text=document.createElement('span');text.textContent=label;const check=document.createElement('span');check.className='check';check.textContent=selected?'✓':'';option.append(text,check);option.onclick=()=>{const restore=keyboard||menu.contains(document.activeElement);closeMenu(restore);action();};menu.append(option);return option;};
    if(kind==='view'){
      for(const [value,label] of [['project','按工作区'],['recent','最近更新']])add(label,state.listView===value,()=>{state.navigation?.capture();state.listView=value;localStorage.setItem('clm-list-view',value);renderSessions();});
    }else if(kind==='workspace'){
      const paths=[...new Set(state.sessions.map(item=>item.cwd).filter(Boolean))];
      for(const path of paths)add(projectName(path),false,()=>newChat(path));
      add('默认目录',false,()=>newChat());
      const form=document.createElement('form');form.className='workspace-path-form';
      const field=document.createElement('input');field.type='text';field.placeholder='输入其他目录的绝对路径';field.setAttribute('aria-label','新会话工作目录');field.autocomplete='off';field.spellcheck=false;
      const submit=document.createElement('button');submit.type='submit';submit.textContent='创建';form.append(field,submit);
      form.onsubmit=event=>{event.preventDefault();const path=field.value.trim();if(!path.startsWith('/')){field.setCustomValidity('请输入以 / 开头的绝对路径');field.reportValidity();return;}newChat(path);};field.oninput=()=>field.setCustomValidity('');menu.append(form);
    }else if(kind==='attachment'||((kind==='model'||kind==='mode')&&state.modelsLoaded===false)){
      const hint=document.createElement('div');hint.className='hint';hint.textContent=!state.modelsLoaded?(state.modelsError||'正在读取电脑端接收能力，请稍后再试。'):state.capabilities?.attachments===true?'图片会随消息发送，可点击预览。':'当前电脑端暂不支持接收图片，请检查连接后重试。';menu.append(hint);
      if(!state.modelsLoaded){const retry=document.createElement('button');retry.type='button';retry.className='menu-option';retry.textContent='重新加载';retry.onclick=async()=>{const version=menuVersion;retry.disabled=true;try{await loadModels();}catch{}if(version===menuVersion&&menuAnchor===anchor){closeMenu();openMenu(kind,anchor,keyboard);}};menu.append(retry);}
    }else if(state.sessionId&&(kind==='model'||kind==='mode')){
      const hint=document.createElement('div');hint.className='hint';hint.textContent=kind==='model'?'模型由电脑端会话决定，请在电脑端切换。':'权限由电脑端会话决定，请在电脑端调整。';menu.append(hint);
    }else if(kind==='model'){
      for(const item of state.models){
        const fullName=item.label||item.model;
        const label=fullName.split(' · ')[0].replace(/[-_ ]joybuilder.*$/i,'').trim()||item.model;
        const option=add(label,state.model===item.model,()=>{state.model=item.model;localStorage.setItem('clm-model',item.model);updateChips();});
        const source=fullName.split(' · ').slice(1).join(' · ');if(source){const provider=document.createElement('span');provider.className='model-source';provider.textContent=source;provider.setAttribute('aria-hidden','true');option.append(provider);option.setAttribute('aria-label',label+' · '+source);}
        option.title=fullName===item.model?fullName:fullName+' · '+item.model;
      }
    }else if(kind==='mode'){
      for(const [value,label] of [['default','执行前确认'],['acceptEdits','自动接受编辑'],['plan','计划模式'],['bypassPermissions','完全放行']])add(label,state.mode===value,()=>{state.mode=value;updateChips();});

    }
    menu.classList.remove('hidden');positionMenu();if(keyboard)menu.querySelector('.menu-option')?.focus();
  }
  document.addEventListener('pointerdown',event=>{if(menuAnchor&&!$('optionsMenu').contains(event.target)&&!menuAnchor.contains(event.target))closeMenu();},true);
  document.addEventListener('focusin',event=>{if(menuAnchor&&!$('optionsMenu').contains(event.target)&&!menuAnchor.contains(event.target))closeMenu();});
  document.addEventListener('keydown',event=>{
    if(!menuAnchor||event.defaultPrevented)return;
    if(event.key==='Escape'){event.preventDefault();closeMenu(true);return;}
    if(event.target.matches('input,textarea'))return;
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      const options=[...$('optionsMenu').querySelectorAll('.menu-option')],index=options.indexOf(document.activeElement);let next;
      if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;else next=(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
      event.preventDefault();options[next]?.focus();
    }
  });
  function viewportChanged(){document.documentElement.style.setProperty('--ui-height',Math.min(innerHeight,window.visualViewport?.height||innerHeight)+'px');if(menuAnchor)positionMenu();
    const viewport=Math.min(innerHeight,window.visualViewport?.height||innerHeight);
    if(viewport<innerHeight-120&&state.planOpen){state.planOpen=false;syncPlanExpansion();}}
  window.addEventListener('resize',viewportChanged);window.visualViewport?.addEventListener('resize',viewportChanged);window.visualViewport?.addEventListener('scroll',viewportChanged);viewportChanged();
  document.addEventListener('scroll',event=>{if(menuAnchor&&!$('optionsMenu').contains(event.target))positionMenu();},true);

  async function loadModels(){
    const request=(state.modelsRequest||0)+1;state.modelsRequest=request;
    state.modelsLoading=true;state.modelsLoaded=false;state.modelsError=null;updateSendState();
    const controller=new AbortController();let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    try{
      const value=await Promise.race([(async()=>{
        const response=await fetch('/claude/api/models',{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        if(!response.ok)throw Error('电脑端能力暂不可用');return response.json();
      })(),timeout]);
      if(request!==state.modelsRequest)return;
      state.models=Array.isArray(value.models)?value.models:[];state.capabilities=value.capabilities||{};
      // 新会话的权限跟随电脑端网关配置（默认 bypassPermissions），不在手机端另设默认值。
      if(typeof value.permissionMode==='string'){state.defaultMode=value.permissionMode;if(!state.sessionId&&!state.deliveryViewId)state.mode=value.permissionMode;}
      if(state.models.length&&!state.models.some(item=>item.model===state.model))state.model=state.models.some(item=>item.model===value.defaultModel)?value.defaultModel:state.models[0].model;
      state.modelsLoaded=true;state.readStatus?.('models');updateChips();
    }catch(error){
      if(request!==state.modelsRequest)return;
      state.modelsError=timedOut?'连接电脑端超时，请重试。':'暂时无法读取电脑端接收能力，请重试。';
      state.readStatus?.('models',state.modelsError,()=>loadModels().catch(()=>{}));throw error;
    }finally{clearTimeout(timer);if(request===state.modelsRequest){state.modelsLoading=false;updateSendState();}}
  }

  function anchorFileInput(){
    $('file').click();return true;
  }
  function attachmentAction(){
    if(state.modelsLoaded&&state.capabilities?.attachments===true){state.attachmentSelection={key:draftKey,version:state.viewVersion};anchorFileInput();}
    else openMenu('attachment',$('attach'));
  }
  async function bootstrap(){
    const saved=readRememberedView();
    if(saved?.kind==='chat'&&saved.id)openSession(saved);
    else if(saved?.kind==='new'){
      const scope=saved.scope||'new:'+(saved.cwd||''),viewId=saved.viewId||crypto.randomUUID();
      if(!saved.viewId){for(const request of deliveryCommands.values())if(request.scope===scope&&!request.viewId)request.viewId=viewId;persistCommands();}
      newChat(saved.cwd||null,{scope,viewId});
    }else showList();updateChips();loadModels().catch(()=>{});
  }

  $('back').addEventListener('click', showList);
  $('new').addEventListener('click',()=>newChat());
  for(const [id,kind] of [['workspaceView','view'],['workspaceNew','workspace'],['modelChip','model'],['modeChip','mode']]){const anchor=$(id);anchor.setAttribute('aria-haspopup','menu');anchor.setAttribute('aria-expanded','false');anchor.addEventListener('keydown',event=>{if(event.key==='ArrowDown'&&!menuAnchor){event.preventDefault();event.stopPropagation();openMenu(kind,anchor,true);}});}
  $('workspaceView').addEventListener('click',event=>openMenu('view',event.currentTarget,event.detail===0));
  $('workspaceNew').addEventListener('click',()=>openMenu('workspace',$('workspaceNew')));
  $('modelChip').addEventListener('click',event=>openMenu('model',event.currentTarget,event.detail===0));
  $('modeChip').addEventListener('click',event=>openMenu('mode',event.currentTarget,event.detail===0));
  $('planChip').addEventListener('click',()=>{state.planOpen=!state.planOpen;syncPlanExpansion();});
  $('attach').addEventListener('click', attachmentAction);
  $('file').addEventListener('change', () => {
    const selection=state.attachmentSelection,files=[...$('file').files];state.attachmentSelection=null;$('file').value='';
    if(selection&&(selection.key!==draftKey||selection.version!==state.viewVersion))return;
    files.forEach((file,index)=>uploadFile(file,index===0?selection?.item||null:null));
  });
  input.addEventListener('input',()=>{saveDraft(true);updateSendState();syncInputHeight();});
  let composing=false,compositionEnded=0;
  input.addEventListener('compositionstart',()=>{composing=true;});
  input.addEventListener('compositionend',()=>{composing=false;compositionEnded=performance.now();});
  input.addEventListener('keydown', event => {
    if(event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode!==229 && performance.now()-compositionEnded>80){ event.preventDefault(); send(input.value); }
  });
  composer.addEventListener('submit', event => { event.preventDefault();if(composing)return;send(input.value); });
  bootstrap();
})();
</script>
</body></html>`;

export const hubHtml=()=>HUB_HTML;
export const chatHtml=()=>CHAT_HTML;
