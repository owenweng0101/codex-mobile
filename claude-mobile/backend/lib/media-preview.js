/* Full-page preview inside the Claude frame (the parent hub capsule stays visible).
 * Inject before message-renderer.js. installClaudeMediaPreview returns
 * {preview(url,label,image,file), previewImage, close, dispose, element}.
 * PDF defaults to /claude/assets/pdfjs/loader.mjs; window.claudeLoadPdfjs can
 * override the local loader. No CDN or cross-app runtime fallback.
 * HTML keeps the original file endpoint's CSP and opaque allow-scripts sandbox.
 */
(() => {
  'use strict';
  const installations = new WeakMap();

  // Adapted from Codex bindDocumentTouch / DSH installPreviewZoom. This function
  // is also serialized into the opaque HTML iframe, so has no outer references.
  function bindDocumentZoom(viewport, layer, settings = {}) {
    const win = layer.ownerDocument.defaultView, doc = layer.ownerDocument;
    const rootMode = !!settings.documentMode;
    const eventHost = rootMode ? doc : viewport;
    const oldWidth = layer.style.width, oldZoom = layer.style.zoom;
    const oldAction=layer.style.touchAction,oldOverflow=layer.style.overflow;
    if(rootMode){layer.style.touchAction='pan-x pan-y';layer.style.overflow='auto';}
    let scale = 1, pinch = null, gesture = null, lastTap = null, tap = null;
    const removers = [];
    const listen = (target, name, callback, options) => {
      target.addEventListener(name, callback, options);
      removers.push(() => target.removeEventListener(name, callback, options));
    };
    const interactive = target => target.closest?.('a,button,input,textarea,select,[contenteditable],video,audio');
    // Mobile innerWidth expands to include zoomed root overflow. Using it as
    // a rotation signal would immediately undo an HTML pinch.
    const viewportWidth=()=>rootMode?(win.visualViewport?.width||doc.documentElement.clientWidth||win.innerWidth):viewport.clientWidth;
    const center = t => ({x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2});
    const distance = t => Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    const point = p => { const r = rootMode ? {left:0,top:0} : viewport.getBoundingClientRect(); return {x:p.x-r.left,y:p.y-r.top}; };
    const begin = p => {
      const q = point(p);
      layer.style.width ||= viewportWidth()+'px';
      return {scale,x:(viewport.scrollLeft+q.x)/scale,y:(viewport.scrollTop+q.y)/scale};
    };
    const apply = (value, anchor, p) => {
      if (!Number.isFinite(value)) return;
      scale = Math.max(.25,Math.min(6,value));
      layer.style.zoom = String(scale);layer.dataset.claudeZoom = String(scale);
      const q = point(p);
      viewport.scrollLeft = Math.max(0,anchor.x*scale-q.x);
      viewport.scrollTop = Math.max(0,anchor.y*scale-q.y);
    };
    const reset = () => {
      scale=1;pinch=gesture=lastTap=tap=null;layer.style.width=oldWidth;layer.style.zoom=oldZoom;
      layer.dataset.claudeZoom='1';viewport.scrollLeft=viewport.scrollTop=0;
    };
    const options={passive:false,capture:true};
    listen(eventHost,'touchstart',e=>{
      if(e.touches.length===2){e.preventDefault();pinch={...begin(center(e.touches)),distance:Math.max(1,distance(e.touches))};tap=lastTap=null;}
      else if(e.touches.length===1&&!interactive(e.target))tap={x:e.touches[0].clientX,y:e.touches[0].clientY,time:Date.now()};
    },options);
    listen(eventHost,'touchmove',e=>{
      if(tap&&Math.hypot(e.touches[0]?.clientX-tap.x,e.touches[0]?.clientY-tap.y)>8)tap=null;
      if(pinch&&e.touches.length===2){e.preventDefault();apply(pinch.scale*distance(e.touches)/pinch.distance,pinch,center(e.touches));}
    },options);
    listen(eventHost,'touchend',e=>{
      if(e.touches.length<2)pinch=null;
      if(!e.touches.length&&tap&&Date.now()-tap.time<300){
        if(lastTap&&tap.time-lastTap.time<350&&Math.hypot(tap.x-lastTap.x,tap.y-lastTap.y)<24){e.preventDefault();reset();}
        else lastTap=tap;
      }
      tap=null;
    },options);
    listen(eventHost,'touchcancel',()=>{pinch=gesture=lastTap=tap=null;},options);
    listen(eventHost,'gesturestart',e=>{e.preventDefault();gesture=begin({x:e.clientX??win.innerWidth/2,y:e.clientY??win.innerHeight/2});},options);
    listen(eventHost,'gesturechange',e=>{e.preventDefault();if(!pinch&&gesture)apply(gesture.scale*e.scale,gesture,{x:e.clientX??win.innerWidth/2,y:e.clientY??win.innerHeight/2});},options);
    listen(eventHost,'gestureend',e=>{e.preventDefault();gesture=null;},options);
    listen(eventHost,'wheel',e=>{
      if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();
      const p={x:e.clientX,y:e.clientY};apply(scale*Math.exp(-e.deltaY*.002),begin(p),p);
    },options);
    listen(eventHost,'dblclick',e=>{if(!interactive(e.target)){e.preventDefault();reset();}},options);
    // Restore responsive fit on rotation; cancel incomplete gestures as well.
    let width=viewportWidth();
    const resize=()=>{const next=viewportWidth();if(Math.abs(next-width)>1){width=next;reset();}};
    listen(win,'resize',resize);listen(win,'orientationchange',reset);
    const observer=win.ResizeObserver?new win.ResizeObserver(resize):null;observer?.observe(viewport);
    layer.dataset.claudeZoom='1';
    return {reset,zoom:ratio=>{const p=rootMode?{x:win.innerWidth/2,y:win.innerHeight/2}:{x:viewport.getBoundingClientRect().left+viewport.clientWidth/2,y:viewport.getBoundingClientRect().top+viewport.clientHeight/2};apply(scale*ratio,begin(p),p);},dispose:()=>{observer?.disconnect();for(const remove of removers)remove();reset();if(rootMode){layer.style.touchAction=oldAction;layer.style.overflow=oldOverflow;}}};
  }

  function bindImageZoom(stage,image) {
    const win=image.ownerDocument.defaultView, removers=[];
    let scale=1,x=0,y=0,gesture=null,tap=null,lastTap=null,safari=null;
    const pointers=new Map();
    const on=(name,fn,options={passive:false})=>{stage.addEventListener(name,fn,options);removers.push(()=>stage.removeEventListener(name,fn,options));};
    const draw=()=>{
      // Clamp against the actual contained image, excluding object-fit letterbox.
      const fit=Math.min(stage.clientWidth/(image.naturalWidth||stage.clientWidth),stage.clientHeight/(image.naturalHeight||stage.clientHeight));
      const w=(image.naturalWidth||stage.clientWidth)*fit,h=(image.naturalHeight||stage.clientHeight)*fit;
      const lx=Math.max(0,(w*scale-stage.clientWidth)/2),ly=Math.max(0,(h*scale-stage.clientHeight)/2);
      x=Math.max(-lx,Math.min(lx,x));y=Math.max(-ly,Math.min(ly,y));
      image.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';image.dataset.claudeZoom=String(scale);
    };
    const point=points=>{const a=points[0],b=points[1]||a,r=stage.getBoundingClientRect();return {x:(a.clientX+b.clientX)/2-r.left-r.width/2,y:(a.clientY+b.clientY)/2-r.top-r.height/2,d:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),count:points.length};};
    const begin=points=>{gesture=points.length?{...point(points),scale,tx:x,ty:y}:null;};
    const apply=(value,p,g)=>{scale=Math.max(1,Math.min(8,value));const ratio=scale/g.scale;x=p.x-(g.x-g.tx)*ratio;y=p.y-(g.y-g.ty)*ratio;draw();};
    const reset=()=>{scale=1;x=y=0;gesture=tap=lastTap=safari=null;pointers.clear();draw();};
    const start=points=>{begin(points);tap=points.length===1?{...point(points),time:Date.now()}:null;if(points.length>1)lastTap=null;};
    const move=points=>{if(!gesture)return;if(points.length!==gesture.count){begin(points);return;}const p=point(points);if(tap&&Math.hypot(p.x-tap.x,p.y-tap.y)>8)tap=null;apply(points.length>1?gesture.scale*p.d/Math.max(1,gesture.d):gesture.scale,p,gesture);};
    const end=points=>{
      if(!points.length&&tap&&Date.now()-tap.time<300){if(lastTap&&tap.time-lastTap.time<350&&Math.hypot(tap.x-lastTap.x,tap.y-lastTap.y)<24){reset();}else lastTap=tap;}
      tap=null;begin(points);
    };
    // Touch events are the primary iOS path; ignore their synthetic pointers.
    on('touchstart',e=>{e.preventDefault();start([...e.touches]);});
    on('touchmove',e=>{e.preventDefault();move([...e.touches]);});
    on('touchend',e=>{e.preventDefault();end([...e.touches]);});
    on('touchcancel',()=>{gesture=tap=lastTap=safari=null;pointers.clear();});
    on('pointerdown',e=>{if(e.pointerType==='touch'||e.button>0)return;e.preventDefault();pointers.set(e.pointerId,e);stage.setPointerCapture?.(e.pointerId);start([...pointers.values()]);});
    on('pointermove',e=>{if(!pointers.has(e.pointerId))return;e.preventDefault();pointers.set(e.pointerId,e);move([...pointers.values()]);});
    for(const name of ['pointerup','pointercancel','lostpointercapture'])on(name,e=>{if(!pointers.delete(e.pointerId))return;if(name!=='pointerup')tap=lastTap=null;end([...pointers.values()]);});
    on('gesturestart',e=>{e.preventDefault();safari={...point([{clientX:e.clientX??stage.clientWidth/2,clientY:e.clientY??stage.clientHeight/2}]),scale,tx:x,ty:y};});
    on('gesturechange',e=>{e.preventDefault();if(gesture?.count===2||!safari||!Number.isFinite(e.scale))return;apply(safari.scale*e.scale,point([{clientX:e.clientX,clientY:e.clientY}]),safari);});
    on('gestureend',e=>{e.preventDefault();safari=null;});
    on('wheel',e=>{e.preventDefault();const p=point([{clientX:e.clientX,clientY:e.clientY}]);apply(scale*Math.exp(-e.deltaY*.002),p,{...p,scale,tx:x,ty:y});});
    on('dblclick',e=>{e.preventDefault();reset();});on('dragstart',e=>e.preventDefault());
    const observer=win.ResizeObserver?new win.ResizeObserver(()=>{gesture=tap=lastTap=safari=null;draw();}):null;observer?.observe(stage);
    win.addEventListener('resize',draw);image.draggable=false;draw();
    return {reset,zoom:ratio=>apply(scale*ratio,{x:0,y:0},{x:0,y:0,scale,tx:x,ty:y}),dispose:()=>{observer?.disconnect();win.removeEventListener('resize',draw);for(const remove of removers)remove();reset();}};
  }

  // Server helper reuses this exact function in the authorized file response.
  window.claudeHtmlPreviewBootstrap = token => '(()=>{const zoom=('+bindDocumentZoom.toString()+')(document.scrollingElement,document.documentElement,{documentMode:true});const token='+JSON.stringify(token)+';window.addEventListener("message",e=>{if(e.source!==parent||e.data?.token!==token)return;if(e.data.type==="claude-preview-reset")zoom.reset();if(e.data.type==="claude-preview-zoom")zoom.zoom(e.data.ratio);});parent.postMessage({type:"claude-preview-ready",token},"*");})();';

  window.installClaudeMediaPreview = function installClaudeMediaPreview(options = {}) {
    const doc=options.doc||document,win=doc.defaultView||window;
    const key=options.viewer||doc;
    if(installations.has(key))return installations.get(key);
    const make=(tag,className,text)=>{const e=doc.createElement(tag);if(className)e.className=className;if(text!=null)e.textContent=text;return e;};
    const ownsViewer=!options.viewer;
    const viewer=options.viewer||make('section','file-view hidden');
    const bar=options.bar||make('div','file-bar'),title=options.title||make('strong');
    const closeButton=options.closeButton||make('button','','关闭');closeButton.type='button';closeButton.setAttribute('aria-label','关闭文件预览');
    const content=options.content||make('div','file-content');
    if(ownsViewer){bar.append(title,closeButton);viewer.append(bar,content);doc.body.append(viewer);}
    viewer.dataset.claudeMediaPreview='';viewer.setAttribute('aria-label','文件预览');viewer.setAttribute('role','dialog');viewer.tabIndex=-1;
    const style=make('style');style.textContent=`
      [data-claude-media-preview]{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;background:var(--surface,#fff);color:var(--text,#111);overflow:hidden}
      [data-claude-media-preview].hidden{display:none!important}
      [data-claude-media-preview] [hidden]{display:none!important}
      [data-claude-media-preview] .file-bar{display:flex;align-items:center;gap:8px;min-height:48px;height:auto;flex:none;padding:0 12px;border-bottom:.5px solid var(--line,#ddd)}
      [data-claude-media-preview] .file-bar strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}
      [data-claude-media-preview] button{font:inherit;color:inherit;cursor:pointer}
      [data-claude-media-preview] .file-bar button{min-height:44px;min-width:44px}
      [data-claude-media-preview] .file-content{position:relative;flex:1;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;touch-action:pan-x pan-y;padding:0 0 env(safe-area-inset-bottom);-webkit-overflow-scrolling:touch}
      [data-claude-media-preview] .file-content[data-kind=image],[data-claude-media-preview] .file-content[data-kind=html]{overflow:hidden;padding:0}
      [data-claude-media-preview] .image-stage{position:absolute;inset:0;overflow:hidden;touch-action:none;display:grid;place-items:center}
      [data-claude-media-preview] .image-stage img{display:block;width:100%;height:100%;max-width:none;object-fit:contain;transform-origin:center;user-select:none;-webkit-user-drag:none}
      [data-claude-media-preview] iframe{display:block;width:100%;height:100%;border:0;background:white}
      [data-claude-media-preview] .preview-controls{display:flex;flex:none;gap:0}
      [data-claude-media-preview] .preview-status{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;color:var(--muted,#666)}
      [data-claude-media-preview] .preview-status button{min-height:44px;padding:8px 16px;border:1px solid var(--line,#ddd);border-radius:8px;background:var(--surface,#fff)}
      [data-claude-media-preview] .preview-loading{position:absolute;inset:0;z-index:1;pointer-events:none;background:var(--surface,#fff)}
      [data-claude-media-preview] .markdown-preview{display:block;max-width:none;min-width:0;min-height:100%;padding:20px 24px;white-space:normal;overflow-wrap:anywhere;font-size:15px;line-height:1.75}
      [data-claude-media-preview] pre{margin:0;padding:20px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 ui-monospace,monospace}
      [data-claude-media-preview] .markdown-preview pre{overflow:auto;white-space:pre}
      [data-claude-media-preview] .markdown-preview img{max-width:100%;height:auto}
      [data-claude-media-preview] .preview-pdf{padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px}
      [data-claude-media-preview] .preview-pdf-page{position:relative;flex:none;max-width:100%;background:white;box-shadow:0 1px 6px #0002}
      [data-claude-media-preview] canvas{display:block;width:100%;height:100%}
      [data-claude-media-preview] .preview-pdf-page .preview-status{position:absolute;inset:0;font-size:13px}
    `;(doc.head||doc.body).append(style);
    const controls=make('div','preview-controls');controls.setAttribute('aria-label','预览缩放');
    let zoom=null;
    for(const [text,label,action] of [['−','缩小预览',()=>zoom?.zoom(1/1.5)],['适应','适应屏幕',()=>zoom?.reset()],['+','放大预览',()=>zoom?.zoom(1.5)]]){const b=make('button','',text);b.type='button';b.setAttribute('aria-label',label);b.onclick=action;controls.append(b);}
    bar.insertBefore(controls,closeButton);
    let current=null,disposed=false,fallbackFocus=null,inertBefore=[];
    const modal=options.modal||win.claudeModal;
    const status=(text,retry)=>{const box=make('div','preview-status');box.setAttribute('role','status');box.append(make('p','',text));if(retry){const b=make('button','preview-retry','重试');b.type='button';b.onclick=()=>retry();box.append(b);}return box;};
    const live=s=>current===s&&!s.controller.signal.aborted&&!disposed;
    const cleanup=()=>{
      const old=current;current=null;zoom=null;
      if(old){old.controller.abort();clearTimeout(old.timer);for(const stop of old.cleanups.splice(0))try{stop();}catch{}}
      content.replaceChildren();content.scrollLeft=content.scrollTop=0;content.removeAttribute('data-kind');content.removeAttribute('aria-busy');controls.hidden=true;
    };
    const close=()=>{
      cleanup();viewer.classList.add('hidden');viewer.removeAttribute('aria-modal');
      if(modal)modal.close(viewer);else{for(const [child,inert] of inertBefore)child.inert=inert;inertBefore=[];if(fallbackFocus?.isConnected)fallbackFocus.focus();}
    };
    const openModal=()=>{
      const wasHidden=viewer.classList.contains('hidden');viewer.classList.remove('hidden');viewer.setAttribute('aria-modal','true');
      if(modal)modal.open(viewer,close,closeButton);
      else if(wasHidden){fallbackFocus=doc.activeElement;for(const child of doc.body.children)if(child!==viewer&&child.tagName!=='SCRIPT'&&child.tagName!=='STYLE'){inertBefore.push([child,child.inert]);child.inert=true;}closeButton.focus();}
    };
    const finish=s=>{if(!live(s))return;clearTimeout(s.timer);content.removeAttribute('aria-busy');s.loading?.remove();};
    const fail=(s,error)=>{
      if(!live(s))return;clearTimeout(s.timer);s.controller.abort();for(const stop of s.cleanups.splice(0))try{stop();}catch{}
      zoom=null;controls.hidden=true;content.removeAttribute('aria-busy');content.replaceChildren(status(error,s.retry));
    };
    const timed=(s,operation)=>{
      const signal=s.controller.signal;
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(Object.assign(new Error('预览已取消'),{name:'AbortError'}));
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        Promise.resolve(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      });
    };
    const loading=(s,text)=>{const box=status(text);box.classList.add('preview-loading');content.append(box);s.loading=box;};
    const attachZoom=(s,controller)=>{zoom=controller;controls.hidden=false;s.cleanups.push(()=>controller.dispose());};
    const request=options.request||((...args)=>win.fetch(...args));
    const validateUrl=(url,image)=>{
      const u=new URL(url,win.location.href);
      if(image&&u.protocol==='blob:'&&u.origin===win.location.origin)return u.href;
      if(!['https:','http:'].includes(u.protocol))throw Error('不支持的文件地址');
      if(!image&&(u.origin!==win.location.origin||u.pathname!=='/claude/api/file'))throw Error('只能预览当前会话引用的文件');
      return u.href;
    };
    function imagePreview(s,url,label) {
      content.dataset.kind='image';const stage=make('div','image-stage'),image=make('img');image.alt=label||'图片';stage.append(image);content.append(stage);loading(s,'图片加载中…');
      attachZoom(s,bindImageZoom(stage,image));
      image.onload=()=>{if(live(s)){zoom?.reset();finish(s);}};
      image.onerror=()=>fail(s,'图片加载失败，请重试');
      s.cleanups.push(()=>{image.onload=image.onerror=null;image.removeAttribute('src');});image.src=url;
    }
    function htmlPreview(s,source,label) {
      content.dataset.kind='html';const frame=make('iframe');frame.title=label||'HTML 预览';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
      const token=win.crypto?.randomUUID?.()||String(Date.now())+Math.random().toString(36).slice(2);
      const url=new URL(source);url.searchParams.set('preview','html');url.searchParams.set('previewToken',token);
      const receive=e=>{if(live(s)&&e.source===frame.contentWindow&&e.data?.token===token&&e.data?.type==='claude-preview-ready')finish(s);};
      win.addEventListener('message',receive);s.cleanups.push(()=>{win.removeEventListener('message',receive);frame.onerror=null;frame.removeAttribute('src');frame.remove();});
      const post=(type,ratio)=>{if(live(s))frame.contentWindow?.postMessage({type,token,ratio},'*');};
      attachZoom(s,{reset:()=>post('claude-preview-reset'),zoom:ratio=>post('claude-preview-zoom',ratio),dispose:()=>{}});
      frame.onerror=()=>fail(s,'网页预览加载失败，请重试');
      // Keep the file response's own CSP (srcdoc would inherit the stricter
      // Claude page policy). The server injects claudeHtmlPreviewBootstrap.
      frame.src=url.href;content.append(frame);loading(s,'网页加载中…');
    }
    async function pdfPreview(s,response) {
      const bytes=await timed(s,response.arrayBuffer());if(!live(s))return;
      const pdfjs=await timed(s,options.loadPdfjs?options.loadPdfjs():win.claudeLoadPdfjs?win.claudeLoadPdfjs():import('/claude/assets/pdfjs/loader.mjs').then(module=>module.loadPdfjs()));
      if(!live(s))return;if(!pdfjs?.getDocument)throw Error('PDF 渲染器暂不可用，请重新加载后重试');
      const task=pdfjs.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,enableXfa:false});
      s.cleanups.push(()=>{Promise.resolve(task.destroy?.()).catch(()=>{});});
      const pdf=await timed(s,task.promise);if(!live(s))return;
      if(!pdf.numPages)throw Error('PDF 没有可显示的页面');
      const first=await timed(s,pdf.getPage(1));if(!live(s))return;
      content.replaceChildren();content.dataset.kind='pdf';
      const layer=make('div','preview-pdf');layer.setAttribute('aria-label','PDF，共 '+pdf.numPages+' 页');content.append(layer);
      const firstViewport=first.getViewport({scale:1});
      let width=Math.max(100,content.clientWidth-24),rendering=new Set();
      const slots=[];
      const render=async(slot,index)=>{
        if(!live(s)||slot.dataset.rendered||rendering.has(slot))return;
        rendering.add(slot);slot.replaceChildren(status('第 '+index+' 页加载中…'));
        try{
          const page=index===1?first:await timed(s,pdf.getPage(index));if(!live(s))return;
          const viewport=page.getViewport({scale:width/page.getViewport({scale:1}).width});
          slot.style.height=viewport.height+'px';const canvas=make('canvas');canvas.setAttribute('aria-label','PDF 第 '+index+' 页');
          // A bounded pixel budget keeps large pages usable on mobile Safari.
          const dpr=Math.max(1,Math.min(win.devicePixelRatio||1,2,Math.sqrt(4e6/(viewport.width*viewport.height))));
          canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);
          const renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});
          const cancel=()=>renderTask.cancel?.();s.cleanups.push(cancel);
          try{await timed(s,renderTask.promise);}finally{const i=s.cleanups.indexOf(cancel);if(i>=0)s.cleanups.splice(i,1);}
          if(!live(s))return;slot.replaceChildren(canvas);slot.dataset.rendered='true';
        }catch(error){if(live(s))slot.replaceChildren(status('第 '+index+' 页加载失败',()=>{delete slot.dataset.rendered;void render(slot,index);}));}
        finally{rendering.delete(slot);}
      };
      for(let i=1;i<=pdf.numPages;i++){const slot=make('div','preview-pdf-page');slot.style.width='100%';slot.style.height=(width*firstViewport.height/firstViewport.width)+'px';slot.setAttribute('aria-label','第 '+i+' 页');slots.push(slot);layer.append(slot);}
      attachZoom(s,bindDocumentZoom(content,layer));
      const observer=win.IntersectionObserver?new win.IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)void render(e.target,slots.indexOf(e.target)+1);},{root:content,rootMargin:'600px'}):null;
      if(observer){s.cleanups.push(()=>observer.disconnect());for(const slot of slots)observer.observe(slot);}
      else {const scroll=()=>{const r=content.getBoundingClientRect();slots.forEach((slot,i)=>{const p=slot.getBoundingClientRect();if(p.bottom>=r.top-600&&p.top<=r.bottom+600)void render(slot,i+1);});};content.addEventListener('scroll',scroll,{passive:true});s.cleanups.push(()=>content.removeEventListener('scroll',scroll));scroll();}
      await render(slots[0],1);if(!live(s))return;finish(s);
      // Width stays responsive after rotation; existing canvases retain their
      // aspect ratio while visible pages are repainted to the new fit width.
      const resize=()=>{const next=Math.max(100,content.clientWidth-24);if(next===width)return;width=next;zoom?.reset();for(const slot of slots){if(rendering.has(slot))continue;delete slot.dataset.rendered;slot.style.height=(width*firstViewport.height/firstViewport.width)+'px';}void render(slots[0],1);if(observer){observer.disconnect();for(const slot of slots)observer.observe(slot);}};
      const ro=win.ResizeObserver?new win.ResizeObserver(resize):null;ro?.observe(content);win.addEventListener('resize',resize);s.cleanups.push(()=>{ro?.disconnect();win.removeEventListener('resize',resize);});
    }
    async function preview(url,label,image=false,file=null) {
      if(disposed)return;
      cleanup();const s={controller:new win.AbortController(),cleanups:[],retry:()=>preview(url,label,image,file)};current=s;
      title.textContent=label||'文件预览';content.setAttribute('aria-busy','true');content.append(status('正在读取…'));openModal();
      s.timer=setTimeout(()=>fail(s,'预览加载超时，请重试'),options.timeoutMs||20000);
      try{
        const source=validateUrl(url,image);
        if(image){content.replaceChildren();imagePreview(s,source,label);return;}
        const response=await timed(s,request(source,{credentials:'same-origin',signal:s.controller.signal}));if(!live(s))return;
        if(!response.ok){await response.body?.cancel?.();throw Error('文件无法读取（'+response.status+'）');}
        const type=(response.headers.get('content-type')||'').toLowerCase();
        if(type.startsWith('image/')){await response.body?.cancel?.();if(!live(s))return;content.replaceChildren();imagePreview(s,source,label);return;}
        if(type.includes('pdf')){await pdfPreview(s,response);return;}
        if(type.includes('text/html')){await response.body?.cancel?.();if(!live(s))return;content.replaceChildren();htmlPreview(s,source,label);return;}
        const text=await timed(s,response.text());if(!live(s))return;content.replaceChildren();
        const markdown=type.includes('text/markdown')||type.includes('text/x-markdown')||/\.(md|markdown)$/i.test(file?.path||'');
        content.dataset.kind=markdown?'markdown':'text';const layer=make(markdown?'article':'pre',markdown?'markdown-preview bubble':'');content.append(layer);
        if(markdown&&(options.renderMarkdown||win.claudeRender))(options.renderMarkdown||win.claudeRender)(layer,text,file?.session,file?.path);else layer.textContent=text;
        attachZoom(s,bindDocumentZoom(content,layer));finish(s);
      }catch(error){if(live(s)&&error.name!=='AbortError')fail(s,error.message||'预览加载失败，请重试');}
    }
    const previousClose=closeButton.onclick;closeButton.onclick=close;
    const keydown=e=>{if(viewer.classList.contains('hidden')||modal)return;if(e.key==='Escape'){e.preventDefault();close();}else if(e.key==='Tab'){const targets=[...viewer.querySelectorAll('button:not(:disabled),a[href],iframe,[tabindex="0"]')].filter(e=>e.getClientRects().length);const first=targets[0]||viewer,last=targets.at(-1)||first;if(e.shiftKey&&doc.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&doc.activeElement===last){e.preventDefault();first.focus();}}};
    doc.addEventListener('keydown',keydown,true);
    const api={preview,previewImage:(url,label)=>preview(url,label||'图片预览',true),close,element:viewer,dispose:()=>{if(disposed)return;close();disposed=true;doc.removeEventListener('keydown',keydown,true);closeButton.onclick=previousClose;controls.remove();style.remove();delete viewer.dataset.claudeMediaPreview;if(ownsViewer)viewer.remove();installations.delete(key);}};
    installations.set(key,api);return api;
  };
})();
