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
  const root=()=>({dataset:{},style:{setProperty(){}},append(){}});
  const parent=Object.assign(new Events(),{hidden:false,documentElement:root(),getElementById:()=>({replaceChildren(){}})});
  const window=new Events(),media=Object.assign(new Events(),{matches:false}),dark=Object.assign(new Events(),{matches:false});
  const frames=[],observers=[],animations=[];
  const view=Object.assign(new Events(),{
    matchMedia:query=>query.includes('reduced-motion')?media:dark,
    requestAnimationFrame:fn=>frames.push(fn),
    MutationObserver:class {constructor(callback){this.callback=callback;}observe(target,options){observers.push({target,options,callback:this.callback});}}
  });
  const row={expanded:'false',getAttribute(){return this.expanded;}};
  let port=null;
  const group={
    visible:true,isConnected:true,naturalHeight:36,style:{},
    closest:selector=>selector==='.Kjh-qa_list'?port:null,
    querySelector:()=>row,
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
  vm.runInNewContext(source,{window,document:parent,matchMedia:()=>dark});
  const frame=Object.assign(new Events(),{contentDocument:doc});
  const select=window.installMobileHubChrome(new Map([['dsh',frame]]));
  const mutate=()=>{for(const observer of observers)if(observer.target===doc.body&&observer.options.childList)observer.callback();};
  const mutateRoot=()=>{for(const observer of observers)if(observer.target===doc.documentElement)observer.callback();};
  const flush=()=>{while(frames.length)frames.shift()();};
  select('dsh');mutate();flush();
  const toggle=(expanded)=>{row.expanded=String(expanded);group.naturalHeight=expanded?236:36;mutate();flush();return animations.at(-1);};
  const scrolling=()=>{
    let top=0,tail=0;const box=group.getBoundingClientRect.bind(group);
    port={isConnected:true,clientHeight:120,clientTop:0,lastElementChild:group,
      style:{setProperty(_key,value){tail=Number.parseFloat(value);}},
      getClientRects:()=>group.visible?[{}]:[],getBoundingClientRect:()=>({top:0}),matches:selector=>selector==='.Kjh-qa_list',
      get scrollHeight(){return Math.max(this.clientHeight,box().height+16+tail);},
      get scrollTop(){return top=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));},
      set scrollTop(value){top=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));},get tail(){return tail;}
    };
    group.getBoundingClientRect=()=>({height:box().height,top:-port.scrollTop,bottom:box().height-port.scrollTop});
    row.closest=selector=>selector==='.Kjh-qa_groupSection'?group:selector==='.Kjh-qa_list'?port:null;
    return {port,capture:()=>doc.emit('click',{target:{closest:selector=>selector==='.JoiKIa_projectRow'?row:null}})};
  };
  return {parent,window,doc,view,media,row,group,animations,observers,select,mutate,mutateRoot,flush,toggle,scrolling};
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

test('collapse restores the captured offset after natural layout temporarily clamps the scroller',()=>{
 const h=harness();h.toggle(true).finish();
 const port={isConnected:true,scrollTop:80};
 const row={closest:selector=>selector==='.Kjh-qa_groupSection'?h.group:selector==='.Kjh-qa_list'?port:null};
 h.doc.emit('click',{target:{closest:selector=>selector==='.JoiKIa_projectRow'?row:null}});
 port.scrollTop=0; // layout at final collapsed height clamps before WAAPI.
 h.toggle(false);
 assert.equal(port.scrollTop,80);
});

test('a short collapsed list retains its real scroll range through animation completion',()=>{
 const h=harness();h.toggle(true).finish();const {port,capture}=h.scrolling();port.scrollTop=80;
 capture();const animation=h.toggle(false);assert.equal(port.scrollTop,80);
 animation.finish();assert.equal(port.scrollTop,80);assert.equal(port.tail,148);
 port.scrollTop=40;h.doc.emit('scroll',{target:port});assert.equal(port.scrollTop,40);assert.equal(port.tail,108);
 port.scrollTop=0;h.doc.emit('scroll',{target:port});assert.equal(port.tail,0);
});

test('a style mutation between capture and the native toggle cannot release the reserved range',()=>{
 const h=harness();h.toggle(true).finish();const {port,capture}=h.scrolling();port.scrollTop=80;
 capture();h.mutate();assert.ok(port.tail>0,'capture style can be observed before React handles the click');
 const animation=h.toggle(false);animation.finish();assert.equal(port.scrollTop,80);
});

test('reduced motion keeps the clicked row in place without relying on an animation',()=>{
 const h=harness();h.toggle(true).finish();const {port,capture}=h.scrolling();port.scrollTop=80;
 h.media.matches=true;capture();h.toggle(false);assert.equal(port.scrollTop,80);
 capture();h.toggle(true);assert.equal(port.scrollTop,80);assert.equal(port.tail,0);
});

test('reversing a collapse retains the range and reopening releases the reserve',()=>{
 const h=harness();h.toggle(true).finish();const {port,capture}=h.scrolling();port.scrollTop=80;
 capture();const collapse=h.toggle(false);capture();const reopen=h.toggle(true);
 assert.equal(collapse.playState,'idle');assert.equal(port.scrollTop,80);
 reopen.finish();assert.equal(port.scrollTop,80);assert.equal(port.tail,0);
});
