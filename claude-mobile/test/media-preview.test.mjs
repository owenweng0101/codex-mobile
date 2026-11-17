import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {injectHtmlPreview} from '../backend/lib/html-preview.mjs';

test('HTML injection preserves markup and rejects executable or oversized tokens',()=>{
  const text='<!doctype html><html><body><h1>报告</h1><script>const close="</body>";</script></body></html>';
  const result=injectHtmlPreview(text,'valid-token_1');
  assert.ok(result.startsWith(text));assert.match(result,/data-claude-preview-zoom/);
  assert.match(result,/bindDocumentZoom/);assert.match(result,/claude-preview-ready/);assert.match(result,/claude-preview-fit/);
  assert.doesNotMatch(result,/allow-same-origin|Content-Security-Policy|fetch\(/);
  for(const token of ['',null,'x'.repeat(161),'</script><script>alert(1)','abc def'])assert.equal(injectHtmlPreview(text,token),text);
});

test('file references strip only trailing numeric line/column suffixes',()=>{
  const source=readFileSync(new URL('../backend/lib/message-renderer.js',import.meta.url),'utf8');
  const fn=source.slice(source.indexOf('  function localPath('),source.indexOf('  function fileUrl('));
  const localPath=vm.runInNewContext('('+fn.trim()+')');
  assert.equal(localPath('/work/ui.mjs:356'),'/work/ui.mjs');
  assert.equal(localPath('file:///work/%E6%96%87%E6%A1%A3.md:3:12'),'/work/文档.md');
  assert.equal(localPath('report.md%3A356'), 'report.md:356');
  assert.equal(localPath('/work/report:notes.md'),'/work/report:notes.md');
  assert.equal(localPath('/work/report:12.md'),'/work/report:12.md');
  assert.equal(localPath('/work/report.md:12:notes'),'/work/report.md:12:notes');
  assert.equal(localPath('https://example.com/report.md:12'),null);
});

test('pinned PDF core, Worker, binary resources and compatibility shim ship locally',()=>{
  const read=name=>readFileSync(new URL('../backend/vendor/pdfjs/'+name,import.meta.url),'utf8');
  assert.match(read('pdf.worker.mjs'),/pdfjsVersion = 6\.3\.289/);
  assert.match(read('pdf.mjs'),/installPdfCompatibility\(\)/);
  assert.match(read('pdf.worker.mjs'),/installPdfCompatibility\(\)/);
  assert.match(read('binary-assets.mjs'),/Adobe-GB1-UCS2\.bcmap/);
  assert.match(read('LICENSE.txt'),/Apache License/);
  assert.match(read('loader.mjs'),/useWorkerFetch:false/);
  assert.doesNotMatch(read('loader.mjs'),/https?:|blob:/);
});

// ---- media-preview module: pure helpers, history guard and the real installer ----
const previewSource=readFileSync(new URL('../backend/lib/media-preview.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function internals(){
  const sandbox={window:{},URL,console};
  vm.runInNewContext(previewSource,sandbox,{timeout:1000});
  return sandbox.window.claudeMediaPreviewInternals;
}

test('inline data:image URLs are accepted only within the 2MB preview cap',()=>{
  const {DATA_IMAGE_LIMIT,dataImage,validatePreviewUrl}=internals();
  assert.equal(DATA_IMAGE_LIMIT,2*1024*1024);
  const png='data:image/png;base64,iVBORw0KGgo=';
  const parsed=dataImage(png);
  assert.equal(parsed.type,'image/png');assert.equal(parsed.url,png);assert.equal(parsed.tooLarge,false);assert.equal(parsed.size,png.length);assert.equal(parsed.limit,DATA_IMAGE_LIMIT);
  assert.equal(dataImage('data:image/svg+xml;utf8,<svg/>').type,'image/svg+xml');
  for(const value of ['data:text/html;base64,AAAA','https://mobile.test/a.png',null,42,'data:image/png;base64'])assert.equal(dataImage(value),null);
  const atLimit='data:image/png;base64,'+'A'.repeat(DATA_IMAGE_LIMIT-'data:image/png;base64,'.length);
  assert.equal(atLimit.length,DATA_IMAGE_LIMIT);
  assert.equal(dataImage(atLimit).tooLarge,false);
  const over=atLimit+'A';
  assert.equal(dataImage(over).tooLarge,true);assert.equal(dataImage(over).url,null);

  const win={location:{href:'https://mobile.test/claude/chat',origin:'https://mobile.test'}};
  assert.equal(validatePreviewUrl(png,true,win),png);
  assert.throws(()=>validatePreviewUrl(over,true,win),error=>error.code==='CLAUDE_PREVIEW_TOO_LARGE'&&/图片过大/.test(error.message));
  assert.throws(()=>validatePreviewUrl(over,false,win),/不支持/);
  assert.equal(validatePreviewUrl('blob:https://mobile.test/abc',true,win),'blob:https://mobile.test/abc');
  assert.throws(()=>validatePreviewUrl('blob:https://evil.test/abc',true,win),/不支持/);
  assert.equal(validatePreviewUrl('/claude/api/file?session=s&path=a.txt',false,win),'https://mobile.test/claude/api/file?session=s&path=a.txt');
  assert.throws(()=>validatePreviewUrl('data:image/svg+xml;base64,AA',false,win),/不支持/);
});

test('PDF canvas planner keeps visible pages and bounds off-screen rasters',()=>{
  const {PDF_LIVE_PAGES,planPageReclaim}=internals();
  assert.equal(PDF_LIVE_PAGES,6);
  const plan=(rendered,visible,budget)=>[...planPageReclaim(rendered,visible,budget)];
  assert.deepEqual(plan([],[]),[]);
  assert.deepEqual(plan([1,2,3],[],2),[1]);
  assert.deepEqual(plan([1,2,3,4,5,6,7],[],3),[1,2,3,4]);
  // Visible pages win even when they exceed the budget.
  assert.deepEqual(plan([1,2,3,4,5],[5,1],2),[2,3,4]);
  // The default budget keeps the six most recently painted pages.
  assert.deepEqual(plan([1,2,3,4,5,6,7,8],[]),[1,2]);
  // A visible page that was never rendered cannot pin anything.
  assert.deepEqual(plan([1,2],[9],1),[1]);
});

test('history guard maps the system back gesture to closing the preview',async()=>{
  const {createHistoryGuard}=internals();
  const events=new Map();
  const win={addEventListener:(type,fn)=>events.set(type,[...(events.get(type)||[]),fn]),removeEventListener:(type,fn)=>events.set(type,(events.get(type)||[]).filter(candidate=>candidate!==fn))};
  const history={entries:[{state:null}],index:0,get state(){return this.entries[this.index].state;},
    pushState(state){this.entries.length=this.index+1;this.entries.push({state});this.index=this.entries.length-1;},
    replaceState(state){this.entries[this.index]={state};},
    back(){if(this.index<=0)return;this.index--;queueMicrotask(()=>{for(const fn of events.get('popstate')||[])fn({state:history.state});});}};
  win.history=history;
  let closed=0;
  const guard=createHistoryGuard(win,()=>closed++);
  assert.equal(guard.active(),false);
  guard.open();assert.equal(guard.active(),true);assert.equal(history.entries.length,2);
  assert.equal(typeof history.state.claudeMediaPreview,'string');
  guard.open();assert.equal(history.entries.length,2,'reopening while visible pushes once');
  history.back();await tick();
  assert.equal(closed,1);assert.equal(guard.active(),false);assert.equal(history.index,0);
  // The split-view close button pops the sentinel without closing twice.
  guard.open();assert.equal(history.index,1);
  guard.close();assert.equal(history.index,0);
  await tick();
  assert.equal(closed,1);assert.equal(guard.active(),false);
  // After a UI close the next back press is ordinary navigation.
  guard.open();history.back();await tick();
  assert.equal(closed,2);
  guard.open();guard.dispose();assert.equal(history.index,0);assert.equal(guard.active(),false);
});

test('fit resets zoom without losing the scroll anchor; reset still goes home',()=>{
  const {bindDocumentZoom}=internals();
  const make=(rect)=>({style:{},dataset:{},ownerDocument:null,addEventListener(){},removeEventListener(){},closest(){return null},getBoundingClientRect:()=>rect,clientWidth:rect.width,clientHeight:rect.height,scrollLeft:0,scrollTop:0});
  const doc={documentElement:{clientWidth:400,clientHeight:600},scrollingElement:null,addEventListener(){},removeEventListener(){}};
  const win={innerWidth:400,innerHeight:600,visualViewport:{width:400,height:600},addEventListener(){},removeEventListener(){}};
  doc.defaultView=win;
  const viewport=make({left:0,top:0,width:400,height:600}),layer=make({left:0,top:0,width:400,height:600});
  viewport.ownerDocument=layer.ownerDocument=doc;
  const zoom=bindDocumentZoom(viewport,layer);
  zoom.zoom(2);
  assert.equal(layer.dataset.claudeZoom,'2');
  viewport.scrollTop=600;viewport.scrollLeft=120;
  zoom.fit();
  assert.equal(layer.dataset.claudeZoom,'1');
  assert.ok(!layer.style.zoom);
  assert.equal(viewport.scrollTop,150,'rotation keeps the reading position');
  assert.equal(viewport.scrollLeft,0);
  viewport.scrollTop=600;viewport.scrollLeft=120;zoom.reset();
  assert.equal(viewport.scrollTop,0);assert.equal(viewport.scrollLeft,0);
  zoom.dispose();
});

// Minimal tree/event stub, not a browser: runs the real installer without
// layout, network or real timers so preview lifecycle stays deterministic.
function previewHarness(){
  let document;
  const listeners=new Map();
  class Node {
    constructor(tag='',text=''){this.tagName=tag.toUpperCase();this.value=text;this.attrs=new Map();this.children=[];this.parentNode=null;this.style={};this.dataset={};this.inert=false;this.ownerDocument=document;this.clientWidth=0;this.clientHeight=0;this.scrollLeft=0;this.scrollTop=0;}
    get childNodes(){return this.children;}
    get textContent(){return this.tagName?this.children.map(node=>node.textContent).join(''):this.value;}
    set textContent(value){if(this.tagName)this.replaceChildren(new Node('',String(value)));else this.value=String(value);}
    get attributes(){return [...this.attrs.keys()].map(name=>({name}));}
    setAttribute(key,value){this.attrs.set(key,String(value));}
    getAttribute(key){return this.attrs.get(key)??null;}
    hasAttribute(key){return this.attrs.has(key);}
    removeAttribute(key){this.attrs.delete(key);}
    get className(){return this.getAttribute('class')||'';}
    set className(value){this.setAttribute('class',value);}
    get classList(){return {add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/).filter(Boolean),...names])].join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ');},contains:name=>this.className.split(/\s+/).includes(name)};}
    append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
    insertBefore(node,reference){node.remove();node.parentNode=this;const index=this.children.indexOf(reference);this.children.splice(index<0?this.children.length:index,0,node);}
    replaceChildren(...nodes){for(const child of this.children)child.parentNode=null;this.children=[];this.append(...nodes);}
    remove(){if(this.parentNode){const siblings=this.parentNode.children;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
    matches(selector){if(!this.tagName)return false;if(selector==='*')return true;if(selector.includes(':not(:disabled)')&&this.disabled)return false;selector=selector.replace(':not(:disabled)','');const match=/^([\w-]+)?(?:\.([\w-]+))?$/.exec(selector);return !!match&&(!match[1]||this.tagName===match[1].toUpperCase())&&(!match[2]||this.classList.contains(match[2]));}
    querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    closest(selector){for(let node=this;node;node=node.parentNode)if(node.matches(selector))return node;return null;}
    contains(node){return node===this||this.children.some(child=>child.contains(node));}
    get isConnected(){return this===document.body||!!this.parentNode?.isConnected;}
    focus(){document.activeElement=this;}
    getClientRects(){return [{}];}
    getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
    addEventListener(){}
    removeEventListener(){}
    setPointerCapture(){}
    getContext(){return {};}
  }
  for(const property of ['src','href','alt','title'])Object.defineProperty(Node.prototype,property,{get(){return this.getAttribute(property)||'';},set(value){this.setAttribute(property,value);}});
  document={createElement:tag=>new Node(tag),createTextNode:text=>new Node('',text),addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener(){},activeElement:null};
  document.body=new Node('body');document.head=new Node('head');
  const events=new Map();
  const history={entries:[{state:null}],index:0,get state(){return this.entries[this.index]?.state??null;},pushState(state){this.entries.length=this.index+1;this.entries.push({state});this.index=this.entries.length-1;},replaceState(state){this.entries[this.index]={state};},back(){if(this.index<=0)return;this.index--;queueMicrotask(()=>{for(const fn of events.get('popstate')||[])fn({state:history.state});});}};
  const win={location:{href:'https://mobile.test/claude/chat',origin:'https://mobile.test'},crypto:{randomUUID:()=> 'preview-token'},devicePixelRatio:2,innerWidth:390,innerHeight:800,visualViewport:{width:390,height:800},history,
    addEventListener:(type,listener)=>events.set(type,[...(events.get(type)||[]),listener]),
    removeEventListener:(type,listener)=>events.set(type,(events.get(type)||[]).filter(fn=>fn!==listener)),AbortController};
  document.defaultView=win;
  const timers=new Map();let timerId=0;
  const sandbox={window:{},document,URL,setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(previewSource,sandbox,{timeout:1000});
  const viewer=new Node('section');viewer.className='file-view hidden';
  const bar=new Node('div'),title=new Node('strong'),closeButton=new Node('button'),content=new Node('div');
  content.clientWidth=390;content.clientHeight=760;
  const requests=[];
  const api=sandbox.window.installClaudeMediaPreview({doc:document,viewer,bar,title,closeButton,content,
    request:(url,options)=>{requests.push({url,options});return Promise.resolve({ok:true,status:200,headers:{get:()=>'text/plain'},text:async()=>'纯文本内容',body:{cancel(){}}});}});
  return {window:win,document,viewer,content,title,closeButton,api,history,events,timers,requests,
    back:()=>history.back(),key:key=>listeners.get('keydown')?.({key,preventDefault(){}})};
}

test('the real installer closes on system back and keeps history in sync',async()=>{
  const h=previewHarness();
  await h.api.preview('/claude/api/file?session=s&path=a.txt','文本',false,{path:'/work/a.txt'});
  assert.equal(h.viewer.classList.contains('hidden'),false);
  assert.equal(h.history.entries.length,2);
  assert.equal(typeof h.history.state.claudeMediaPreview,'string');
  assert.equal(h.content.querySelector('pre').textContent,'纯文本内容');
  h.back();await tick();
  assert.equal(h.viewer.classList.contains('hidden'),true,'system back closes the preview');
  assert.equal(h.content.children.length,0);
  assert.equal(h.history.index,0);
  assert.equal(h.history.entries.length,2,'back stays inside the page history');
  // Escape and the close button unwind the same sentinel entry.
  await h.api.preview('/claude/api/file?session=s&path=b.txt','文本',false,{path:'/work/b.txt'});
  assert.equal(h.history.index,1);
  h.key('Escape');await tick();
  assert.equal(h.viewer.classList.contains('hidden'),true);assert.equal(h.history.index,0);
  await h.api.preview('/claude/api/file?session=s&path=c.txt','文本',false,{path:'/work/c.txt'});
  h.closeButton.onclick();await tick();
  assert.equal(h.viewer.classList.contains('hidden'),true);assert.equal(h.history.index,0);
  // The sentinel is consumed: another back press is ordinary navigation.
  await h.api.preview('/claude/api/file?session=s&path=d.txt','文本',false,{path:'/work/d.txt'});
  h.back();await tick();
  assert.equal(h.viewer.classList.contains('hidden'),true);assert.equal(h.history.index,0);
});

test('the real installer previews bounded data:image sources and rejects oversized ones',async()=>{
  const h=previewHarness();
  const image='data:image/png;base64,iVBORw0KGgo=';
  await h.api.previewImage(image,'内联图');
  assert.equal(h.requests.length,0,'data URLs are never fetched');
  const rendered=h.content.querySelector('img');
  assert.equal(rendered.src,image);assert.equal(rendered.alt,'内联图');
  rendered.onload();await tick();
  assert.equal(h.content.querySelector('.preview-loading'),null);
  assert.equal(h.content.dataset.kind,'image');
  h.api.close();await tick();
  const oversized='data:image/png;base64,'+'A'.repeat(2*1024*1024);
  await h.api.previewImage(oversized,'超大图');
  assert.match(h.content.textContent,/图片过大/);
  assert.doesNotMatch(h.content.textContent,/不支持/);
  assert.equal(h.content.querySelector('.preview-status')?.querySelector('button'),null,'oversized images offer no retry');
  assert.equal(h.timers.size,0);
});
