// Opt-in real Chromium checks in one isolated Ego Space. No production data.
// CLAUDE_PREVIEW_BROWSER_TEST=1 node --test test/media-preview.browser.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {injectHtmlPreview} from '../backend/lib/html-preview.mjs';

function pdfFixture(){
  const stream=n=>`0.1 0.7 0.3 rg 30 30 300 300 re f BT /F1 26 Tf 40 500 Td (PAGE-${n}-END) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',...['1','2'].map(n=>`<< /Length ${Buffer.byteLength(stream(n))} >>\nstream\n${stream(n)}\nendstream`)];
  let text='%PDF-1.7\n',offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const xref=Buffer.byteLength(text);text+=`xref\n0 8\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('');
  return Buffer.from(text+`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}

test('real PDF painting, HTML sandbox/zoom, image touch and preview lifecycle',{skip:process.env.CLAUDE_PREVIEW_BROWSER_TEST!=='1',timeout:120000},async()=>{
  const root=new URL('../backend/',import.meta.url);
  const image='<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#9ce4ae"/><text x="40" y="200" font-size="80">IMAGE</text></svg>';
  const html='<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>HTML START</h1>'+Array.from({length:100},(_,i)=>'<p>段落 '+i+'</p>').join('')+'<p>HTML END</p><script>try{parent.document.body;window.boundary=false}catch{window.boundary=true};window.trace=[];for(const type of ["touchstart","touchmove","touchend","resize"])window.addEventListener(type,e=>window.trace.push([type,e.touches?.length,document.documentElement.dataset.claudeZoom]));const send=()=>parent.postMessage({fixture:true,trace:window.trace,iw:innerWidth,vw:visualViewport?.width,style:document.documentElement.style.cssText,boundary:window.boundary,zoom:document.documentElement.dataset.claudeZoom,scroll:scrollY,height:document.scrollingElement.scrollHeight,end:document.body.textContent.includes("HTML END")},"*");window.addEventListener("load",send);requestAnimationFrame(send);window.addEventListener("scroll",send);document.addEventListener("touchend",()=>setTimeout(send,0));send();</script></body></html>';
  const csp="default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'";
  const fileCsp="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; base-uri 'none'; form-action 'none'";
  let failImage=false;
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://local');
    const send=(type,body,policy=csp)=>{res.writeHead(200,{'content-type':type.startsWith('text/')?type+'; charset=utf-8':type,'content-security-policy':policy,'cache-control':'no-store'});res.end(body);};
    if(url.pathname==='/')return send('text/html','<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}nav{height:34px}iframe{width:100%;height:calc(100% - 34px);border:0;display:block}</style><nav>Codex　DSH　Claude</nav><iframe id="claude" src="/chat"></iframe>');
    if(url.pathname==='/chat')return send('text/html','<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}.hidden{display:none}</style><button id="trigger">打开</button><main id="message"></main><script src="/marked.js"></script><script src="/media-preview.js"></script><script src="/message-renderer.js"></script>');
    const scripts={'/marked.js':'vendor/marked.umd.js','/media-preview.js':'lib/media-preview.js','/message-renderer.js':'lib/message-renderer.js'};
    if(scripts[url.pathname])return send('text/javascript',readFileSync(new URL(scripts[url.pathname],root)));
    if(url.pathname.startsWith('/claude/assets/pdfjs/'))return send('text/javascript',readFileSync(new URL('vendor/pdfjs/'+url.pathname.split('/').pop(),root)));
    if(url.pathname==='/image.svg'){if(failImage){res.writeHead(404);return res.end();}return send('image/svg+xml',image);}
    if(url.pathname==='/toggle-image'){failImage=!failImage;return send('text/plain','ok');}
    if(url.pathname==='/claude/api/file'){
      const path=url.searchParams.get('path');
      if(path==='bad'){res.writeHead(403);return res.end('denied');}
      if(path==='slow'){setTimeout(()=>send('text/plain','obsolete'),300);return;}
      if(path==='pdf')return send('application/pdf',pdfFixture(),fileCsp);
      if(path==='html')return send('text/html',url.searchParams.get('preview')==='html'?injectHtmlPreview(html,url.searchParams.get('previewToken')):html,fileCsp);
      if(path==='markdown')return send('text/markdown','# 可读文档\n\n'+Array.from({length:100},(_,i)=>'段落 '+i+'\n\n').join('')+'[嵌套](next.md)');
      return send('text/plain','纯文本\n'+'读内容\n'.repeat(300));
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const script=`
    const task=await taskSpace("Claude media preview isolated verification");
    console.log("SPACE",task.spaceId);
    try {
      const page=task.page("p1");
      await page.cdp("Emulation.setDeviceMetricsOverride",{width:393,height:852,deviceScaleFactor:2,mobile:true});
      await page.cdp("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:5});
      await page.goto(${JSON.stringify(origin)});
      await page.waitForFunction(()=>document.querySelector('#claude')?.contentWindow.installClaudeMediaPreview);
      const result=await page.evaluate(async()=>{
        const checks=[];const check=(ok,message)=>{if(!ok)throw Error(message);checks.push(message);};
        const wait=async(fn)=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('wait timed out: '+fn);};
        check(innerWidth===393,'393px viewport asserted');
        const w=document.querySelector('#claude').contentWindow,d=w.document;
        const viewer=d.querySelector('.file-view'),content=viewer.querySelector('.file-content');
        const api=w.installClaudeMediaPreview({viewer});
        check(d.querySelectorAll('.file-view').length===1,'renderer reuses one full-page viewer');
        const url=path=>'/claude/api/file?session=fixture&path='+path;
        const touch=(target,type,points)=>{const e=new w.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:points.map(([clientX,clientY])=>({clientX,clientY}))});target.dispatchEvent(e);};
        d.querySelector('#trigger').focus();
        await w.claudePreviewImage('/image.svg','测试图');
        await wait(()=>content.querySelector('img')?.naturalWidth>0&&!content.hasAttribute('aria-busy'));
        check(viewer.getBoundingClientRect().width===393&&viewer.getBoundingClientRect().height>750,'preview fills child frame below hub capsule');
        let stage=content.querySelector('.image-stage'),img=stage.querySelector('img');
        touch(stage,'touchstart',[[100,240],[200,240]]);touch(stage,'touchmove',[[50,240],[250,240]]);
        check(+img.dataset.claudeZoom===2,'image touch pinch scales to 2x');
        const beforePan=parseFloat(img.style.transform.slice(10));
        touch(stage,'touchend',[[250,240]]);touch(stage,'touchmove',[[290,260]]);touch(stage,'touchend',[]);
        check(Math.abs(parseFloat(img.style.transform.slice(10))-beforePan-40)<1,'image one-finger pan after pinch');
        stage.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));check(img.dataset.claudeZoom==='1','image double click restores fit');
        for(let n=0;n<2;n++){touch(stage,'touchstart',[[120,260]]);touch(stage,'touchend',[]);}check(img.dataset.claudeZoom==='1','image double tap restores fit');
        api.close();check(d.activeElement.id==='trigger'&&!d.querySelector('#message').inert,'close restores focus and inert state');
        await api.preview(url('markdown'),'文档',false,{path:'/work/report.md',session:'fixture'});
        check(content.querySelector('h1')?.textContent==='可读文档','Markdown goes through real sanitizer');
        content.scrollTop=600;check(content.scrollTop>0,'Markdown scrolls');
        await api.preview(url('text'),'文本');check(content.scrollTop===0&&content.querySelector('pre').textContent.startsWith('纯文本'),'file switch resets scrolling and text stays literal');
        let pending=api.preview(url('slow'),'旧文档');await api.previewImage('/image.svg','新图');await pending;
        check(content.querySelector('img')?.alt==='新图'&&!content.textContent.includes('obsolete'),'old read cannot overwrite rapid reopen');
        pending=api.preview(url('slow'),'关闭竞态');api.close();await pending;check(content.children.length===0,'close cancels pending read and leaves empty content');
        await api.preview(url('bad'),'403');check(content.textContent.includes('403')&&!!content.querySelector('.preview-retry'),'denied file has actionable retry');
        await api.preview(url('html'),'HTML');
        await wait(()=>!content.hasAttribute('aria-busy'));
        const frame=content.querySelector('iframe');check(frame.getAttribute('sandbox')==='allow-scripts'&&!frame.hasAttribute('srcdoc'),'HTML uses original authorized URL and opaque sandbox');
        let denied=false;try{void frame.contentWindow.document.body;}catch{denied=true;}check(denied,'sandbox prevents parent reading HTML document');
        const zoomButton=viewer.querySelector('[aria-label="放大预览"]');if(!zoomButton)throw Error('missing zoom button: '+viewer.innerHTML.slice(0,2500));zoomButton.click();
        check(frame.src.includes('preview=html')&&frame.src.includes('previewToken='),'HTML handshake and zoom channel use per-open token');
        await api.preview(url('pdf'),'PDF');
        await wait(()=>content.querySelectorAll('canvas').length===2);
        const canvases=[...content.querySelectorAll('canvas')];
        check(canvases.every(c=>c.width>200&&c.getContext('2d').getImageData(50,c.height-80,1,1).data[3]>0),'real PDF.js Worker paints both pages');
        const pdf=content.querySelector('.preview-pdf');touch(content,'touchstart',[[100,200],[200,200]]);touch(content,'touchmove',[[60,200],[240,200]]);touch(content,'touchend',[]);
        check(+pdf.dataset.claudeZoom>1.7,'PDF touch pinch scales rendered pages');content.scrollTop=800;check(content.scrollTop>0,'PDF scrolls after zoom');
        content.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true,cancelable:true}));check(pdf.dataset.claudeZoom==='1'&&content.scrollTop===0,'PDF double click restores fit and position');
        api.close();await api.previewImage('/image.svg','恢复图');await wait(()=>content.querySelector('img')?.naturalWidth>0);check(content.querySelector('img').dataset.claudeZoom==='1','reopened image starts at fit');
        w.previewTest={api,content,viewer,checks};return checks;
      });
      console.log(JSON.stringify({checks:result}));
      // CDP touch dispatch verifies actual browser events beyond synthetic tests.
      await page.cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:100,y:300},{x:200,y:300}]});
      await page.cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:50,y:300},{x:250,y:300}]});
      await page.cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      const realTouch=await page.evaluate(()=>+document.querySelector('#claude').contentDocument.querySelector('.image-stage img').dataset.claudeZoom);
      if(realTouch<1.9)throw Error('real CDP image pinch did not zoom: '+realTouch);
      console.log(JSON.stringify({realTouch}));
      await page.evaluate(async()=>{const w=document.querySelector('#claude').contentWindow;await w.previewTest.api.preview('/claude/api/file?path=pdf','触摸 PDF');});
      await page.waitForFunction(()=>document.querySelector('#claude').contentDocument.querySelectorAll('canvas').length===2);
      const pinch=async()=>{
        await page.cdp('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:100,y:300},{x:200,y:300}]});
        await page.cdp('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:50,y:300},{x:250,y:300}]});
        await page.cdp('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      };
      await pinch();
      const pdfTouch=await page.evaluate(()=>+document.querySelector('#claude').contentDocument.querySelector('.preview-pdf').dataset.claudeZoom);
      if(pdfTouch<1.9)throw Error('real PDF pinch failed: '+pdfTouch);console.log({pdfTouch});
      await page.evaluate(async()=>{const w=document.querySelector('#claude').contentWindow;w.fixtureMetrics=null;w.addEventListener('message',e=>{if(e.source===w.previewTest.content.querySelector('iframe')?.contentWindow&&e.data?.fixture)w.fixtureMetrics=e.data;});await w.previewTest.api.preview('/claude/api/file?path=html','触摸 HTML');});
      await page.waitForFunction(()=>!document.querySelector('#claude').contentDocument.querySelector('.file-content').hasAttribute('aria-busy'));
      const target=(await task.cdp('Target.getTargets')).targetInfos.find(t=>t.url.includes('preview=html'));
      if(!target)throw Error('HTML target missing');
      const session=await task.cdp('Target.attachToTarget',{targetId:target.targetId,flatten:false});let commandId=0;
      const htmlCommand=(method,params)=>task.cdp('Target.sendMessageToTarget',{sessionId:session.sessionId,message:JSON.stringify({id:++commandId,method,params})});
      await htmlCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
      const htmlTouch=(type,touchPoints)=>htmlCommand('Input.dispatchTouchEvent',{type,touchPoints});
      const htmlState=()=>page.evaluate(()=>document.querySelector('#claude').contentWindow.fixtureMetrics);
      await page.waitForFunction(()=>document.querySelector('#claude').contentWindow.fixtureMetrics?.height>1000);
      // Ego/CDP input does not reach this out-of-process opaque iframe. Execute
      // TouchEvents in that actual sandbox realm; do not relax its permissions.
      const inFrame=expression=>htmlCommand('Runtime.evaluate',{expression,returnByValue:true});
      const dispatch=String.raw\`const touch=(type,points)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:points.map(([clientX,clientY])=>({clientX,clientY}))});document.dispatchEvent(event);};\`;
      await inFrame('(()=>{'+dispatch+'touch("touchstart",[[100,230],[200,230]]);touch("touchmove",[[50,230],[250,230]]);touch("touchend",[]);})()');
      await page.waitForFunction(()=>+document.querySelector('#claude').contentWindow.fixtureMetrics?.zoom>1.9);
      const htmlZoom=await htmlState();if(+htmlZoom.zoom<1.9||!htmlZoom.end)throw Error('HTML pinch handler failed '+JSON.stringify(htmlZoom));
      await inFrame('window.scrollTo(0,600)');
      await page.waitForFunction(()=>document.querySelector('#claude').contentWindow.fixtureMetrics?.scroll>0);
      const htmlScroll=await htmlState();if(htmlScroll.scroll<=0)throw Error('HTML document cannot scroll');
      console.log(JSON.stringify({pdfTouch,htmlZoom,htmlScroll,htmlNativeInput:'Ego OOPIF input not delivered; sandbox TouchEvent path verified'}));await task.cdp('Target.detachFromTarget',{sessionId:session.sessionId});
      await page.evaluate(()=>{const w=document.querySelector('#claude').contentWindow;w.previewTest.api.close();});
      // Explicit failures, retry, body timeout and cancellation use independent
      // fixtures while the real renderer's existing viewer stays untouched.
      console.log(await page.evaluate(async()=>{
        const w=document.querySelector('#claude').contentWindow;
        const fast=w.installClaudeMediaPreview({timeoutMs:60,request:(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('abort'),{name:'AbortError'}))))});
        const promise=fast.preview('/claude/api/file?path=slow','超时');await promise;
        const timedOut=fast.element.textContent.includes('超时')&&!!fast.element.querySelector('.preview-retry');fast.dispose();
        if(!timedOut)throw Error('timeout is not actionable');
        const h=w.previewTest;await w.fetch('/toggle-image');await h.api.previewImage('/image.svg','失败图');
        for(let i=0;i<100&&!h.content.querySelector('.preview-retry');i++)await new Promise(r=>setTimeout(r,10));
        if(!h.content.querySelector('.preview-retry'))throw Error('image failure missing retry');
        await w.fetch('/toggle-image');h.content.querySelector('.preview-retry').click();
        for(let i=0;i<100&&!h.content.querySelector('img')?.naturalWidth;i++)await new Promise(r=>setTimeout(r,10));
        const retryReady=!!h.content.querySelector('img')?.naturalWidth;h.api.close();if(!retryReady)throw Error('image retry did not recover');
        return {timedOut,retryReady};
      }));
      // Rotate within the same round; never trust a previous call's emulation.
      await page.cdp('Emulation.setDeviceMetricsOverride',{width:852,height:393,deviceScaleFactor:2,mobile:true});
      await page.waitForFunction(()=>innerWidth===852);
      console.log(await page.evaluate(()=>{const w=document.querySelector('#claude').contentWindow;w.previewTest.api.close();return {rotated:innerWidth,viewerClosed:w.previewTest.viewer.classList.contains('hidden')};}));
    } finally { await task.finish({keep:[]}); }
  `;
  try{
    const {stdout,stderr}=await promisify(execFile)('ego-browser',['nodejs','-e',script],{timeout:100000,maxBuffer:2*1024*1024});
    assert.match(stdout+stderr,/realTouch/);console.log(stdout);if(stderr)console.log(stderr.slice(-6000));
  }catch(error){throw new Error((error.stderr||error.message).slice(-6500));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
