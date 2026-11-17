import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../backend/lib/hub-chrome.js',import.meta.url),'utf8');

// Execute the production hub controller with explicit DOM, media and WAAPI events.
// No server, native session creation, timers or real message sending are involved.
function harness(){
  class Events {
    listeners=new Map();
    addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list);}
    emit(type,fields={}){for(const fn of this.listeners.get(type)||[])fn(fields);}
  }
  const style=()=>{const values={};return {values,setProperty(key,value){values[key]=value;},getPropertyValue(key){return values[key]??'';}};};
  const root=()=>({dataset:{},style:style(),append(){},getAttribute:()=>null,setAttribute(){},removeAttribute(){}});
  let safeArea=34,timers=[],now=0;
  const parent=Object.assign(new Events(),{
    hidden:false,documentElement:root(),getElementById:()=>({replaceChildren(){}}),
    body:{appendChild(){},removeChild(){}},
    createElement:()=>({style:{cssText:''},getBoundingClientRect:()=>({height:safeArea}),remove(){}})
  });
  const window=new Events(),media=Object.assign(new Events(),{matches:false}),dark=Object.assign(new Events(),{matches:false});
  const frames=[],observers=[],animations=[];
  const view=Object.assign(new Events(),{
    matchMedia:query=>query.includes('reduced-motion')?media:dark,
    requestAnimationFrame:fn=>frames.push(fn),
    setTimeout:(fn,ms)=>{const timer={fn,at:now+(ms||0),cleared:false};timers.push(timer);return timer;},
    clearTimeout:timer=>{if(timer)timer.cleared=true;},
    MutationObserver:class {constructor(callback){this.callback=callback;}observe(target,options){observers.push({target,options,callback:this.callback});}}
  });
  let port=null;
  const row={expanded:'false',getAttribute(){return this.expanded;},closest(selector){
    if(selector==='.JoiKIa_projectRow')return this;
    if(selector==='.Kjh-qa_groupSection')return group;
    if(selector==='.Kjh-qa_list')return group.closest?.('.Kjh-qa_list')??null;
    return null;
  }};
  const group={
    visible:true,isConnected:true,naturalHeight:36,style:{},contains(node){return node===this;},
    closest:selector=>selector==='.Kjh-qa_list'?null:null,
    querySelector:selector=>selector==='.Kjh-qa_groupSection'?null:row,
    getClientRects(){return this.visible&&this.isConnected?[{}]:[];},
    getBoundingClientRect(){const a=animations.findLast(a=>a.playState==='running');return {height:this.visible?(a?(Number.parseFloat(a.frames[0].height)+Number.parseFloat(a.frames[1].height))/2:this.naturalHeight):0};},
    animate(keyframes,options){
      const a={frames:keyframes,options,playState:'running',cancel(){this.playState='idle';this.oncancel?.();},finish(){this.playState='finished';this.onfinish?.();}};
      animations.push(a);return a;
    }
  };
  const doc=Object.assign(new Events(),{
    hidden:false,defaultView:view,documentElement:root(),head:root(),
    body:{hasAttribute:()=>false,setAttribute(){},removeAttribute(){}},
    createElement:()=>({}),querySelector:()=>({}),querySelectorAll:selector=>selector==='.Kjh-qa_list'?(port?[port]:[]):group.isConnected?[group]:[]
  });
  vm.runInNewContext(source,{window,document:parent,matchMedia:()=>dark,Date:{now:()=>10000+now}});
  const frame=Object.assign(new Events(),{contentDocument:doc});
  const select=window.installMobileHubChrome(new Map([['dsh',frame]]));
  const mutate=(records=[])=>{for(const observer of observers)if(observer.target===doc.body&&observer.options.childList)observer.callback(records);};
  const mutateRoot=()=>{for(const observer of observers)if(observer.target===doc.documentElement)observer.callback();};
  const flush=()=>{while(frames.length)frames.shift()();};
  const click=()=>doc.emit('click',{target:row});
  const advance=ms=>{now+=ms;for(const timer of [...timers])if(!timer.cleared&&timer.at<=now){timer.cleared=true;timer.fn();}};
  select('dsh');mutate();flush();
  const toggle=(expanded)=>{row.expanded=String(expanded);group.naturalHeight=expanded?236:36;mutate();flush();return animations.at(-1);};
  return {parent,window,doc,view,media,row,group,animations,observers,select,mutate,mutateRoot,flush,toggle,click,advance,setSafeArea:value=>{safeArea=value;}};
}

test('enabling reduced motion immediately releases the running height and prevents new animation',()=>{
  const h=harness(),animation=h.toggle(true);
  assert.equal(animation.playState,'running');assert.notEqual(h.group.getBoundingClientRect().height,236);
  h.media.matches=true;h.media.emit('change',{matches:true});
  assert.equal(animation.playState,'idle');assert.equal(h.group.getBoundingClientRect().height,236);
  assert.deepEqual(h.group.style,{});
  h.toggle(false);assert.equal(h.animations.length,1);assert.equal(h.group.getBoundingClientRect().height,36);
  h.media.matches=false;h.media.emit('change',{matches:false});
  h.toggle(true);assert.equal(h.animations.length,2);assert.equal(h.animations.at(-1).playState,'running');
});

test('switching away cancels synchronously and returning does not reuse the interrupted height',()=>{
  const h=harness(),animation=h.toggle(true);
  h.select('claude');assert.equal(animation.playState,'idle');assert.equal(h.group.getBoundingClientRect().height,236);
  h.toggle(false);assert.equal(h.animations.length,1);
  h.select('dsh');h.mutate();h.flush();
  const next=h.toggle(true);assert.equal(next.frames[0].height,'36px');assert.equal(next.frames[1].height,'236px');
});

for(const [name,target,event,hidden] of [
  ['parent visibility','parent','visibilitychange',true],
  ['iframe visibility','doc','visibilitychange',true],
  ['parent pagehide','window','pagehide',false],
  ['iframe pagehide','view','pagehide',false],
  ['parent freeze','parent','freeze',false],
  ['iframe freeze','doc','freeze',false]
])test(`${name} releases the height without waiting for an animation frame`,()=>{
  const h=harness(),animation=h.toggle(true);
  if(hidden)h[target].hidden=true;
  h[target].emit(event);
  assert.equal(animation.playState,'idle');assert.equal(h.group.getBoundingClientRect().height,236);
  if(hidden){h.toggle(false);assert.equal(h.animations.length,1);h[target].hidden=false;}
  h.mutate();h.flush();h.toggle(false);h.toggle(true);
  assert.equal(h.animations.at(-1).playState,'running');
});

test('hidden or removed groups cancel before the throttled frame; reveal starts from natural height',()=>{
  for(const property of ['visible','isConnected']){
    const h=harness(),animation=h.toggle(true);
    h.group[property]=false;h.mutate();
    assert.equal(animation.playState,'idle');
    h.row.expanded='false';h.group.naturalHeight=36;h.mutate();h.flush();
    assert.equal(h.animations.length,1);
    h.group[property]=true;h.mutate();h.flush();
    const next=h.toggle(true);assert.equal(next.frames[0].height,'36px');
    const filter=h.observers.find(o=>o.target===h.doc.body&&o.options.childList).options.attributeFilter;
    for(const attr of ['class','style','hidden'])assert.ok(filter.includes(attr));
  }
});

test('an obsolete cancel callback cannot remove the replacement animation from cleanup',()=>{
  const h=harness(),first=h.toggle(true),lateCancel=first.oncancel;
  const second=h.toggle(false);assert.equal(first.playState,'idle');assert.equal(second.playState,'running');
  lateCancel();
  h.media.matches=true;h.media.emit('change',{matches:true});
  assert.equal(second.playState,'idle');assert.equal(h.group.getBoundingClientRect().height,36);
});

test('closing the native drawer via the html attribute immediately releases active height',()=>{
  const h=harness(),animation=h.toggle(true);
  h.group.visible=false;h.mutateRoot();
  assert.equal(animation.playState,'idle');
  const filter=h.observers.find(o=>o.target===h.doc.documentElement).options.attributeFilter;
  assert.ok(filter.includes('data-dshm-drawer'));assert.ok(filter.includes('hidden'));
  h.select('claude');h.row.expanded='false';h.group.naturalHeight=36;
  h.select('dsh');h.group.visible=true;h.flush();
  const next=h.toggle(true);assert.equal(next.frames[0].height,'36px');
});

test('normal completion leaves native layout in control and cannot be revived by cleanup',()=>{
  const h=harness(),animation=h.toggle(true);
  animation.finish();h.select('codex');h.parent.emit('pagehide');
  assert.equal(animation.playState,'finished');assert.deepEqual(h.group.style,{});
  assert.equal(h.group.getBoundingClientRect().height,236);
});

test('native expansion acquires its animated height in the mutation microtask, before the next paint',()=>{
  const h=harness();
  h.row.expanded='true';h.group.naturalHeight=236;
  h.mutate();
  assert.equal(h.animations.length,1,'waiting for requestAnimationFrame lets scroll bounds jump before animation');
  assert.equal(h.animations[0].playState,'running');
  assert.equal(h.animations[0].frames[0].height,'36px');
});

function scroller(node,{clientHeight=120,scrollTop=80,above=200}={}){
  let top=scrollTop;
  const style={values:{},setProperty(key,value){this.values[key]=value;},getPropertyValue(key){return this.values[key]??'';}};
  const port={isConnected:true,clientHeight,clientTop:0,lastElementChild:node.group,style,
    get scrollHeight(){return above+node.group.getBoundingClientRect().height+16;},
    get scrollTop(){return top=Math.max(0,Math.min(top,Math.max(0,this.scrollHeight-clientHeight)));},
    set scrollTop(value){top=Math.max(0,Math.min(value,Math.max(0,this.scrollHeight-clientHeight)));}
  };
  node.group.closest=selector=>selector==='.Kjh-qa_list'?port:null;
  return port;
}

test('a folder toggle never reserves a blank scroll range',()=>{
  const h=harness();h.toggle(true).finish();const port=scroller(h);port.scrollTop=80;
  h.toggle(false);
  assert.equal(port.scrollTop,80,'collapsing leaves the native scroll offset to the browser');
  assert.equal(port.style.getPropertyValue('--hub-dsh-scroll-tail'),'','no blank tail is written');
  assert.equal(port.scrollHeight,200+h.group.getBoundingClientRect().height+16,'scroll range equals real content plus normal padding');
});

test('the scroll range follows the animated height without padding',()=>{
  const h=harness();h.toggle(true).finish();const port=scroller(h);
  port.scrollTop=80;
  const animation=h.toggle(false);
  h.group.naturalHeight=Number.parseFloat(animation.frames[1].height); // final frame
  assert.equal(port.scrollHeight,200+h.group.getBoundingClientRect().height+16);
  assert.equal(port.style.getPropertyValue('--hub-dsh-scroll-tail'),'');
  animation.finish();h.group.naturalHeight=36;
  assert.equal(port.scrollHeight,200+36+16);
  assert.equal(port.scrollTop,80,'the browser clamps only when the real range shrinks below the offset');
});

test('reduced motion collapses with no reserve and no animation',()=>{
  const h=harness();h.toggle(true).finish();const port=scroller(h);port.scrollTop=80;
  h.media.matches=true;
  const before=h.animations.length;
  h.toggle(false);
  assert.equal(h.animations.length,before,'reduced motion runs no height animation');
  assert.equal(port.style.getPropertyValue('--hub-dsh-scroll-tail'),'');
  assert.equal(port.scrollTop,80,'a smaller range never pulls the list upward on its own');
});

test('a short list releases the scroll offset to zero after collapse',()=>{
  const h=harness();h.toggle(true).finish();const port=scroller(h,{clientHeight:500,scrollTop:0});
  assert.ok(port.scrollHeight<500,'the expanded list is still shorter than the viewport in this model');
  h.toggle(false);
  assert.equal(port.scrollTop,0);
  assert.equal(port.style.getPropertyValue('--hub-dsh-scroll-tail'),'');
});

test('a captured tap expires after one second instead of restoring a stale offset later',()=>{
  const h=harness();h.toggle(true).finish();const port=scroller(h,{above:800});port.scrollTop=700;
  h.click();
  h.advance(1000);
  port.scrollTop=100;
  h.row.expanded='false';h.group.naturalHeight=36;h.mutate();h.flush();
  assert.equal(port.scrollTop,100,'an expired tap cannot move a later, unrelated toggle');
});

test('a captured tap is consumed once and never replayed by the next toggle',()=>{
  const h=harness();h.toggle(true).finish();const port=scroller(h,{above:800});port.scrollTop=700;
  h.click();
  h.row.expanded='false';h.group.naturalHeight=36;h.mutate();h.flush();
  assert.equal(port.scrollTop,700,'the tap restores the pre-collapse offset');
  h.advance(1000);
  port.scrollTop=100;
  h.row.expanded='true';h.group.naturalHeight=236;h.mutate();h.flush();
  assert.equal(port.scrollTop,100,'the consumed tap is not replayed on the next toggle');
});

test('a stale recorded height cannot make the first frame snap before the animation',()=>{
  const h=harness(),first=h.toggle(true);first.finish();
  // Sessions were added after the record settled: the recorded height is stale,
  // but the click phase still sees the real current height.
  h.group.naturalHeight=300;
  h.click();
  h.row.expanded='false';h.group.naturalHeight=36;h.mutate();h.flush();
  const animation=h.animations.at(-1);
  assert.equal(animation.frames[0].height,'300px','the first frame starts at the real pre-toggle height');
  assert.equal(animation.frames[1].height,'36px');
});

test('the first expansion after the drawer opens animates from the height captured at tap',()=>{
  const h=harness();
  h.group.visible=false;h.mutate();
  h.group.visible=true;
  assert.equal(h.animations.length,0,'a group hidden while the drawer was closed has no recorded height');
  h.click();
  h.row.expanded='true';h.group.naturalHeight=236;h.mutate();h.flush();
  assert.equal(h.animations.length,1,'the first expansion animates instead of jumping');
  assert.equal(h.animations[0].frames[0].height,'36px');
  assert.equal(h.animations[0].frames[1].height,'236px');
});

test('sessions arriving mid-animation retarget from the current frame instead of snapping at finish',()=>{
  const h=harness(),first=h.toggle(true),height=h.group.getBoundingClientRect().height;
  h.group.naturalHeight=500;
  h.mutate([{type:'childList',target:h.group,addedNodes:[{nodeType:1}]}]);
  const next=h.animations.at(-1);
  assert.equal(first.playState,'idle');assert.notEqual(next,first);
  assert.equal(next.frames[0].height,height+'px');assert.equal(next.frames[1].height,'500px');
  next.finish();assert.equal(h.group.getBoundingClientRect().height,500);
});

test('nested groups drive ancestor layout without caching an intermediate ancestor height',()=>{
  const h=harness(),first=h.toggle(true);
  h.group.querySelector=selector=>selector==='.Kjh-qa_groupSection'?{}:h.row;
  h.mutate([{type:'childList',target:h.group,addedNodes:[{nodeType:1}]}]);
  assert.equal(first.playState,'idle');
  h.group.naturalHeight=540;h.mutate();
  assert.equal(h.animations.length,1,'an unrelated update cannot replay an old ancestor height');
  assert.equal(h.group.getBoundingClientRect().height,540);
});

test('unrelated child updates do not restart folder animations',()=>{
  const h=harness(),first=h.toggle(true);
  h.mutate([{type:'childList',target:{}}]);
  h.mutate([{type:'childList',target:h.group,addedNodes:[{nodeType:3}]}]);
  assert.equal(h.animations.length,1);assert.equal(first.playState,'running');
});

test('the parent-measured safe-area inset reaches every framed document',()=>{
  const h=harness();
  assert.equal(h.parent.documentElement.style.values['--hub-safe-bottom'],'34px');
  assert.equal(h.doc.documentElement.style.values['--hub-safe-bottom'],'34px');
  h.setSafeArea(0);h.window.emit('resize');
  assert.equal(h.doc.documentElement.style.values['--hub-safe-bottom'],'0px','resize republishes the measured inset');
});

function historyPagingFixture({shared=true}={}){
  const h=harness();let clicks=0;
  const button={disabled:false,offsetParent:{},textContent:'加载更早',click(){clicks++;}};
  const flow={querySelector:selector=>selector===':scope > [data-chat-flow] > .tnXGgG_older > button'?button:null};
  const history={...flow,scrollTop:120,matches:selector=>selector.includes('.tnXGgG_scroll'),closest:selector=>selector==='[data-conversation-scroll]'&&shared?port:null};
  const port=shared?{scrollTop:120,matches:selector=>selector.includes('[data-conversation-scroll]'),querySelector:selector=>selector==='.tnXGgG_scroll'?history:null,closest:()=>null}:history;
  const originalQuery=h.doc.querySelectorAll;
  h.doc.querySelectorAll=selector=>selector==='button'?[button]:originalQuery(selector);
  return {...h,button,history,port,scroll:target=>h.doc.emit('scroll',{target}),clicks:()=>clicks};
}

test('only the actual pinned history scrollport can trigger older paging',()=>{
  for(const shared of [true,false]){
    const h=historyPagingFixture({shared});
    for(const kind of ['textarea','contenteditable','sidebar','menu','listbox','code-block','nested-turn-rail']){
      h.scroll({kind,scrollTop:120,matches:()=>false,closest:()=>h.port});
    }
    if(shared)h.scroll(h.history); // its inner list is not the shared scroll owner
    assert.equal(h.clicks(),0,'nested and unrelated scrollers must never load history');
    h.scroll(h.port);assert.equal(h.clicks(),1,'both pinned shared and standalone history layouts still page');
    h.scroll(h.port);assert.equal(h.clicks(),1,'repeat top events remain coalesced');
    h.advance(901);h.scroll(h.port);assert.equal(h.clicks(),2);
  }
});

test('history pagination requires the active visible chat and its own enabled top pager',()=>{
  const h=historyPagingFixture();
  h.port.scrollTop=161;h.scroll(h.port);assert.equal(h.clicks(),0);h.port.scrollTop=120;
  h.button.disabled=true;h.scroll(h.port);assert.equal(h.clicks(),0);h.button.disabled=false;
  h.button.offsetParent=null;h.scroll(h.port);assert.equal(h.clicks(),0);h.button.offsetParent={};
  h.select('codex');h.scroll(h.port);assert.equal(h.clicks(),0);h.select('dsh');
  h.parent.hidden=true;h.scroll(h.port);assert.equal(h.clicks(),0);h.parent.hidden=false;
  h.doc.hidden=true;h.scroll(h.port);assert.equal(h.clicks(),0);h.doc.hidden=false;
  h.doc.documentElement.getAttribute=()=> 'open';h.scroll(h.port);assert.equal(h.clicks(),0);
  h.doc.documentElement.getAttribute=()=> 'closed';
  const ownQuery=h.history.querySelector;h.history.querySelector=()=>null;
  h.scroll(h.port);assert.equal(h.clicks(),0,'a global same-label button is not this history pager');
  h.history.querySelector=ownQuery;h.scroll(h.port);assert.equal(h.clicks(),1);
});

test('history pager selectors match the reviewed pinned ChatViewport ownership and DOM',t=>{
  let manifest;
  try{manifest=JSON.parse(readFileSync(new URL('../../dsh-mobile/frontend/manifest.json',import.meta.url),'utf8'));}
  catch(error){if(error.code==='ENOENT'){t.skip('reviewed local DSH frontend manifest is absent; source-only CI never captures desktop assets');return;}throw error;}
  const entry=Object.entries(manifest.resources||{}).find(([route])=>route.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&'))?.[1];
  assert.ok(entry?.file,'the pinned chat module must remain in the reviewed manifest');
  let chat;
  try{chat=readFileSync(new URL('../../dsh-mobile/frontend/'+entry.file,import.meta.url),'utf8');}
  catch(error){if(error.code==='ENOENT'){t.skip('reviewed local DSH chat bundle is absent; source-only CI never captures desktop assets');return;}throw error;}
  assert.ok(chat.includes('const scroller = list.closest("[data-conversation-scroll]") ?? list;'));
  assert.match(chat,/"scroll": "tnXGgG_scroll"/);assert.match(chat,/"older": "tnXGgG_older"/);
  assert.match(chat,/ref: scroll\.listRef,\s+className: ChatView_module_css_default\.scroll,\s+children: \[\(0, react_jsx_runtime\.jsxs\)\("div", \{\s+ref: scroll\.columnRef,\s+className: ChatView_module_css_default\.column,\s+"data-chat-flow": "",/);
  assert.match(chat,/hasMore && \(0, react_jsx_runtime\.jsx\)\("div", \{\s+className: ChatView_module_css_default\.older,\s+children: \(0, react_jsx_runtime\.jsx\)\("button",/);
});

test('native pointer-armed row FLIP cannot double the hub group-height displacement',()=>{
  assert.match(source,/html\[data-mobile-hub\] \.Kjh-qa_list \[data-row-key\]\{transform:none!important\}/);
  assert.doesNotMatch(source,/\[data-row-key\]\{[^}]*opacity:/,'native entry fades remain in control');
});

test('DSH chrome keeps the full-bleed section header and zeroes framed safe areas',()=>{
  const dsh=source.slice(source.indexOf('dsh:`'),source.indexOf('claude:`'));
  assert.ok(dsh.includes('width:calc(100% + 24px)!important'),'the header must keep its native 0..390px coverage');
  assert.ok(!dsh.includes('calc(100% + 8px)'),'shrinking the width clipped the right-hand view-options button');
  assert.ok(dsh.includes('html[data-mobile-hub]{--dshm-safe-top:0px;--dshm-safe-bottom:0px}'));
  assert.ok(dsh.includes('html[data-mobile-hub][data-dshm-mobile] :is([data-dshm-frame],[data-rightbar-col]){padding-top:0!important;padding-bottom:0!important}'));
  assert.ok(dsh.includes('overflow-x:clip!important'));
  assert.match(dsh,/[fF]ull-bleed section header[\s\S]*?\.Kjh-qa_list\{[^}]*overflow-x:clip/,'the widened header needs the documented clipping scroller');
});

test('framed Codex overlays and the Claude page keep the hub layout lock',()=>{
  const codex=source.slice(source.indexOf('codex:`'),source.indexOf('dsh:`'));
  assert.ok(codex.includes('[data-workspace-side-frame][aria-hidden="false"]'));
  assert.ok(codex.includes('[data-mobile-side-pane-overlay]>div'));
  const claude=source.slice(source.indexOf('claude:`'));
  assert.ok(claude.includes('html,body{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:hidden!important'));
  assert.ok(claude.includes('html{touch-action:pan-y!important}'));
});
