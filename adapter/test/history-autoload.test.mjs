import test from 'node:test';
import assert from 'node:assert/strict';
import {installOlderHistoryLoader} from '../frontend-stage/browser-adapter.mjs';

// DOM-shaped fixture: computed ancestor styles, client rects, connection state,
// multiple cached panes, frame ancestry and asynchronous mutation delivery.
// Layout/real-phone acceptance remains the lead's browser test, not this model.
class FakeEvent{
 constructor(type,init={}){this.type=type;Object.assign(this,init);}
 preventDefault(){}
 stopPropagation(){}
}
class FakeWheel extends FakeEvent{constructor(type,init={}){super(type,init);this.deltaY=init.deltaY??0;}}
class FakeElement{
 constructor(){
  this.dataset={};this.style={};this.listeners=new Map();this.children=[];this.attributes=new Map();this.connected=true;
  this.clientHeight=760;this.scrollTop=0;this.scrollHeight=2400;this.textContent='';this.rect={left:0,top:44,width:390,height:760};
 }
 addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
 removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
 dispatchEvent(event){
  event.currentTarget=this;event.target??=this;
  for(const fn of [...(this.listeners.get(event.type)??[])])fn(event);
  return true;
 }
 get isConnected(){return this.connected&&(!this.parentElement||this.parentElement.isConnected);}
 set isConnected(value){this.connected=value;}
 getBoundingClientRect(){return this.rect;}
 getClientRects(){for(let el=this;el;el=el.parentElement)if(!el.isConnected||el.hidden||el.style.display==='none')return[];return this.rect.width>0&&this.rect.height>0?[this.rect]:[];}
 setAttribute(name,value){this.attributes.set(name,String(value));}
 getAttribute(name){return this.attributes.get(name)??null;}
 contains(child){for(let el=child;el;el=el.parentElement)if(el===this)return true;return false;}
 append(child){child.remove();this.children.push(child);child.parentNode=this;child.parentElement=this;child.ownerDocument=this.ownerDocument;child.connected=true;}
 appendChild(child){this.append(child);}
 insertBefore(child,reference){child.remove();const index=this.children.indexOf(reference);assert(index>=0);this.children.splice(index,0,child);child.parentNode=this;child.parentElement=this;child.ownerDocument=this.ownerDocument;child.connected=true;}
 get nextSibling(){const children=this.parentNode?.children||[];return children[children.indexOf(this)+1]||null;}
 remove(){if(this.parentNode){const children=this.parentNode.children,index=children.indexOf(this);if(index>=0)children.splice(index,1);}this.connected=false;this.parentNode=null;this.parentElement=null;}
}
function harness(options={}){
 let now=1000;const timers=[],warnings=[],observers=[];
 class Observer{
  constructor(callback){this.callback=callback;this.active=true;observers.push(this);}
  observe(target){this.target=target;}
  disconnect(){this.active=false;}
 }
 const makeDocument=()=>{
  const document=new FakeElement(),window=new FakeElement(),root=new FakeElement(),body=new FakeElement();
  Object.assign(window,{document,innerWidth:390,innerHeight:844,MutationObserver:Observer,Event:FakeEvent,WheelEvent:FakeWheel,getComputedStyle:el=>({display:'block',visibility:'visible',opacity:'1',...el.style}),setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval:()=>{},frameElement:null});
  Object.assign(document,{defaultView:window,documentElement:root,body,visibilityState:'visible',hidden:false,createElement:tag=>{const el=new FakeElement();el.tagName=tag.toUpperCase();el.ownerDocument=document;return el;}});
  root.ownerDocument=document;root.append(body);return{document,window,root,body};
 };
 const {document,window,body}=makeDocument(),pane=document.createElement('section'),timeline=document.createElement('div');
 body.append(pane);pane.append(timeline);let timelines=[timeline];
 document.querySelector=selector=>selector==='[data-v4-timeline-scroll="true"]'?timelines.find(el=>el.isConnected)||null:null;
 document.querySelectorAll=selector=>selector==='[data-v4-timeline-scroll="true"]'?timelines.filter(el=>el.isConnected):[];
 let parent,frame;
 if(options.framed){parent=makeDocument();frame=parent.document.createElement('iframe');parent.body.append(frame);window.frameElement=frame;}
 // Original handler model: fresh upward intent + near-top scroll loads a page.
 let intent=null;
 timeline.addEventListener('wheel',event=>{if((event.deltaY??0)<0)intent={kind:'awayFromBottom',at:now};});
 timeline.addEventListener('scroll',()=>{
  if(intent?.kind!=='awayFromBottom'||timeline.scrollTop>Math.max(64,2*timeline.clientHeight))return;
  loads.push({at:now,scrollTop:timeline.scrollTop});if(onLoad)onLoad(loads.length);
 });
 const loads=[];let onLoad=null;
 const setDataset=(state,target=timeline)=>{
  target.dataset.windowRowCount=String(state.loaded);target.dataset.totalRowCount=String(state.total);target.dataset.loadingOlder=state.loading?'true':'false';target.scrollHeight=state.loaded*40;
 };
 setDataset({loaded:60,total:180,loading:false});
 const loader=installOlderHistoryLoader({document,window,now:()=>now,pollMs:400,stallMs:15000,silentRetryMs:1600,cooldownMs:700,maxSilentPages:3,warn:(...args)=>warnings.push(args)});
 const tick=()=>timers.at(-1)?.();
 const mutation=async(target,type='attributes')=>{for(const observer of observers)if(observer.active&&observer.target.contains(target))queueMicrotask(()=>{if(observer.active)observer.callback([{target,type}]);});await Promise.resolve();};
 const setTimelines=(...next)=>{timelines=next;for(const el of next)if(!el.ownerDocument){const host=document.createElement('section');body.append(host);host.append(el);}};
 return{timeline,pane,body,loader,document,window,parent,frame,observers,loads,warnings,setDataset,setTimelines,mutation,advance:ms=>{now+=ms;},now:()=>now,onLoad:fn=>{onLoad=fn;},tick};
}
const label=h=>h.loader.node?.children?.find(child=>child.textContent)?.textContent;
const visible=h=>h.loader.node&&h.loader.node.style.display!=='none';

test('the loader renders a visible "load earlier" block above a long conversation',()=>{
 const h=harness();
 h.tick();
 assert.equal(visible(h),true);
 assert.equal(label(h),'加载更多');
 h.setDataset({loaded:180,total:180,loading:false});h.tick();
 assert.equal(visible(h),false,'the block disappears when every row is loaded');
});

test('the pager is a DSH-style native button row owned by the conversation, never a body overlay',()=>{
 const h=harness(),row=h.loader.node,button=row.children[0];
 assert.equal(row.parentNode,h.pane);assert.equal(row.nextSibling,h.timeline);assert.equal(button.tagName,'BUTTON');assert.equal(button.type,'button');
 assert.doesNotMatch(row.style.cssText,/position:fixed|box-shadow|z-index|border-radius|background:|translate/);
 assert.match(row.style.cssText,/justify-content:center/);assert.match(button.style.cssText,/font-size:12px/);assert.match(button.style.cssText,/padding:4px 12px/);
 assert.match(button.style.cssText,/--dsw-alias-label-secondary/);assert.match(button.style.cssText,/--dsw-alias-interactive-bg-hover-solid/);assert.match(button.style.cssText,/--dsw-radius-sm,4px/);assert.equal(button.disabled,false);
 h.setDataset({loaded:60,total:180,loading:true});h.tick();assert.equal(button.textContent,'加载中…');assert.equal(button.disabled,true);assert.equal(button.style.opacity,'.6');assert.equal(button.style.cursor,'default');
 button.dispatchEvent(new FakeEvent('click'));assert.equal(h.loads.length,0);
 h.setDataset({loaded:120,total:180,loading:false});h.tick();assert.equal(button.textContent,'加载更多');assert.equal(button.disabled,false);h.loader.dispose();
});

test('the flow row never enters native virtual content or rewrites its scroll anchor during resize',()=>{
 const h=harness(),layer=h.document.createElement('div');h.timeline.append(layer);h.timeline.scrollTop=145;
 const before={scrollTop:h.timeline.scrollTop,scrollHeight:h.timeline.scrollHeight,rows:{...h.timeline.dataset}};
 h.timeline.clientHeight=720;h.window.dispatchEvent(new FakeEvent('resize'));
 assert.equal(h.loader.node.parentNode,h.pane);assert.deepEqual(h.timeline.children,[layer]);assert.equal(h.timeline.scrollTop,before.scrollTop);assert.equal(h.timeline.scrollHeight,before.scrollHeight);assert.deepEqual(h.timeline.dataset,before.rows);assert.equal(h.loads.length,0);
 h.loader.dispose();assert.deepEqual(h.timeline.children,[layer]);assert.deepEqual(h.pane.children,[h.timeline]);
});

test('the in-flow row does not oscillate when its height reduces a short scrollport',()=>{
 const h=harness();h.pane.clientHeight=300;h.timeline.clientHeight=300;h.timeline.scrollTop=290;h.tick();assert.equal(visible(h),true);
 h.timeline.clientHeight=270;for(let i=0;i<3;i++){h.tick();assert.equal(visible(h),true);}
 assert.equal(h.loads.length,0);h.loader.dispose();
});

test('an upward drag near the top requests the next page without a click',()=>{
 const h=harness();
 const touchstart=new FakeEvent('touchstart',{touches:[{clientY:300}]});
 const touchmove=new FakeEvent('touchmove',{touches:[{clientY:360}]});
 h.timeline.dispatchEvent(touchstart);h.timeline.dispatchEvent(touchmove);
 assert.equal(h.loads.length,1,'one automatic request per gesture');
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:420}]}));
 assert.equal(h.loads.length,1,'the in-flight page is not re-requested');
});

test('a downward drag or a scroll away from the top never requests history',()=>{
 const h=harness();
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:400}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:320}]}));
 h.timeline.scrollTop=600;h.tick();
 assert.equal(h.loads.length,0);
});

test('a finished page shows loading and the next upward drag can load another page',()=>{
 const h=harness();
 h.onLoad=()=>h.setDataset({loaded:120,total:180,loading:true});
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
 h.tick();
 assert.equal(label(h),'加载中…');
 h.setDataset({loaded:120,total:180,loading:false});
 h.advance(800);h.tick();
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
 assert.equal(h.loads.length,2,'another page is requested after the previous one landed');
});

test('no more history keeps the block hidden and blocks every request',()=>{
 const h=harness();
 h.setDataset({loaded:180,total:180,loading:false});h.tick();
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
 h.timeline.scrollTop=0;h.tick();
 assert.equal(h.loads.length,0);
 assert.equal(visible(h),false);
});

test('a silently dropped page is retried and then surfaces a retry hint instead of failing silently',()=>{
 const h=harness();
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
 assert.equal(h.loads.length,1);
 // The original store finished the read without keeping new rows.
 h.setDataset({loaded:60,total:180,loading:false});
 h.advance(1700);h.tick();
 assert.equal(h.loads.length,2,'the silent drop is retried automatically');
 h.advance(1700);h.tick();
 assert.equal(h.loads.length,3);
 h.advance(1700);h.tick();
 assert.equal(h.loads.length,3,'retries stop after the bounded attempts');
 assert.equal(visible(h),true);
 assert.equal(label(h),'加载失败，重试');
 assert(h.warnings.some(args=>String(args[0]).includes('自动重试')),'the silent drop is logged');
});

test('fifteen seconds without a successful page shows the retry hint',()=>{
 const h=harness();
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
 h.setDataset({loaded:60,total:180,loading:true});
 h.advance(15100);h.tick();
 assert.equal(label(h),'加载失败，重试');
 assert(h.warnings.some(args=>String(args[0]).includes('15 秒')),'the stalled read is logged');
});

test('the visible block itself can retry the page',()=>{
 const h=harness();
 h.tick();
 const button=h.loader.node.children[0];
 h.advance(800);
 button.dispatchEvent(new FakeEvent('click'));
 assert.equal(h.loads.length,1,'tapping the block retries the request');
});

test('switching from a complete conversation to a longer reused timeline enables older history again',()=>{
 const h=harness();h.setDataset({loaded:10,total:10});h.tick();assert.equal(visible(h),false);
 h.setDataset({loaded:60,total:180});h.tick();assert.equal(visible(h),true);
 h.loader.trigger('tap');assert.equal(h.loads.length,1);
});

test('a replaced timeline never inherits pending retries or gesture state from the prior conversation',()=>{
 const h=harness();h.loader.trigger('tap');assert.equal(h.loads.length,1);
 const next=new FakeElement();next.dataset={windowRowCount:'60',totalRowCount:'240',loadingOlder:'false'};
 let newLoads=0;next.addEventListener('scroll',()=>newLoads++);
 h.setTimelines(next);h.advance(1700);h.tick();
 assert.equal(newLoads,0,'old pending retry must not issue a request in the new conversation');
 assert.equal(label(h),'加载更多');
 next.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:500}]}));assert.equal(newLoads,0,'old touch origin must not carry into the new view');
 h.loader.trigger('tap');assert.equal(newLoads,1);
 h.loader.dispose();
});

test('zero geometry, hidden ancestors and offscreen cached panes cannot show or trigger a pager',async()=>{
 const cases=[
  h=>{h.timeline.rect={left:0,top:0,width:0,height:0};},
  h=>{h.timeline.rect.left=500;},
  h=>{h.timeline.rect.top=-1000;},
  h=>{h.pane.hidden=true;},
  h=>{h.pane.inert=true;},
  h=>{h.pane.setAttribute('aria-hidden','true');},
  h=>{h.pane.style.display='none';},
  h=>{h.pane.style.visibility='hidden';},
  h=>{h.pane.style.opacity='0';},
  h=>{h.pane.style.contentVisibility='hidden';}
 ];
 for(const hide of cases){
  const h=harness();assert.equal(visible(h),true);hide(h);
  // User/queued events are safe even before MutationObserver is delivered.
  h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
  await h.mutation(h.pane);assert.equal(h.loader.element,null);assert.equal(visible(h),false);assert.equal(h.loader.trigger('tap'),false);assert.equal(h.loads.length,0);h.loader.dispose();
 }
});

test('a visible timeline is selected after the first cached pane becomes hidden',async()=>{
 const h=harness(),next=new FakeElement();h.setDataset({loaded:60,total:240},next);h.setTimelines(h.timeline,next);
 const staleScroll=[...h.timeline.listeners.get('scroll')].at(-1);let nextLoads=0;next.addEventListener('scroll',()=>nextLoads++);
 h.pane.style.display='none';await h.mutation(h.pane);
 assert.equal(h.document.querySelector('[data-v4-timeline-scroll="true"]'),h.timeline,'the first DOM match is deliberately stale');
 assert.equal(h.loader.element,next);assert.equal(visible(h),true);assert.equal(label(h),'加载更多');
 staleScroll({currentTarget:h.timeline});assert.equal(nextLoads,0,'an old queued event must not drive the replacement pane');
 next.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:200}]}));next.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:260}]}));assert.equal(nextLoads,1,'real upward intent still loads the visible conversation');h.loader.dispose();
});

test('returning Home retires an in-flight pager immediately and its late response cannot revive it',async()=>{
 const h=harness();h.loader.trigger('tap');assert.equal(h.loads.length,1);h.setDataset({loaded:60,total:180,loading:true});
 let finish;const response=new Promise(resolve=>{finish=resolve;}).then(async()=>{h.setDataset({loaded:120,total:180});await h.mutation(h.timeline);});
 h.pane.setAttribute('aria-hidden','true');await h.mutation(h.pane);
 assert.equal(visible(h),false);assert.equal(h.loader.element,null);
 finish();await response;h.advance(16000);h.tick();assert.equal(visible(h),false);assert.equal(h.loads.length,1);
 h.pane.setAttribute('aria-hidden','false');await h.mutation(h.pane);
 assert.equal(h.loader.element,h.timeline);assert.equal(label(h),'加载更多');assert.equal(h.loads.length,1,'returning to the task does not replay its old pending gesture');
 h.loader.trigger('tap');assert.equal(h.loads.length,2);h.loader.dispose();
});

test('hiding a same-origin hub iframe hides its pager without a child visibility event',async()=>{
 const h=harness({framed:true});h.loader.trigger('tap');
 h.parent.body.style.display='none';await h.mutation(h.parent.body);
 assert.equal(h.document.visibilityState,'visible');assert.equal(h.loader.element,null);assert.equal(visible(h),false);
 h.setDataset({loaded:120,total:180});await h.mutation(h.timeline);assert.equal(visible(h),false);
 h.parent.body.style.display='block';await h.mutation(h.parent.body);assert.equal(visible(h),true);assert.equal(label(h),'加载更多');assert.equal(h.loads.length,1);h.loader.dispose();
});

test('pagehide, freeze and document visibility suspend paging until a genuine resume',()=>{
 for(const [target,hide,resume]of [['window','pagehide','pageshow'],['document','freeze','resume'],['document','visibilitychange','visibilitychange']]){
  const h=harness();h.loader.trigger('tap');
  if(hide==='visibilitychange'){h.document.hidden=true;h.document.visibilityState='hidden';}
  h[target].dispatchEvent(new FakeEvent(hide));assert.equal(visible(h),false);assert.equal(h.loader.element,null);
  h.advance(17000);h.setDataset({loaded:60,total:180});h.tick();assert.equal(h.loads.length,1);assert.equal(visible(h),false);
  h.document.hidden=false;h.document.visibilityState='visible';h[target].dispatchEvent(new FakeEvent(resume));assert.equal(visible(h),true);assert.equal(label(h),'加载更多');assert.equal(h.loads.length,1);h.loader.dispose();
 }
});

test('an unmounted timeline and a synchronous navigation during wheel cannot receive synthetic scrolls',async()=>{
 const h=harness();h.loader.trigger('tap');h.timeline.remove();await h.mutation(h.pane,'childList');
 assert.equal(visible(h),false);assert.equal(h.loader.element,null);h.advance(17000);h.tick();assert.equal(h.loads.length,1);h.loader.dispose();
 const race=harness();race.timeline.addEventListener('wheel',()=>{race.pane.hidden=true;});
 assert.equal(race.loader.trigger('tap'),false);assert.equal(race.loads.length,0);assert.equal(visible(race),false);race.loader.dispose();
});

test('late observer work after disposal cannot reattach the badge or restart paging',async()=>{
 const h=harness({framed:true}),callbacks=h.observers.map(observer=>observer.callback),node=h.loader.node;
 h.loader.trigger('tap');h.loader.dispose();
 assert(h.observers.every(observer=>!observer.active));assert.equal(node.isConnected,false);
 assert.equal([...h.window.listeners.values()].reduce((n,listeners)=>n+listeners.size,0),0);
 assert.equal([...h.document.listeners.values()].reduce((n,listeners)=>n+listeners.size,0),0);
 h.setDataset({loaded:120,total:180});for(const callback of callbacks)callback([{target:h.timeline,type:'attributes'}]);await h.mutation(h.timeline);h.tick();
 assert.equal(h.loader.node,null);assert.equal(h.loader.element,null);assert.equal(h.loads.length,1);
});

test('disposing the loader removes the block and its listeners',()=>{
 const h=harness();
 h.tick();
 h.loader.dispose();
 assert.equal(h.loader.node,null);
 h.timeline.dispatchEvent(new FakeEvent('touchstart',{touches:[{clientY:300}]}));
 h.timeline.dispatchEvent(new FakeEvent('touchmove',{touches:[{clientY:360}]}));
 assert.equal(h.loads.length,0);
});
