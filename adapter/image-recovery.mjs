// Native lazy loading controls initial work. Failed visible images share a
// bounded recovery queue; the UI keeps the image mounted so it can recover.
export function installImageRecovery({doc=document,win=window,request=fetch,concurrency=3,retryDelay=1000}={}){
 const style=doc.createElement('style');style.textContent='button:has(img[data-image-recovery="failed"]) [data-markdown-image-state="loading"]{display:none!important}';doc.head.append(style);
 const states=new Map(),queue=[];let active=0,disposed=false;
 const visible=image=>{const r=image.getBoundingClientRect();return r.bottom>=0&&r.top<=win.innerHeight&&r.right>=0&&r.left<=win.innerWidth;};
 const valid=image=>{try{const u=new URL(image.getAttribute('src'),win.location.href);return u.origin===win.location.origin&&u.pathname==='/mobile/api/image'?u.href:null;}catch{return null;}};
 function clear(entry){clearTimeout(entry.timer);entry.button?.remove();entry.button=null;if(entry.blob)URL.revokeObjectURL(entry.blob);entry.blob=null;}
 function enqueue(entry,manual=false){
  if(disposed||entry.pending||!entry.image.isConnected||!visible(entry.image)||doc.hidden)return;
  if(!manual&&(entry.exhausted||entry.blob))return;
  if(manual){entry.attempts=0;entry.exhausted=false;}
  entry.pending=true;queue.push(entry);pump();
 }
 function button(entry,message){
  if(entry.button){entry.button.textContent=message;return;}
  const b=doc.createElement('button');b.type='button';b.textContent=message;b.setAttribute('data-image-retry','');
  b.style.cssText='display:block;position:relative;z-index:1;padding:8px 12px;margin:6px 0;border:1px solid #ddd;border-radius:8px;background:var(--color-background,#fff);color:inherit;font:inherit';
  b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();enqueue(entry,true);});
  entry.image.parentElement?.insertAdjacentElement('afterend',b);entry.button=b;
 }
 async function run(entry){
  const controller=new AbortController();entry.controller=controller;entry.attempts++;
  entry.image.dataset.imageRecovery='loading';
  button(entry,'图片加载中…');
  try{
   const response=await request(entry.source,{credentials:'same-origin',cache:'reload',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
   if(!response.ok){const error=Object.assign(Error('Image unavailable'),{status:response.status});await response.body?.cancel();throw error;}
   if(!/^image\//i.test(response.headers.get('content-type')||''))throw Error('Invalid image response');
   const blob=await response.blob();if(disposed||!entry.image.isConnected)return;
   if(entry.blob)URL.revokeObjectURL(entry.blob);entry.blob=URL.createObjectURL(blob);
   entry.button?.remove();entry.button=null;entry.image.src=entry.blob;
  }catch(error){
   if(disposed||!entry.image.isConnected)return;
   const permanent=[400,401,403,404,410,413,415,422,423].includes(error.status);
   entry.exhausted=permanent||entry.attempts>=3;
   entry.image.dataset.imageRecovery='failed';
   button(entry,error.status===404?'原图片已不存在 · 点击重试':'图片未加载 · 点击重试');
   if(!permanent&&entry.attempts<3)entry.timer=setTimeout(()=>enqueue(entry),retryDelay*entry.attempts);
  }finally{entry.pending=false;entry.controller=null;active--;pump();}
 }
 function pump(){while(!disposed&&active<concurrency&&queue.length){const entry=queue.shift();if(!entry.image.isConnected){entry.pending=false;continue;}active++;void run(entry);}}
 function error(event){
  const image=event.target;if(image?.tagName!=='IMG')return;
  let entry=states.get(image);const source=entry?.source||valid(image);if(!source)return;
  if(entry?.blob){URL.revokeObjectURL(entry.blob);entry.blob=null;}
  // React's original error branch unmounts the image permanently. Keep its
  // successful onLoad branch and preview controls, while owning failure state.
  event.stopImmediatePropagation();
  if(!entry){entry={image,source,attempts:0,pending:false};states.set(image,entry);observer?.observe(image);}
  if(entry.attempts<3)enqueue(entry);else button(entry,'图片未加载 · 点击重试');
 }
 function resume(){for(const entry of states.values())if(entry.attempts<3&&!entry.blob)enqueue(entry);}
 const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{for(const {target,isIntersecting}of entries)if(isIntersecting){const entry=states.get(target);if(entry&&entry.attempts<3)enqueue(entry);}});
 const cleanup=new MutationObserver(()=>{for(const[image,entry]of states)if(!image.isConnected){entry.controller?.abort();clear(entry);observer?.unobserve(image);states.delete(image);}});
 cleanup.observe(doc.documentElement,{childList:true,subtree:true});
 doc.addEventListener('error',error,true);doc.addEventListener('visibilitychange',resume);win.addEventListener('online',resume);
 return()=>{disposed=true;queue.length=0;style.remove();cleanup.disconnect();observer?.disconnect();doc.removeEventListener('error',error,true);doc.removeEventListener('visibilitychange',resume);win.removeEventListener('online',resume);for(const entry of states.values()){entry.controller?.abort();clear(entry);}states.clear();};
}

// Runs inside the existing opaque HTML-preview iframe; no parent access or
// additional sandbox permissions. Ordinary one-finger scrolling stays native.
export function installPreviewZoom() {
  const root = document.documentElement;
  if (root.hasAttribute('data-dshm-zoom')) return;
  let scale = 1, pinch = null, gesture = null, pan = null;
  const clamp = value => Math.min(4, Math.max(0.2, value));
  const center = touches => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 });
  const distance = touches => Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
  const begin = point => {
    // Freeze the responsive layout width so pinch scales the document instead
    // of reflowing its text on every movement.
    if (!root.style.width) root.style.width = window.innerWidth + 'px';
    return { scale, x: (window.scrollX + point.x) / scale, y: (window.scrollY + point.y) / scale };
  };
  const apply = (value, anchor, point) => {
    scale = clamp(value);
    root.style.setProperty('zoom', String(scale));
    root.setAttribute('data-dshm-zoom', String(scale));
    window.scrollTo(Math.max(0, anchor.x * scale - point.x), Math.max(0, anchor.y * scale - point.y));
  };
  root.setAttribute('data-dshm-zoom', '1');
  const style = document.createElement('style');
  style.textContent = 'html{touch-action:none!important;overflow:auto!important;overscroll-behavior:contain}';
  document.head.append(style);
  const options = { passive: false, capture: true };
  document.addEventListener('touchstart', event => {
    if (event.touches.length === 1) {
      if (event.target.closest?.('a,button,input,textarea,select,[contenteditable]')) return;
      pan = {x:event.touches[0].clientX,y:event.touches[0].clientY}; return;
    }
    if (event.touches.length !== 2) return;
    pan = null; event.preventDefault();
    pinch = { ...begin(center(event.touches)), distance: Math.max(1, distance(event.touches)) };
  }, options);
  document.addEventListener('touchmove', event => {
    if (event.touches.length === 1 && pan) {
      event.preventDefault(); const t=event.touches[0];
      window.scrollTo(window.scrollX+pan.x-t.clientX,window.scrollY+pan.y-t.clientY);
      pan={x:t.clientX,y:t.clientY}; return;
    }
    if (event.touches.length !== 2 || !pinch) return;
    event.preventDefault();
    apply(pinch.scale * distance(event.touches) / pinch.distance, pinch, center(event.touches));
  }, options);
  for (const type of ['touchend', 'touchcancel']) document.addEventListener(type, event => {
    if (event.touches.length < 2) pinch = null;
    pan = event.touches.length === 1 ? {x:event.touches[0].clientX,y:event.touches[0].clientY} : null;
  }, options);
  // Safari can report its native gesture events in addition to touch events.
  document.addEventListener('gesturestart', event => {
    event.preventDefault();
    gesture = begin({ x: event.clientX || innerWidth / 2, y: event.clientY || innerHeight / 2 });
  }, options);
  document.addEventListener('gesturechange', event => {
    event.preventDefault();
    if (!pinch && gesture && Number.isFinite(event.scale)) apply(gesture.scale * event.scale, gesture, { x: event.clientX || innerWidth / 2, y: event.clientY || innerHeight / 2 });
  }, options);
  document.addEventListener('gestureend', event => { event.preventDefault(); gesture = null; }, options);
}


// Scoped to the preview surface; toolbar controls keep their normal gestures.
function attachPreviewImageGestures(image) {
  const surface = image?.parentElement;
  if (!surface) return () => {};
  const old = { touchAction: surface.style.touchAction, transform: image.style.transform, origin: image.style.transformOrigin };
  let scale = 1, x = 0, y = 0, gesture = null, lastTap = null, tap = null;
  surface.style.touchAction = 'none';
  image.style.transformOrigin = 'center center';
  const controls = target => target?.closest?.('button,[role="menuitem"],a');
  const point = touches => {
    const a = touches[0], b = touches[1] || a;
    const rect = surface.getBoundingClientRect();
    return { x: (a.clientX + b.clientX) / 2 - rect.left - rect.width / 2,
      y: (a.clientY + b.clientY) / 2 - rect.top - rect.height / 2,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
  };
  const draw = () => {
    // Keep the fitted image reachable, including after rotating the phone.
    const limitX = Math.max(0, (image.offsetWidth * scale - surface.clientWidth) / 2);
    const limitY = Math.max(0, (image.offsetHeight * scale - surface.clientHeight) / 2);
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const begin = touches => { gesture = touches.length ? { ...point(touches), scale, tx: x, ty: y, count: touches.length } : null; };
  const start = event => {
    if (controls(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    begin(event.touches);
    tap = event.touches.length === 1 ? { ...point(event.touches), time: Date.now() } : null;
    if (event.touches.length > 1) lastTap = null;
  };
  const move = event => {
    if (!gesture) return;
    event.preventDefault(); event.stopPropagation();
    if (event.touches.length !== gesture.count) { begin(event.touches); return; }
    const p = point(event.touches);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > 8) tap = null;
    scale = gesture.count > 1 && gesture.distance > 0
      ? Math.max(0.05, Math.min(8, gesture.scale * p.distance / gesture.distance)) : gesture.scale;
    const ratio = scale / gesture.scale;
    x = p.x - (gesture.x - gesture.tx) * ratio;
    y = p.y - (gesture.y - gesture.ty) * ratio;
    draw();
  };
  const end = event => {
    if (!gesture) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.touches.length && tap && Date.now() - tap.time < 300) {
      if (lastTap && tap.time - lastTap.time < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 24) {
        scale = 1; x = y = 0; draw(); lastTap = null;
      } else lastTap = tap;
    }
    tap = null; begin(event.touches);
  };
  const cancel = () => { gesture = tap = lastTap = null; };
  const reset = () => { cancel(); scale = 1; x = y = 0; draw(); };
  const events = { touchstart: start, touchmove: move, touchend: end, touchcancel: cancel };
  for (const [name, handler] of Object.entries(events)) surface.addEventListener(name, handler, { passive: false, capture: true });
  image.addEventListener('load', reset);
  return () => {
    for (const [name, handler] of Object.entries(events)) surface.removeEventListener(name, handler, true);
    image.removeEventListener('load', reset);
    surface.style.touchAction = old.touchAction;
    image.style.transform = old.transform; image.style.transformOrigin = old.origin;
  };
}


// DSH mobile uses a full-viewport preview over the conversation. Keep the
// existing React file readers, tab state and sandbox; adapt only the surface.
export function installMobilePreview({doc=document,win=window}={}) {
 globalThis.__CODEX_PREVIEW_HTML_DOC__=text=>{const script='<script>('+installPreviewZoom.toString()+')();<'+ '/script>';return /<\/body>/i.test(text)?text.replace(/<\/body>/i,script+'</body>'):text+script;};
 const stopFilePickerAnchor=installFilePickerAnchors(doc,win);
 doc.documentElement.dataset.cmPreviewInstalled='true';
 const media=win.matchMedia('(max-width: 820px)');
 const cleanups=new Map(),frames=new WeakMap();let disposed=false,scheduled=false;
 function scan(){
  scheduled=false;if(disposed)return;
  for(const [node,cleanup] of cleanups)if(!node.isConnected){cleanup();cleanups.delete(node);}

  for(const img of doc.querySelectorAll('[data-image-preview] img'))if(!cleanups.has(img))cleanups.set(img,attachPreviewImageGestures(img));
  // MobileShell owns a separate overlay; it does not mount workspace-side-frame.
  // Treat its content as a page, preserving the original readers and close action.
  for(const overlay of doc.querySelectorAll('[data-mobile-side-pane-overlay]')){
   const pane=[...overlay.children].find(node=>node.tagName!=='BUTTON');
   if(!pane)continue;
   pane.setAttribute('data-cm-preview-page','');
   let header=pane.querySelector('[data-cm-preview-page-header]');
   if(!header){
    header=doc.createElement('header');header.setAttribute('data-cm-preview-page-header','');
    const back=doc.createElement('button');back.type='button';back.setAttribute('data-cm-preview-back','');back.setAttribute('aria-label','返回会话');
    back.innerHTML='<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
    back.addEventListener('click',()=>overlay.querySelector(':scope > button')?.click());
    const title=doc.createElement('span');title.setAttribute('data-cm-preview-page-title','');header.append(back,title);pane.prepend(header);
   }
   const active=pane.querySelector('[role="tabpanel"][data-state="active"]');
   const labelledBy=active?.getAttribute('aria-labelledby');
   const tab=labelledBy?doc.getElementById(labelledBy):null;
   const label=tab?.textContent?.trim()||active?.getAttribute('aria-label')||'文件预览';
   const title=header.querySelector('[data-cm-preview-page-title]');
   if(title.textContent!==label)title.textContent=label;
  }
  for(const pane of doc.querySelectorAll('[data-workspace-side-frame],[data-cm-preview-page]')){
   const bar=pane.querySelector('[role="tablist"]');
   if(bar&&!pane.hasAttribute('data-cm-preview-page')&&!bar.querySelector('[data-cm-preview-back]')){
    const back=doc.createElement('button');back.type='button';back.dataset.cmPreviewBack='';back.setAttribute('aria-label','返回会话');back.textContent='‹';
    back.addEventListener('click',()=>pane.querySelector('[data-testid="side-pane-toggle"]')?.click());bar.prepend(back);
   }
   // HTML stays in its original sandbox. srcdoc also works in iOS WebKit.
   for(const frame of pane.querySelectorAll('iframe')){
    const src=frame.getAttribute('src');if(!src?.startsWith('blob:')||frames.get(frame)===src)continue;
    frames.set(frame,src);
    fetch(src).then(r=>r.text()).then(text=>{
     if(disposed||!frame.isConnected||frame.getAttribute('src')!==src)return;
     const script='<script>('+installPreviewZoom.toString()+')();<'+ '/script>';
     frame.srcdoc=/<\/body>/i.test(text)?text.replace(/<\/body>/i,script+'</body>'):text+script;
    }).catch(()=>frames.delete(frame));
   }
   for(const pdf of pane.querySelectorAll('.react-pdf__Document')){
    const viewport=pdf.closest('.overflow-auto');
    if(viewport&&pane.contains(viewport)&&!cleanups.has(viewport))cleanups.set(viewport,bindPdfTouch(viewport));
   }
   for(const viewport of pane.querySelectorAll('[data-markdown-preview]'))if(!cleanups.has(viewport))cleanups.set(viewport,bindDocumentTouch(viewport));
  }
 }
 const schedule=()=>{if(!scheduled&&!disposed){scheduled=true;queueMicrotask(scan);}};
 const observer=new MutationObserver(schedule);observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','aria-hidden']});
 const resize=new ResizeObserver(schedule);resize.observe(doc.documentElement);
 media.addEventListener('change',schedule);win.addEventListener('resize',schedule);scan();
 return()=>{disposed=true;stopFilePickerAnchor();observer.disconnect();resize.disconnect();win.removeEventListener('resize',schedule);media.removeEventListener('change',schedule);for(const cleanup of cleanups.values())cleanup();cleanups.clear();doc.querySelectorAll('[data-cm-preview-back],[data-cm-preview-page-header]').forEach(e=>e.remove());doc.querySelectorAll('[data-cm-preview-page]').forEach(e=>e.removeAttribute('data-cm-preview-page'));};
}
// Keep ordinary reading on the browser compositor; only a real two-finger
// pinch installs a blocking move listener. Native inertia also works after zoom.
export function bindDocumentTouch(viewport){
 let scale=1,state=null,listening=false;const content=viewport.firstElementChild;if(!content)return()=>{};
 const old=content.style.cssText,action=viewport.style.touchAction;
 const center=t=>({x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2});
 const distance=t=>Math.hypot(t[1].clientX-t[0].clientX,t[1].clientY-t[0].clientY);
 viewport.style.touchAction='pan-x pan-y';
 const release=()=>{state=null;if(listening){viewport.removeEventListener('touchmove',move,true);listening=false;}};
 const start=e=>{
  if(e.touches.length!==2)return;
  if(e.target.closest?.('button,a,input,textarea,select'))return;
  const p=center(e.touches),r=viewport.getBoundingClientRect();content.style.width ||= viewport.clientWidth+'px';
  state={scale,d:Math.max(1,distance(e.touches)),x:(viewport.scrollLeft+p.x-r.left)/scale,y:(viewport.scrollTop+p.y-r.top)/scale};
  if(!listening){viewport.addEventListener('touchmove',move,{passive:false,capture:true});listening=true;}
 };
 const move=e=>{
  if(!state||e.touches.length!==2)return;
  e.preventDefault();scale=Math.max(.2,Math.min(4,state.scale*distance(e.touches)/state.d));
  const p=center(e.touches),r=viewport.getBoundingClientRect();content.style.zoom=String(scale);
  viewport.scrollLeft=state.x*scale-p.x+r.left;viewport.scrollTop=state.y*scale-p.y+r.top;
 };
 const end=e=>{if(e.touches.length!==2)release();};
 viewport.addEventListener('touchstart',start,{passive:true,capture:true});
 viewport.addEventListener('touchend',end,{passive:true,capture:true});
 viewport.addEventListener('touchcancel',release,{passive:true,capture:true});
 return()=>{release();content.style.cssText=old;viewport.style.touchAction=action;viewport.removeEventListener('touchstart',start,true);viewport.removeEventListener('touchend',end,true);viewport.removeEventListener('touchcancel',release,true);};
}

// Feed pinch deltas into the PDF viewer's existing anchored zoom controller.
// Its percent display, buttons, limits, and delayed sharp canvas render stay
// synchronized, while ordinary one-finger scrolling remains native.
export function bindPdfTouch(viewport){
 let state=null,listening=false;const oldAction=viewport.style.touchAction;
 const distance=t=>Math.hypot(t[1].clientX-t[0].clientX,t[1].clientY-t[0].clientY);
 viewport.style.touchAction='pan-x pan-y';
 const release=()=>{state=null;if(listening){viewport.removeEventListener('touchmove',move,true);listening=false;}};
 const start=e=>{
  if(e.touches.length!==2)return;
  state={distance:Math.max(1,distance(e.touches))};
  if(!listening){viewport.addEventListener('touchmove',move,{passive:false,capture:true});listening=true;}
 };
 const move=e=>{
  if(!state||e.touches.length!==2)return;
  e.preventDefault();const next=Math.max(1,distance(e.touches)),ratio=next/state.distance;
  state.distance=next;if(ratio===1)return;
  const Wheel=viewport.ownerDocument.defaultView.WheelEvent;
  viewport.dispatchEvent(new Wheel('wheel',{deltaY:-Math.log(ratio)/0.002,deltaMode:0,ctrlKey:true,metaKey:true,clientX:(e.touches[0].clientX+e.touches[1].clientX)/2,clientY:(e.touches[0].clientY+e.touches[1].clientY)/2,bubbles:true,cancelable:true}));
 };
 const end=e=>{if(e.touches.length!==2)release();};
 viewport.addEventListener('touchstart',start,{passive:true,capture:true});
 viewport.addEventListener('touchend',end,{passive:true,capture:true});
 viewport.addEventListener('touchcancel',release,{passive:true,capture:true});
 return()=>{release();viewport.style.touchAction=oldAction;viewport.removeEventListener('touchstart',start,true);viewport.removeEventListener('touchend',end,true);viewport.removeEventListener('touchcancel',release,true);};
}

// WebKit anchors its native photo/camera/file menu to the file input's box.
// A display:none input has no box, so the native menu can fall back to the
// old selection or viewport center. Give that input the plus button's geometry
// before its click default action, retaining the original React change handler.
export function positionFilePickerAtTrigger(input,trigger){
 const target=trigger.getBoundingClientRect();if(target.width<=0||target.height<=0)return false;
 input.style.setProperty('display','block','important');
 Object.assign(input.style,{position:'absolute',left:'0px',top:'0px',width:target.width+'px',height:target.height+'px',opacity:'0',pointerEvents:'none',margin:'0',padding:'0',border:'0',boxSizing:'border-box'});
 const origin=input.getBoundingClientRect(),sx=origin.width/target.width||1,sy=origin.height/target.height||1;
 input.style.left=(target.left-origin.left)/sx+'px';input.style.top=(target.top-origin.top)/sy+'px';
 input.style.width=target.width/sx+'px';input.style.height=target.height/sy+'px';
 input.getBoundingClientRect();return true;
}
export function installFilePickerAnchors(doc,win){
 const entries=new Map();let pending=false,disposed=false;
 const updateInput=input=>{
  const region=input.closest?.('.chat-composer-region');if(!region||region.closest('[aria-hidden="true"],[inert]'))return;
  const trigger=region.querySelector('button[aria-label="添加上下文"]');if(!trigger||trigger.getBoundingClientRect().width<=0)return;
  if(!entries.has(input)){entries.set(input,{region,style:input.style.cssText,tabindex:input.getAttribute('tabindex'),hidden:input.getAttribute('aria-hidden')});resize.observe(region);}
  if(positionFilePickerAtTrigger(input,trigger)){input.setAttribute('data-cm-file-picker-anchor','');input.setAttribute('aria-hidden','true');input.setAttribute('tabindex','-1');}
 };
 const update=()=>{pending=false;if(disposed)return;for(const input of doc.querySelectorAll('.chat-composer-region input[type="file"]'))updateInput(input);for(const[input,old]of entries)if(!input.isConnected){resize.unobserve(old.region);entries.delete(input);}};
 const schedule=()=>{if(!pending&&!disposed){pending=true;win.requestAnimationFrame(update);}};
 const resize=new ResizeObserver(schedule),observer=new MutationObserver(schedule);
 observer.observe(doc.documentElement,{childList:true,subtree:true});
 const click=e=>{if(e.target?.matches?.('.chat-composer-region input[type="file"]'))updateInput(e.target);};
 doc.addEventListener('click',click,true);win.addEventListener('resize',schedule);win.visualViewport?.addEventListener('resize',schedule);win.visualViewport?.addEventListener('scroll',schedule);update();
 return()=>{disposed=true;resize.disconnect();observer.disconnect();doc.removeEventListener('click',click,true);win.removeEventListener('resize',schedule);win.visualViewport?.removeEventListener('resize',schedule);win.visualViewport?.removeEventListener('scroll',schedule);for(const[input,old]of entries){input.style.cssText=old.style;input.removeAttribute('data-cm-file-picker-anchor');for(const[key,value]of [['tabindex',old.tabindex],['aria-hidden',old.hidden]])value===null?input.removeAttribute(key):input.setAttribute(key,value);}entries.clear();};
}
