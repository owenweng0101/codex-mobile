import {readFileSync} from 'node:fs';
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
.shell{position:fixed;left:0;right:0;top:var(--app-top,0px);display:flex;flex-direction:column;height:var(--app-height,100dvh);padding-top:env(safe-area-inset-top);background:var(--surface)}
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
.notice{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center;color:var(--muted)}
.notice strong{color:var(--text);font-size:16px}
.notice button{padding:9px 18px;border-radius:999px;background:var(--accent);color:var(--accent-text);font-weight:600;font-size:14px}
.spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--muted);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
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
    <div class="notice" id="loading"><div class="spinner"></div><span>正在读取三个入口…</span></div>
    <div class="notice hidden" id="error"><strong id="errorTitle">入口暂不可用</strong><span id="errorText"></span><button id="retry">重试</button></div>
    <iframe data-frame="codex" title="Codex" allow="clipboard-read; clipboard-write; fullscreen 'none'"></iframe>
    <iframe data-frame="dsh" title="DSH" allow="clipboard-read; clipboard-write; fullscreen 'none'"></iframe>
    <iframe data-frame="claude" title="Claude" allow="clipboard-read; clipboard-write; fullscreen 'none'"></iframe>
  </div>
</div>
<script>${HUB_CHROME}</script>
<script>
(() => {
  const names = {codex:'Codex',dsh:'DSH',claude:'Claude'};
  const buttons = [...document.querySelectorAll('.capsule button')];
  const stage = document.getElementById('stage');
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const frames = new Map([...document.querySelectorAll('iframe')].map(f => [f.dataset.frame, f]));
  const updateHubChrome=window.installMobileHubChrome(frames);
  let entries = null;
  let current = localStorage.getItem('desk-tab') || 'codex';
  if(!frames.has(current)) current='codex';

  let viewportFrame;
  function syncViewport(){
    cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(()=>{
      const view=window.visualViewport;
      document.documentElement.style.setProperty('--app-height',(view?.height||innerHeight)+'px');
      document.documentElement.style.setProperty('--app-top',(view?.offsetTop||0)+'px');
    });
  }
  window.visualViewport?.addEventListener('resize',syncViewport);
  window.visualViewport?.addEventListener('scroll',syncViewport);
  window.addEventListener('resize',syncViewport);window.addEventListener('pageshow',syncViewport);syncViewport();
  function notifyFrames(){for(const [name,frame] of frames){try{frame.contentWindow.postMessage({type:'mobile-hub-active',active:name===current},location.origin);}catch{}}}
  for(const frame of frames.values()) frame.addEventListener('load',notifyFrames);
  function showError(text){
    loading.classList.add('hidden');
    error.classList.remove('hidden');
    document.getElementById('errorText').textContent = text;
  }
  function apply(){
    updateHubChrome(current);
    for(const button of buttons) button.setAttribute('aria-selected', String(button.dataset.tab === current));
    for(const [name, frame] of frames) frame.classList.toggle('active', name === current);
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
    if(!frame.dataset.loaded){
      frame.dataset.loaded = '1';
      frame.src = entry.url;
    }
    frame.classList.add('active');
  }
  async function load(){
    loading.classList.remove('hidden');
    error.classList.add('hidden');
    try{
      const response = await fetch('/m/api/entries', {cache:'no-store', credentials:'same-origin'});
      if(!response.ok) throw new Error('HTTP ' + response.status);
      const value = await response.json();
      entries = {codex:value.codex, dsh:value.dsh, claude:value.claude};
      loading.classList.add('hidden');
      apply();
    }catch(e){
      showError('读取入口失败，请检查电脑上的服务后重试');
    }
  }
  for(const button of buttons){
    button.addEventListener('click', () => {
      current = button.dataset.tab;
      localStorage.setItem('desk-tab', current);
      apply();
    });
  }
  document.getElementById('retry').addEventListener('click', () => { entries = null; load(); });
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
:root{--bg:#f9fafb;--surface:#ffffff;--text:#0f1115;--muted:#61666b;--faint:#81858c;--line:#e5e7ea;--bubble:#eceef1;--hover:#eceef0;--accent:#c15f3c;--accent-text:#ffffff}
@media(prefers-color-scheme:dark){:root{--bg:#151517;--surface:#232324;--text:#f0f1f2;--muted:#aaafb7;--faint:#999fa8;--line:#393d43;--bubble:#2d3035;--hover:#33363b;--accent:#da8a67;--accent-text:#241b16}}
/* Shared neutral palette and compact mobile workspace list. */
body{height:var(--chat-height,100dvh);display:flex;flex-direction:column;overflow:hidden;background:var(--bg)}
.bar{display:flex;align-items:center;gap:6px;min-height:52px;padding:env(safe-area-inset-top) 12px 0;background:var(--surface);border-bottom:.5px solid var(--line);flex:none}
.bar .title{flex:1;min-width:0;font-size:14px;font-weight:500;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.icon{display:flex;align-items:center;justify-content:center;width:36px;height:44px;border-radius:8px;color:var(--muted);flex:none}
.icon:active{background:var(--hover)}
.icon svg{width:18px;height:18px;display:block}
.view{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;overflow-anchor:none}
#list{padding:0 12px calc(env(safe-area-inset-bottom) + 16px);background:var(--bg)}
.group{display:flex;align-items:center;gap:0;min-height:40px;font-size:13px;font-weight:400;color:var(--muted);padding:0 0 0 8px;line-height:19.5px}
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
.row{display:flex;align-items:center;gap:8px;padding:2px 4px 2px 36px;border-radius:8px;height:36px;min-height:36px;width:100%;text-align:left;transition:background-color 150ms cubic-bezier(.4,0,.2,1)}
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
#messages{min-height:0;flex:1;overflow:auto;overflow-anchor:none;-webkit-overflow-scrolling:touch;padding:20px 24px 24px;display:flex;flex-direction:column;gap:20px}
.msg{display:flex;flex-direction:column;gap:8px;max-width:100%}
.msg.user{align-items:flex-end}
.bubble{max-width:86%;padding:10px 16px;border-radius:20px;background:var(--bubble);white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:22px}
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
.plan-btn:after{content:'';width:5px;height:5px;border-right:1px solid currentColor;border-bottom:1px solid currentColor;transform:rotate(-45deg);flex:none;margin-right:4px}
.plan-details .plan-row{display:flex;gap:8px;padding:6px 10px;font-size:12px;line-height:18px}
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
.message-delivery{display:flex;align-items:center;gap:8px;max-width:90%;color:var(--faint);font-size:11px;line-height:18px}.message-delivery.failed{color:#b04432}.message-delivery button{min-height:28px;padding:2px 6px;color:var(--muted);white-space:nowrap}.session-status{display:flex;align-items:center;gap:4px;min-height:28px;padding:0 6px 4px;color:var(--faint);font-size:11px}.session-status>span{flex:1}.session-status button{min-height:28px;padding:0 6px;border-radius:6px}.session-status button[aria-pressed="true"]{color:var(--text);background:var(--hover)}
.err{color:#c0392b;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.err button{padding:5px 12px;border-radius:999px;background:var(--bubble);color:var(--text);font-size:12px;font-weight:600}
#composer{max-height:calc(var(--ui-height,100dvh) - 68px);overflow-y:auto;overscroll-behavior:contain;flex:none;display:flex;flex-direction:column;margin:0 16px calc(env(safe-area-inset-bottom) + 8px);padding:10px 8px 4px;background:var(--surface);border:.5px solid var(--line);border-radius:24px;box-shadow:0 2px 16px rgba(0,0,0,.045)}
.attachments{display:flex;gap:8px;padding:2px 6px 8px;overflow-x:auto}
.thumb{position:relative;width:64px;height:64px;border-radius:12px;overflow:hidden;background:var(--bubble);flex:none}
.thumb img{width:100%;height:100%;object-fit:cover}
.thumb .rm{position:absolute;top:3px;right:3px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center}
.thumb .up{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);color:#fff;font-size:11px}
.box{display:flex;min-width:0;padding:0 6px}
#input{flex:1;min-width:0;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--text);font:inherit;font-size:16px;line-height:24px;height:44px;min-height:44px;max-height:44px;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;padding:2px 0 14px}
#input::placeholder{color:var(--faint);font-size:14px}
#send{width:44px;height:44px;border:6px solid transparent;border-radius:50%;background:var(--accent);background-clip:padding-box;color:var(--accent-text);display:grid;place-items:center;flex:none}
#send svg{width:17px;height:17px;display:block}
#send.is-sending svg{display:none}
#send.is-sending:after{content:"";width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
#send:disabled{opacity:.4;cursor:default}
.tools-row{position:sticky;bottom:0;background:var(--surface);z-index:1;display:grid;grid-template-columns:44px 44px minmax(0,1fr) 44px;align-items:center;gap:2px;min-height:44px;padding:0}
.tool-btn{width:44px;height:44px;border-radius:12px;border:0;background:transparent;color:var(--muted);display:grid;place-items:center}
.tool-btn svg{width:18px;height:18px;display:block}
.tool-btn:active{background:var(--hover)}
.model-btn{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0;width:100%;height:44px;padding:0 4px;font-size:12px;font-weight:400;color:var(--muted)}
.model-btn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.model-btn .model-provider{flex:none;font-size:10px;color:var(--faint)}.model-provider:empty{display:none}
.model-btn svg{width:12px;height:12px;flex:none;color:var(--faint)}
.spacer{flex:1}
.note{font-size:12px;color:var(--faint);text-align:center;padding:2px 0}
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
.plan-details{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows 200ms ease,opacity 160ms ease}
.plan-details[data-expanded="true"]{grid-template-rows:1fr;opacity:1}
.plan-inner{min-height:0;overflow:hidden}
.plan-list{max-height:min(160px,calc(var(--ui-height,100dvh) * .24));overflow:auto;margin:0 4px 8px;padding:4px 0;border-radius:8px;background:var(--bg)}
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
  <button class="icon" id="back" aria-label="会话列表" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
  <div class="title" id="title">Claude</div>
  <button class="icon" id="new" aria-label="新建会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
</header>
<div id="readStatus" class="list-status hidden" role="status" aria-live="polite"></div>
<main class="view" id="list">
  <div class="group"><span>工作区</span><button type="button" id="workspaceView" aria-label="视图选项"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1" aria-hidden="true"><path d="M2.3 5h5.85M12.05 5h1.65"/><circle cx="9.95" cy="5" r="1.45"/><path d="M2.3 11h1.65M7.85 11h5.85"/><circle cx="5.75" cy="11" r="1.45"/></svg></button><button type="button" id="workspaceNew" aria-label="新建会话"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>
  <div id="listStatus" class="list-status hidden" role="status"></div>
  <div id="rows"></div>
  <div class="empty hidden" id="empty">还没有会话，点右上角 ＋ 新建</div>
</main>
<main class="view hidden" id="chat">
  <div id="messages"></div>
</main>
<form id="composer" class="hidden">
  <div class="attachments hidden" id="attachments"></div>
    <button type="button" class="plan-btn hidden" id="planChip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1.2 1.2L7.5 4.9M4 12l1.2 1.2L7.5 10.9M4 18l1.2 1.2L7.5 16.9"/></svg><span id="planLabel">待办</span><span id="planTask"></span></button>
  <div id="planDetails" class="plan-details" data-expanded="false" inert><div class="plan-inner"><div class="plan-list" id="planList" role="region" aria-label="待办清单"></div></div></div>
  <div class="box"><textarea id="input" rows="1" placeholder="发消息，继续你的任务…" enterkeyhint="send"></textarea></div>
  <div class="tools-row">
    <button type="button" class="tool-btn" id="attach" aria-label="添加图片"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1L13 4.4a3.4 3.4 0 0 1 4.8 4.8l-8.4 8.4a1.9 1.9 0 0 1-2.7-2.7l7.9-7.9"/></svg></button>
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
    mode:localStorage.getItem('clm-mode')||'acceptEdits',
    attachments:[], plan:null, planOpen:false, running:false, since:0, pollTimer:null,
  };
  const $ = id => document.getElementById(id);
  const listView = $('list'), chatView = $('chat'), composer = $('composer');
  const rows = $('rows'), messages = $('messages'), title = $('title'), input = $('input');

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
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function renderText(container, text){
    window.claudeRender(container, text, state.sessionId);
    if(!container.dataset.scrollKey)container.dataset.scrollKey='text:'+renderingMessageId;
    [...container.children].forEach((child,index)=>{child.dataset.scrollKey=container.dataset.scrollKey+':'+index;});
  }
  function timeText(ms){
    const d = new Date(ms), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    if(sameDay) return hm;
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
  function currentRequest(){const request=draftKey?pendingRequests.get(draftKey):null;return request?.posting&&requestInView(request)?request:null;}
  // CSS owns the original fixed height; empty drafts only reset inner scrolling.
  function syncInputHeight(){if(!input.value)input.scrollTop=0;}
  function afterComposerVisible(){const key=draftKey;requestAnimationFrame(()=>{if(key!==draftKey||chatView.classList.contains('hidden'))return;syncInputHeight();viewportChanged();state.navigation?.restore();});}
  function saveDraft(){if(draftKey)drafts.set(draftKey,{text:input.value,attachments:state.attachments.slice(),viewId:state.deliveryViewId});}
  function restoreDraft(key){
    draftKey=key;const value=drafts.get(key);input.value=value?.text||'';state.attachments=value?.attachments?.slice()||[];
    input.scrollTop=0;renderAttachments();afterComposerVisible();
  }
  function showList(){
    state.navigation?.capture();
    rememberView({kind:'list'});closeMenu();saveDraft(); draftKey=null;
    state.sessionController?.abort();state.viewVersion++; state.loading=false;
    stopPoll();
    state.sessionId = null;
    state.deliveryViewId = null;
    state.running = false;
    $('back').hidden = true;
    title.textContent = 'Claude';
    listView.classList.remove('hidden');
    chatView.classList.add('hidden');
    composer.classList.add('hidden');
    $('planChip').classList.add('hidden');
    $('empty').classList.toggle('hidden',Boolean(state.sessions.length));
    if(state.unread)renderSessions();state.navigation?.restore();state.readStatus?.render();refreshSessions();
  }
  const closedWorkspaces = new Set((() => { try{return JSON.parse(sessionStorage.getItem('clm-closed-workspaces')||'[]');}catch{return [];} })());
  let listRequest=0,listController=null;
  function listStatus(text,retry){
    const status=$('listStatus');status.replaceChildren();status.classList.toggle('hidden',!text);
    if(text){const label=document.createElement('span');label.textContent=text;status.append(label);if(retry){const button=document.createElement('button');button.type='button';button.textContent='重试';button.onclick=refreshSessions;status.append(button);}}
  }
  async function refreshSessions(){
    const version=state.viewVersion,request=++listRequest;listController?.abort();const controller=new AbortController();listController=controller;let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    state.navigation?.capture();$('list').setAttribute('aria-busy','true');listStatus(state.sessions.length?'':'正在加载会话…');state.navigation?.restore();
    try{
      const value=await Promise.race([(async()=>{const response=await fetch('/claude/api/sessions',{cache:'no-store',credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error('会话列表读取失败');return response.json();})(),timeout]);
      if(version!==state.viewVersion||request!==listRequest||listView.classList.contains('hidden'))return;
      const next=Array.isArray(value.sessions)?value.sessions:[];
      state.sessions=next;renderSessions();
      listStatus('');state.navigation?.restore();$('empty').textContent='还没有会话，点工作区右侧 ＋ 新建';$('empty').classList.toggle('hidden',Boolean(state.sessions.length));
    }catch(error){
      if((controller.signal.aborted&&!timedOut)||version!==state.viewVersion||request!==listRequest)return;
      listStatus(timedOut?'会话列表读取超时，请重试':state.sessions.length?'刷新失败，保留上次列表':'会话暂时无法加载',true);$('empty').classList.add('hidden');state.navigation?.restore();
    }finally{clearTimeout(timer);if(listController===controller)listController=null;if(version===state.viewVersion&&request===listRequest)$('list').setAttribute('aria-busy','false');}
  }
  setInterval(()=>{if(hubActive&&!document.hidden&&!listView.classList.contains('hidden')&&!listView.inert&&!listController&&$('optionsMenu').classList.contains('hidden'))refreshSessions();},3000);
  function updateSendState(){
    state.sending=Boolean(currentRequest());
    const uploading=state.attachments.some(item=>item.uploading),failed=state.attachments.some(item=>item.failed);
    $('send').classList.toggle('is-sending',state.sending);
    $('send').disabled=!state.modelsLoaded||state.sending||state.loading||uploading||failed||(state.attachments.length>0&&state.capabilities?.attachments!==true)||(!input.value.trim()&&!state.attachments.some(item=>item.id));
    $('send').setAttribute('aria-label',failed?'图片上传失败，请重试或移除':uploading?'图片上传中':state.sending?'正在提交':'发送');
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
    // Native revisions, owner/running metadata and sub-minute timestamps do not
    // describe a visible list change. Keep state.sessions fresh for row actions.
    const fingerprint=JSON.stringify([state.listView,[...groups].map(([cwd,sessions])=>[cwd,sessions.map(session=>[
      session.id,session.title,session.messageCount,timeText(session.updatedAt),state.unread?.isUnread(session)===true,
    ])])]);
    if(rows.dataset.fingerprint===fingerprint)return;
    const previousGroups=new Map([...rows.children].map(group=>[group.dataset.cwd,group]));
    const previousRows=new Map([...rows.querySelectorAll('.row')].map(row=>[row.dataset.scrollKey,row]));
    // Retain live buttons even when content or ordering changes during a click.
    const reconcile=(parent,children)=>{
      children.forEach((child,index)=>{if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);});
      while(parent.children.length>children.length)parent.lastElementChild.remove();
    };
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
        const label = document.createElement('span'); label.className = 'workspace-label'; label.textContent = projectName(cwd) || '其他会话';
        heading.title = cwd; heading.appendChild(label);heading.setAttribute('aria-controls',panel.id);
        const setExpanded=expanded=>{group.dataset.expanded=String(expanded);heading.setAttribute('aria-expanded',String(expanded));panel.inert=!expanded;};
        heading.addEventListener('click',()=>{const expanded=group.dataset.expanded!=='true';setExpanded(expanded);if(expanded)closedWorkspaces.delete(cwd);else closedWorkspaces.add(cwd);try{sessionStorage.setItem('clm-closed-workspaces',JSON.stringify([...closedWorkspaces]));}catch{}});
        const create=document.createElement('button');create.type='button';create.className='workspace-create';create.disabled=!cwd;create.setAttribute('aria-label','在“'+(projectName(cwd)||'当前工作区')+'”中新建会话');create.title=cwd?'在 '+cwd+' 新建会话':'未提供工作目录';
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
          const name=document.createElement('span');name.className='name';
          const dot=document.createElement('span');dot.className='dot';dot.title='未读回复';
          const time=document.createElement('time');time.className='time';row.append(name,dot,time);
          const id=session.id;
          row.addEventListener('click',()=>{const current=state.sessions.find(item=>item.id===id);if(current)openSession(current);});
        }
        const name=row.firstElementChild,dot=row.children[1],time=row.lastElementChild;
        const title=session.title+' · '+session.messageCount+' 条',label=timeText(session.updatedAt),unread=state.unread?.isUnread(session)===true;
        if(row.title!==title)row.title=title;
        if(name.textContent!==session.title)name.textContent=session.title;
        if(time.textContent!==label)time.textContent=label;
        if(dot.style.visibility!==(unread?'visible':'hidden')){
          dot.style.visibility=unread?'visible':'hidden';dot.setAttribute('aria-hidden',String(!unread));
          if(unread){dot.setAttribute('role','img');dot.setAttribute('aria-label','未读回复');}
          else{dot.removeAttribute('role');dot.removeAttribute('aria-label');}
        }
        nextRows.push(row);
      }
      reconcile(items,nextRows);nextGroups.push(group);
    }
    reconcile(rows,nextGroups);rows.dataset.listView=state.listView;rows.dataset.fingerprint=fingerprint;listView.scrollTop=scrollTop;state.navigation?.restore();
  }

  function syncPlanExpansion(){$('planDetails').dataset.expanded=String(state.planOpen);$('planDetails').inert=!state.planOpen;$('planChip').setAttribute('aria-expanded',String(state.planOpen));$('planChip').setAttribute('aria-controls','planDetails');}
  let planSignature='';
  function renderPlan(items){
    const signature=JSON.stringify(items||[]);state.plan=items;
    if(!items||!items.length){planSignature=signature;$('planList').replaceChildren();state.planOpen=false;syncPlanExpansion();$('planChip').classList.add('hidden');return;}
    if(signature===planSignature)return;planSignature=signature;
    const list=$('planList'),scroll=list.scrollTop;
    for(let index=0;index<items.length;index++){
      const item=items[index];let row=list.children[index];if(!row){row=document.createElement('div');const icon=document.createElement('span');icon.className='ico';const text=document.createElement('span');text.className='txt';row.append(icon,text);list.append(row);}
      row.className='plan-row '+(item.status||'pending');const mark=item.status==='done'?'✓':item.status==='in_progress'?'●':'○';if(row.firstChild.textContent!==mark)row.firstChild.textContent=mark;if(row.lastChild.textContent!==item.content)row.lastChild.textContent=item.content;
    }
    while(list.children.length>items.length)list.lastElementChild.remove();list.scrollTop=scroll;
    syncPlanExpansion();
    $('planChip').classList.remove('hidden');
    $('planChip').setAttribute('aria-label', '查看待办');
    const done = items.filter(item => item.status === 'done').length;
    $('planLabel').textContent = '待办 ' + done + '/' + items.length;
    const active = items.find(item => item.status === 'in_progress') || items.find(item => item.status !== 'done');
    $('planTask').textContent = active?.content || '全部完成';
  }

  function newAssistant(){const owner=window.createClaudeAssistant({container:messages,renderText});assistantOwners.add(owner);return owner;}

  function addUserMessage(text, attachments, attachmentDelivery){
    const wrap = document.createElement('div'); wrap.className = 'msg user';
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    if(attachments && attachments.length){
      const imgs = document.createElement('div'); imgs.className = 'imgs';
      for(const item of attachments){
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
    if(attachments?.length&&attachmentDelivery){
      const note=document.createElement('div');note.className='message-delivery attachment-delivery';
      note.textContent=attachmentDelivery==='native'?'图片已作为原生附件送达电脑端。':'电脑端已收到消息，并以文件读取图片（非原生附件）。';
      bubble.appendChild(note);
    }
    wrap.appendChild(bubble); messages.appendChild(wrap);return wrap;
  }

  let followOutput=true,userScrolling=false,scrollIntentTimer;
  function userScrollIntent(){userScrolling=true;clearTimeout(scrollIntentTimer);scrollIntentTimer=setTimeout(()=>{userScrolling=false;},250);}
  for(const type of ['wheel','touchmove','pointerdown','keydown'])messages.addEventListener(type,userScrollIntent,{passive:true});
  messages.addEventListener('scroll',()=>{if(userScrolling&&hubActive&&!chatView.inert&&messages.getClientRects().length){followOutput=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;state.navigation?.capture();}},{passive:true});
  function scrollDown(force){
    if(force)followOutput=true;
    if(!hubActive||document.hidden||chatView.inert)return;
    if(followOutput){messages.scrollTop=messages.scrollHeight;state.navigation?.capture();}
  }

  let historyAssistant = null;
  let renderingMessageId=null;
  const assistantOwners=new Set(), seenMessages=new Set(),pendingNativeUsers=new Set();
  function appendMessage(message){
    if(message.role==='user'&&(!message.id||!seenMessages.has(message.id)||pendingNativeUsers.delete(message.id)))historyAssistant=null;
    if(message.id&&seenMessages.has(message.id)) return;
    renderingMessageId=message.id||'anonymous';
    if(message.role === 'user'){
      historyAssistant = null;
      const row=addUserMessage(message.text, message.attachments||[], message.attachmentDelivery);if(row?.dataset)row.dataset.scrollKey='user:'+renderingMessageId;
      if(message.id)seenMessages.add(message.id);
      return;
    }
    const box = historyAssistant || (historyAssistant = newAssistant());
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
    return state.sessionId===id&&state.viewVersion===version&&state.nativeReadMarker===marker&&hubActive&&!document.hidden&&!chatView.inert&&!composer.inert&&!chatView.classList.contains('hidden')&&chatView.getClientRects().length>0&&$('optionsMenu').classList.contains('hidden');
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
  function stopPoll(){
    pollController?.abort();pollController=null;state.polling=false;
    if(state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  function startPoll(){
    stopPoll();
    if(!state.sessionId||!hubActive)return;
    state.pollTimer=setInterval(poll,1500);
  }
  async function poll(){
    if(state.sending || state.loading || !hubActive || document.hidden || !state.sessionId) return;
    const id = state.sessionId, version=state.viewVersion;
    if(state.polling) return; state.polling=true;const controller=new AbortController();pollController=controller;
    let timer,timedOut=false;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},15000);});
    try{
      const value=await Promise.race([(async()=>{
        const response=await fetch('/claude/api/session/'+encodeURIComponent(id)+'?since='+state.since,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        if(!response.ok)throw Error('HTTP '+response.status);return response.json();
      })(),timeout]);
      if(state.sessionId!==id || version!==state.viewVersion || state.sending || controller.signal.aborted) return;
      state.readStatus?.('poll');state.navigation?.capture();applyControl(value.control);
      if(value.plan) renderPlan(value.plan);
      for(const update of value.toolUpdates||[]){
        for(const owner of assistantOwners){if(owner.toolMap.has(update.id)) owner.toolResult(update.id,update.text,update.isError);}
      }
      if(value.messages.length){
        for(const message of value.messages)appendMessage(message);
        scrollDown();
      }
      if(state.unread)acknowledgeRead(value,state.since===0);
      state.since=Math.max(state.since,value.cursor||0);state.navigation?.restore();
    }catch(error){
      if(pollController===controller&&state.sessionId===id&&version===state.viewVersion&&(timedOut||!controller.signal.aborted))state.readStatus?.('poll',timedOut?'对话更新超时，已保留当前内容。':'暂时无法更新对话，已保留当前内容。',poll,()=>state.sessionId===id);
    }finally{clearTimeout(timer);if(pollController===controller){pollController=null;state.polling=false;}}
  }

  async function openSession(session){
    state.navigation?.capture();
    rememberView({kind:'chat',id:session.id,cwd:session.cwd,title:session.title});closeMenu();saveDraft(); restoreDraft(session.id);
    state.sessionController?.abort();const controller=new AbortController();state.sessionController=controller;
    const version=++state.viewVersion; state.loading=true; updateSendState();
    state.sessionId = session.id;
    state.deliveryViewId = null;
    state.readStatus?.('poll');state.readStatus?.render();
    state.cwd = session.cwd;state.control=null;state.actualModel=null;state.actualModelLabel=null;state.mode=null;updateChips();
    state.running = Boolean(session.running);
    state.since = 0;
    $('back').hidden = false;
    title.textContent = session.title;
    listView.classList.add('hidden');
    chatView.classList.remove('hidden');
    composer.classList.remove('hidden');
    messages.textContent = ''; historyAssistant = null; assistantOwners.clear(); seenMessages.clear();pendingNativeUsers.clear();
    messages.scrollTop = 0;
    const loading=document.createElement('div');loading.className='waiting-status';loading.setAttribute('role','status');loading.textContent='正在加载对话…';messages.append(loading);
    renderPlan(null);
    stopPoll();
    let timer,timedOut=false;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Error('读取超时'));},20000);});
    try{
      const {response,value}=await Promise.race([(async()=>{const response=await fetch('/claude/api/session/'+encodeURIComponent(session.id),{cache:'no-store',credentials:'same-origin',signal:controller.signal});const value=await response.json();return {response,value};})(),timeout]);
      if(version!==state.viewVersion) return;
      if(!response.ok) throw new Error(value.error || '读取失败');
      loading.remove();
      applyControl(value.control);renderPlan(value.plan || null);
      for(const message of value.messages)appendMessage(message);
      if(state.unread)acknowledgeRead(value,true);
      state.since=Math.max(state.since,Number.isFinite(value.cursor)?value.cursor:0);
      if(value.truncated){
        const note = document.createElement('div'); note.className = 'note';
        note.textContent = '只显示最近 400 条消息'; messages.prepend(note);
      }
      restorePendingMessages();
      startPoll();
    }catch(e){
      if(version!==state.viewVersion) return;
      loading.remove();
      errorLine(timedOut||e.name==='AbortError'?'读取会话超时，请重试':'读取会话失败：'+e.message,()=>openSession(session));
    }finally{clearTimeout(timer);if(state.sessionController===controller)state.sessionController=null;if(version===state.viewVersion){state.loading=false;if(state.navigation?.has())state.navigation.restore();else{state.navigation?.resetFollow();scrollDown(true);state.navigation?.capture();}updateSendState();}}
  }

  function newChat(cwd=null,restored=null){
    state.navigation?.capture();
    const key=restored?.scope||'new:'+(cwd||''),viewId=restored?.viewId||crypto.randomUUID();
    rememberView({kind:'new',cwd,scope:key,viewId});closeMenu();saveDraft();restoreDraft(key);
    state.sessionController?.abort();state.viewVersion++; state.loading=false;
    stopPoll();
    state.sessionId = null;
    state.deliveryViewId = viewId;state.control=null;state.mode='default';state.actualModelLabel=null;state.actualModel=null;
    state.cwd = cwd;state.since=0;state.readStatus?.('poll');state.readStatus?.render();
    state.running = false;
    $('back').hidden = false;
    title.textContent = cwd?'新会话 · '+projectName(cwd):'新会话';title.title=cwd||'';
    listView.classList.add('hidden');
    chatView.classList.remove('hidden');
    composer.classList.remove('hidden');
    messages.textContent = ''; historyAssistant = null; assistantOwners.clear(); seenMessages.clear();pendingNativeUsers.clear();
    renderPlan(null);
    restorePendingMessages();
    state.navigation?.resetFollow();state.navigation?.restore();afterComposerVisible();updateSendState();updateChips();input.focus({preventScroll:true});
  }

  function errorLine(text, retry){
    const line = document.createElement('div'); line.className = 'err';
    const span = document.createElement('span'); span.textContent = text;
    line.appendChild(span);
    if(retry){
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '重试';
      button.addEventListener('click', () => { line.remove(); retry(); });
      line.appendChild(button);
    }
    messages.appendChild(line); scrollDown();
  }

  const deliveryCommands=new Map();
  const pendingStorage='clm-pending-desktop-commands-v1';
  function persistCommands(){try{localStorage.setItem(pendingStorage,JSON.stringify([...deliveryCommands.values()].filter(r=>!['accepted','rejected'].includes(r.state)).slice(-30).map(r=>({requestId:r.requestId,sessionId:r.sessionId,scope:r.scope,viewId:r.viewId,text:r.text,cwd:r.cwd,attachments:(r.attachments||[]).map(a=>({id:a.id,name:a.name,url:a.url})),state:r.state,createdAt:r.createdAt}))));}catch{}}
  function requestInView(request){
    if(!draftKey||!listView.classList.contains('hidden'))return false;
    return state.sessionId?request.sessionId===state.sessionId:request.scope===draftKey&&Boolean(request.viewId)&&request.viewId===state.deliveryViewId;
  }
  function matchingDraft(value,request){const text=value?.text.trim()||(value?.attachments?.length?'请查看这张图片。':'');return value&&text===request.text&&JSON.stringify((value.attachments||[]).map(a=>a.id))===JSON.stringify((request.attachments||[]).map(a=>a.id));}
  function clearMatchingDrafts(request){
    for(const key of new Set([request.scope,request.key,request.sessionId])){
      const draft=key?drafts.get(key):null;
      if(matchingDraft(draft,request)&&(!draft.viewId||!request.viewId||draft.viewId===request.viewId))drafts.delete(key);
    }
  }
  function pendingSame(text,attachments){const ids=JSON.stringify(attachments.map(a=>a.id));return [...deliveryCommands.values()].find(r=>!['accepted','rejected'].includes(r.state)&&requestInView(r)&&r.text===text&&JSON.stringify((r.attachments||[]).map(a=>a.id))===ids);}
  function renderDelivery(request){
    if(!request.wrap?.isConnected)return;
    request.wrap.querySelectorAll?.('.attachment-delivery').forEach(node=>node.remove());
    let label=request.wrap.querySelector('.message-delivery');if(!label){label=document.createElement('div');label.className='message-delivery';request.wrap.append(label);}
    label.replaceChildren();label.classList.toggle('failed',request.state==='rejected');
    if(request.state==='accepted'){
      label.remove();
      if(request.attachments?.length&&request.attachmentDelivery){
        const note=document.createElement('div');note.className='message-delivery attachment-delivery';
        note.textContent=request.attachmentDelivery==='native'?'图片已作为原生附件送达电脑端。':'电脑端已收到消息，并以文件读取图片（非原生附件）。';
        request.wrap.append(note);
      }
      return;
    }
    if(request.state==='rejected'){
      const text=document.createElement('span');text.textContent=request.error||'未投递到电脑';label.append(text);
      const action=document.createElement('button');action.type='button';action.textContent='重试';action.onclick=()=>{
        if(state.sending)return;
        if(request.wrap?.isConnected)request.wrap.remove();
        send(request.text,{attachments:request.attachments,preserveDraft:true,sessionId:request.sessionId||undefined,cwd:request.cwd});
      };label.append(action);
      return;
    }
    if(request.state==='unknown'){
      const text=document.createElement('span');text.textContent='发送状态未确认';label.append(text);
      const action=document.createElement('button');action.type='button';action.textContent='重新发送';action.onclick=()=>{
        if(state.sending)return;
        deliveryCommands.delete(request.requestId);
        if(pendingRequests.get(request.key)===request)pendingRequests.delete(request.key);
        persistCommands();
        if(request.wrap?.isConnected)request.wrap.remove();
        send(request.text,{attachments:request.attachments,preserveDraft:true,sessionId:request.sessionId||undefined,cwd:request.cwd});
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
  function applyControl(control){
    if(!control)return;state.control=control;state.running=Boolean(control.running);
    state.mode=control.permissionMode||null;
    state.actualModel=control.actualModel||control.model||null;
    if(control.selectedModel)state.model=control.selectedModel;
    state.actualModelLabel=control.modelLabel||null;
    updateChips();updateSendState();
  }
  function receiveDelivery(request,value){
    const previous=request.state;request.state=value.state||'unknown';request.error=value.error||null;
    if(value.attachmentDelivery)request.attachmentDelivery=value.attachmentDelivery;
    if(value.sessionId)request.sessionId=value.sessionId;
    const current=requestInView(request);
    if(['accepted','rejected'].includes(request.state))state.readStatus?.('delivery:'+request.requestId);
    if(request.state==='accepted'){clearMatchingDrafts(request);}
    if(current&&value.sessionId){const firstBind=!state.sessionId;state.sessionId=value.sessionId;draftKey=value.sessionId;request.key=value.sessionId;if(firstBind)title.textContent=request.text.slice(0,72);rememberView({kind:'chat',id:value.sessionId,cwd:request.cwd,title:title.textContent});}
    if(current&&request.state!=='rejected'&&request.state!=='prepared'){
      const sameInput=matchingDraft({text:input.value,attachments:state.attachments},request);
      if(sameInput){input.value='';state.attachments=[];renderAttachments();syncInputHeight();clearMatchingDrafts(request);}
      if(value.control)applyControl(value.control);
      startPoll();poll();
    }
    renderDelivery(request);persistCommands();
    if(previous!=='accepted'&&request.state==='accepted'&&!listView.classList.contains('hidden'))refreshSessions();
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
      state.readStatus?.(key);if(!['accepted','rejected'].includes(request.state))receiveDelivery(request,value);
    }catch{
      state.readStatus?.(key,timedOut?'投递状态查询超时，尚未确认结果。':'暂时无法查询投递状态，尚未确认结果。',()=>checkDelivery(request),()=>requestInView(request)&&!['accepted','rejected'].includes(request.state));
    }finally{clearTimeout(timer);request.checking=false;}
  }

  function restorePendingMessages(){
    for(const request of deliveryCommands.values())if(requestInView(request)&&!['accepted','rejected'].includes(request.state)&&!seenMessages.has(request.requestId)){
      request.wrap=addUserMessage(request.text,request.attachments||[]);seenMessages.add(request.requestId);pendingNativeUsers.add(request.requestId);renderDelivery(request);
    }
  }
  async function send(text,options={}){
    updateSendState();const attachments=(options.attachments||state.attachments).slice();
    if(!state.modelsLoaded){openMenu('attachment',$('attach'));return;}
    if(attachments.length&&state.capabilities?.attachments!==true){openMenu('attachment',$('attach'));return;}
    if(state.sending||state.loading||attachments.some(a=>a.uploading||a.failed))return;
    text=text.trim()||(attachments.some(a=>a.id)?'请查看这张图片。':'');if(!text)return;
    const prior=pendingSame(text,attachments);if(prior){checkDelivery(prior);return;}

    const request={requestId:crypto.randomUUID(),sessionId:options.sessionId??state.sessionId,scope:draftKey,key:draftKey,viewId:state.deliveryViewId,text,cwd:options.cwd??state.cwd,attachments,version:state.viewVersion,state:'prepared',createdAt:Date.now(),posting:true};
    deliveryCommands.set(request.requestId,request);pendingRequests.set(request.key,request);persistCommands();
    request.wrap=addUserMessage(text,attachments);seenMessages.add(request.requestId);pendingNativeUsers.add(request.requestId);renderDelivery(request);scrollDown(true);updateSendState();
    const payload={requestId:request.requestId,sessionId:request.sessionId,cwd:request.cwd||undefined,text,attachments:attachments.map(a=>a.id),model:state.model,permissionMode:state.mode,priority:state.priority||'now'};
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
    try{
      const response=await fetch('/claude/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),credentials:'same-origin',signal:controller.signal});
      const value=await response.json();
      if(value.notDispatched===true){receiveDelivery(request,{...value,state:'rejected'});}
      else if(value.requestId===request.requestId){receiveDelivery(request,value);}
      else{request.state='unknown';renderDelivery(request);persistCommands();checkDelivery(request);}
    }catch{request.state='unknown';renderDelivery(request);persistCommands();checkDelivery(request);}
    finally{
      clearTimeout(timer);request.posting=false;
      if(pendingRequests.get(request.scope)===request)pendingRequests.delete(request.scope);
      if(pendingRequests.get(request.key)===request)pendingRequests.delete(request.key);
      updateSendState();if(request.sessionId===state.sessionId){startPoll();poll();}
    }
  }
  try{for(const saved of JSON.parse(localStorage.getItem(pendingStorage)||'[]'))if(saved?.requestId&&/^[0-9a-f-]{36}$/i.test(saved.requestId))deliveryCommands.set(saved.requestId,{...saved,state:saved.state||'unknown',posting:false});}catch{}
  setInterval(()=>{if(hubActive&&!document.hidden)for(const request of deliveryCommands.values())checkDelivery(request);},1500);

  function attachmentPreview(item){
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    const img = document.createElement('img'); img.src = item.url || item.preview; img.alt = item.name || '图片';
    thumb.appendChild(img);
    if(item.uploading){
      const up=document.createElement('div');up.className='up';up.textContent='上传中';thumb.append(up);
    }else if(item.failed){
      const retry=document.createElement('button');retry.type='button';retry.className='up';retry.textContent='重试上传';retry.title=item.error||'上传失败';retry.setAttribute('aria-label','重新上传 '+item.name);retry.onclick=()=>uploadFile(item.file,item);thumb.append(retry);
    }
    const rm=document.createElement('button');rm.type='button';rm.className='rm';rm.textContent='×';rm.setAttribute('aria-label','移除 '+item.name);
    rm.onclick=()=>{state.attachments=state.attachments.filter(x=>x!==item);renderAttachments();};thumb.append(rm);
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
    const item=existing||{name:file.name,preview:URL.createObjectURL(file),file};
    Object.assign(item,{uploading:true,failed:false,error:null});if(!state.attachments.includes(item))state.attachments.push(item);renderAttachments();
    const controller=new AbortController();let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);
    try{
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
      const response = await fetch('/claude/api/upload', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({name:file.name, data}), credentials:'same-origin',signal:controller.signal});
      const value = await response.json();
      if(!response.ok) throw Error(value.error || ('HTTP ' + response.status));
      Object.assign(item, {id:value.id, url:value.url, uploading:false});
    }catch(e){
      Object.assign(item,{uploading:false,failed:true,error:timedOut?'上传超时，请重试':e.message});
    }finally{clearTimeout(timer);}
    if(state.attachments.includes(item))renderAttachments();
  }

  function modeText(){
    return ({bypassPermissions:'完全放行',acceptEdits:'自动接受编辑',default:'执行前确认',plan:'计划模式'})[state.mode]||'电脑端权限';
  }
  function updateChips(){
    const model = state.models.find(item => item.model === state.model);
    const fullName = model ? model.label : (state.model || '模型');
    const modelParts=(state.sessionId?(state.actualModelLabel||state.actualModel||'电脑端模型待确认'):fullName).split(' · ');
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
      const hint=document.createElement('div');hint.className='hint';hint.textContent=!state.modelsLoaded?(state.modelsError||'正在读取电脑端接收能力，请稍后再试。'):state.capabilities?.attachments===true?'图片会随消息进入同一个电脑端会话；电脑端不支持原生附件时会以文件路径交给模型读取，手机端会标明实际方式。':'当前电脑端暂不支持从手机接收图片，图片尚未发送。';menu.append(hint);
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
  function viewportChanged(){document.documentElement.style.setProperty('--ui-height',Math.min(innerHeight,window.visualViewport?.height||innerHeight)+'px');if(menuAnchor)positionMenu();}
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
      if(state.models.length&&!state.models.some(item=>item.model===state.model))state.model=state.models.some(item=>item.model===value.defaultModel)?value.defaultModel:state.models[0].model;
      state.modelsLoaded=true;state.readStatus?.('models');updateChips();
    }catch(error){
      if(request!==state.modelsRequest)return;
      state.modelsError=timedOut?'连接电脑端超时，请重试。':'暂时无法读取电脑端接收能力，请重试。';
      state.readStatus?.('models',state.modelsError,()=>loadModels().catch(()=>{}));throw error;
    }finally{clearTimeout(timer);if(request===state.modelsRequest){state.modelsLoading=false;updateSendState();}}
  }

  function attachmentAction(){if(state.modelsLoaded&&state.capabilities?.attachments===true)$('file').click();else openMenu('attachment',$('attach'));}
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
    for(const file of $('file').files) uploadFile(file);
    $('file').value = '';
  });
  input.addEventListener('input',()=>{updateSendState();syncInputHeight();});
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
