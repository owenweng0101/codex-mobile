/* Markdown rendering and in-frame file preview, shared by history and streaming. */
(() => {
  window.claudeToolName = name => {
    const labels = {Bash:'运行命令',Read:'读取文件',Write:'写入文件',Edit:'编辑文件',Glob:'查找文件',Grep:'搜索内容',WebFetch:'读取网页',WebSearch:'搜索网页',TodoWrite:'更新待办',Agent:'调用智能体'};
    return labels[name] || name.replace(/^mcp__.*?__/, '').replace(/_/g,' ');
  };
  let activeModal=null,restoreFocus=null,inertBefore=[];
  window.claudeModal={
    open(element,onClose,focusTarget){
      if(activeModal?.element===element){focusTarget?.focus();return;}
      if(activeModal) activeModal.onClose();
      restoreFocus=document.activeElement;inertBefore=[];
      for(const child of document.body.children){if(child!==element&&child.tagName!=='SCRIPT'){inertBefore.push([child,child.inert]);child.inert=true;}}
      activeModal={element,onClose};element.setAttribute('role','dialog');element.setAttribute('aria-modal','true');element.tabIndex=-1;
      (focusTarget||element.querySelector('button:not(:disabled)')||element).focus();
    },
    close(element){
      if(activeModal?.element!==element)return;
      activeModal=null;for(const [child,inert] of inertBefore)child.inert=inert;
      inertBefore=[];if(restoreFocus?.isConnected)restoreFocus.focus();
    }
  };
  document.addEventListener('keydown',event=>{
    if(!activeModal)return;
    if(event.key==='Escape'){event.preventDefault();activeModal.onClose();return;}
    if(event.key==='Tab'){
      const targets=[...activeModal.element.querySelectorAll('button:not(:disabled),a[href],input,textarea,iframe,[tabindex="0"]')].filter(e=>e.getClientRects().length);
      const first=targets[0]||activeModal.element,last=targets.at(-1)||first;
      if(event.shiftKey&&(document.activeElement===first||document.activeElement===activeModal.element)){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!activeModal.element.contains(document.activeElement))){event.preventDefault();first.focus();}
    }
  },true);
  const allowed = new Set('P BR STRONG EM DEL H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE HR TABLE THEAD TBODY TR TH TD A IMG'.split(' '));
  const viewer = document.createElement('section'); viewer.className='file-view hidden'; viewer.setAttribute('role','dialog'); viewer.setAttribute('aria-label','文件预览');
  const bar=document.createElement('div');bar.className='file-bar';
  const title=document.createElement('strong');
  const close=document.createElement('button');close.type='button';close.textContent='关闭';
  const content=document.createElement('div');content.className='file-content';
  bar.append(title,close);viewer.append(bar,content);document.body.append(viewer);
  let previewVersion=0, previewController=null, previewTimer=null, mediaPreview=null;
  const dismiss=()=>{previewVersion++;clearTimeout(previewTimer);previewController?.abort();viewer.classList.add('hidden');content.replaceChildren();window.claudeModal.close(viewer);};
  close.onclick=dismiss;
  function localPath(value){
    if(!value||value.startsWith('#'))return null;
    let path=value.replace(/^file:\/\//i,'').split(/[?#]/,1)[0];
    if(/^[a-z][a-z\d+.-]*:/i.test(path))return null;
    path=path.replace(/:\d+(?::\d+)?$/,'');
    try{path=decodeURIComponent(path);}catch{}
    return path.includes('\0')?null:path;
  }
  function fileUrl(path,session,base){return '/claude/api/file?session='+encodeURIComponent(session||'')+'&path='+encodeURIComponent(path)+(base?'&base='+encodeURIComponent(base):'');}
  // Keep relative bases relative to the session cwd; the server resolves and authorizes them.
  function documentPath(path,base){return base&&!/^(\/|~\/)/.test(path)?base.slice(0,base.lastIndexOf('/')+1)+path:path;}
  function status(message,retry){
    const box=document.createElement('div');box.className='preview-status';box.setAttribute('role','status');
    const text=document.createElement('p');text.textContent=message;box.append(text);
    if(retry){const button=document.createElement('button');button.type='button';button.className='preview-retry';button.textContent='重试';button.onclick=event=>{event.preventDefault();event.stopPropagation();return retry();};box.append(button);}
    return box;
  }
  function showImage(url,label,version){
    const stage=document.createElement('div');stage.className='image-stage';
    const img=document.createElement('img');img.alt=label;img.draggable=false;
    const loading=status('图片加载中…');loading.classList.add('media-status');
    let scale=1,x=0,y=0,gesture=null;const pointers=new Map();
    const draw=()=>{img.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';};
    const begin=()=>{const points=[...pointers.values()];gesture=points.length===2?{distance:Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y),scale,x,y,mx:(points[0].x+points[1].x)/2,my:(points[0].y+points[1].y)/2}:points.length===1?{px:points[0].x,py:points[0].y,x,y}:null;};
    stage.onpointerdown=e=>{pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});stage.setPointerCapture(e.pointerId);begin();};
    stage.onpointermove=e=>{if(!pointers.has(e.pointerId))return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});const points=[...pointers.values()];if(points.length===2&&gesture?.distance){scale=Math.max(1,Math.min(6,gesture.scale*Math.hypot(points[0].x-points[1].x,points[0].y-points[1].y)/gesture.distance));x=gesture.x+(points[0].x+points[1].x)/2-gesture.mx;y=gesture.y+(points[0].y+points[1].y)/2-gesture.my;}else if(points.length===1&&gesture&&scale>1){x=gesture.x+points[0].x-gesture.px;y=gesture.y+points[0].y-gesture.py;}if(scale===1){x=0;y=0;}draw();};
    stage.onpointerup=stage.onpointercancel=e=>{pointers.delete(e.pointerId);begin();};
    const controls=document.createElement('div');controls.className='image-controls';
    for(const [text,label,action] of [['−','缩小图片',()=>scale=Math.max(1,scale/1.5)],['适应','图片适应屏幕',()=>scale=1],['+','放大图片',()=>scale=Math.min(6,scale*1.5)]]){
      const button=document.createElement('button');button.type='button';button.textContent=text;button.setAttribute('aria-label',label);button.onclick=()=>{action();if(scale===1){x=0;y=0;}draw();};controls.append(button);
    }
    stage.ondblclick=()=>{scale=1;x=0;y=0;draw();};
    const failed=message=>{if(version!==previewVersion||!img.isConnected)return;clearTimeout(previewTimer);content.replaceChildren(status(message,()=>preview(url,label,true)));};
    img.onload=()=>{if(version!==previewVersion||!img.isConnected)return;clearTimeout(previewTimer);loading.remove();};
    img.onerror=()=>failed('图片加载失败');
    stage.append(img);content.append(stage,controls,loading);
    previewTimer=setTimeout(()=>failed('图片仍未加载，请重试'),15000);img.src=url;
  }
  function showFrame(url,label,type,version,retry){
    const frame=document.createElement('iframe');frame.title=label;frame.setAttribute('sandbox',type.includes('text/html')?'allow-scripts':'');
    const loading=status('预览加载中…');loading.classList.add('media-status');
    frame.onload=()=>{if(version!==previewVersion||!frame.isConnected)return;clearTimeout(previewTimer);loading.remove();};
    frame.onerror=()=>{if(version!==previewVersion||!frame.isConnected)return;clearTimeout(previewTimer);content.replaceChildren(status('预览加载失败',retry));};
    // Opaque sandbox frames cannot expose their document/status. A late load can still recover.
    previewTimer=setTimeout(()=>{if(version!==previewVersion||!frame.isConnected)return;loading.replaceChildren(...status('预览仍未完成加载，可重试',retry).childNodes);},15000);
    frame.src=url;content.append(frame,loading);
  }
  async function preview(url,label,image=false,file=null){
    if(mediaPreview)return mediaPreview.preview(url,label,image,file);
    const version=++previewVersion;clearTimeout(previewTimer);previewController?.abort();
    const controller=new AbortController();previewController=controller;let readTimer=null,timedOut=false;
    const retry=()=>preview(url,label,image,file);
    title.textContent=label||'文件预览';content.textContent='正在读取…';viewer.classList.remove('hidden');window.claudeModal.open(viewer,dismiss,close);
    try{
      if(image){content.replaceChildren();showImage(url,label,version);return;}
      previewTimer=readTimer=setTimeout(()=>{timedOut=true;controller.abort();},15000);
      const response=await fetch(url,{credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error('文件无法读取（'+response.status+'）');
      const type=(response.headers.get('content-type')||'').toLowerCase();if(version!==previewVersion)return;
      if(type.startsWith('image/')){clearTimeout(readTimer);content.replaceChildren();showImage(url,label,version);}
      else if(type.includes('pdf')||type.includes('text/html')){clearTimeout(readTimer);content.replaceChildren();showFrame(url,label,type,version,retry);}
      else{
        const text=await response.text();if(version!==previewVersion)return;content.replaceChildren();
        if(type.includes('text/markdown')||type.includes('text/x-markdown')||/\.(md|markdown)$/i.test(file?.path||'')){
          const article=document.createElement('article');article.className='markdown-preview bubble';
          window.claudeRender(article,text,file?.session,file?.path);content.append(article);
        }else{const pre=document.createElement('pre');pre.textContent=text;content.append(pre);}
      }
    }catch(e){if(version===previewVersion&&(timedOut||e.name!=='AbortError'))content.replaceChildren(status(timedOut?'文件读取超时，请重试':e.message,retry));}
    finally{clearTimeout(readTimer);if(previewTimer===readTimer)previewTimer=null;}
  }
  window.claudePreviewImage=(url,label)=>preview(url,label||'图片预览',true);
  window.claudeRender=(container,text,session,base)=>{
    const doc=new DOMParser().parseFromString(marked.parse(String(text),{breaks:true,gfm:true}),'text/html');
    for(const node of [...doc.body.querySelectorAll('*')]){
      if(node.tagName==='INPUT'&&node.getAttribute('type')==='checkbox'){const mark=document.createElement('span');mark.textContent=node.hasAttribute('checked')?'☑ ':'☐ ';node.replaceWith(mark);continue;}
      if(!allowed.has(node.tagName)){node.replaceWith(document.createTextNode(node.textContent));continue;}
      const href=node.getAttribute('href'),src=node.getAttribute('src'),alt=node.getAttribute('alt');
      for(const attr of [...node.attributes])node.removeAttribute(attr.name);
      if(node.tagName==='A'){
        if(!href)continue;
        if(/^https?:\/\//i.test(href)){node.href=href;node.target='_blank';node.rel='noopener noreferrer';}
        else if(href.startsWith('#')){node.href=href;}
        else if(localPath(href)!==null){
          const path=localPath(href);node.href='#';node.className='file-link';node.title=path;
          const label=node.textContent||path.split('/').pop();
          if(!node.querySelector('img')){node.replaceChildren();const span=document.createElement('span');span.textContent=label;node.append(span);}
          node.onclick=e=>{e.preventDefault();return preview(fileUrl(path,session,base),label,/\.(png|jpe?g|webp|gif|svg)$/i.test(path),{path:documentPath(path,base),session});};
        }
      }
      if(node.tagName==='IMG'&&src){
        const path=localPath(src),url=/^https?:\/\//i.test(src)?src:path!==null?fileUrl(path,session,base):null;
        if(url){
          node.alt=alt||'图片';node.loading='lazy';let error=null;
          node.onerror=()=>{if(!node.isConnected||error)return;node.hidden=true;error=status('图片加载失败：'+node.alt,()=>{node.hidden=false;error.remove();error=null;node.removeAttribute('src');node.src=url;});error.classList.add('inline-image-error');node.after(error);};
          node.onload=()=>{node.hidden=false;error?.remove();error=null;};
          node.onclick=()=>{if(!node.closest('a.file-link'))preview(url,node.alt,true);};node.src=url;
        }
      }
    }
    for(const table of doc.body.querySelectorAll('table')){const wrap=doc.createElement('div');wrap.className='table-scroll';table.replaceWith(wrap);wrap.append(table);}
    container.replaceChildren(...doc.body.childNodes);
  };
  // The optional module owns this existing full-page surface. Keep the renderer
  // fallback usable when an older cached page has not received the module yet.
  if(typeof window.installClaudeMediaPreview==='function'){
    mediaPreview=window.installClaudeMediaPreview({viewer,bar,title,closeButton:close,content,modal:window.claudeModal,
      renderMarkdown:(...args)=>window.claudeRender(...args)});
  }
  window.claudeClosePreview=()=>mediaPreview?mediaPreview.close():dismiss();
})();
