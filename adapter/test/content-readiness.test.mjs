import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialContentReadiness} from '../frontend-stage/browser-adapter.mjs';
import {loadCodexMobile} from '../codex-entry.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({task='task',reported=true}={}){
  const context={workspacePath:'/work',initialTaskId:task};let timelines=[],navigation=null,listener,registrations=0,reads=0,watchedSession=task;
  const observers=[],events=new Map(),document={hidden:false,visibilityState:'visible',body:{},querySelector:selector=>selector==='[data-v4-timeline-scroll="true"]'?timelines[0]||null:navigation,querySelectorAll:()=>timelines,addEventListener:(type,fn)=>events.set(type,fn),removeEventListener:type=>events.delete(type)};
  class Observer{constructor(callback){this.callback=callback;this.active=true;observers.push(this);}observe(){}disconnect(){this.active=false;}}
  document.defaultView={innerWidth:390,innerHeight:844,frameElement:null,MutationObserver:Observer,getComputedStyle:el=>({display:'block',visibility:'visible',opacity:'1',...el.style})};
  const createTimeline=(total,loaded,rows=true,{sessionId=task,hidden=false}={})=>{
    const owner={sessionId,hidden,style:{},isConnected:true,ownerDocument:document,getAttribute(name){return name==='data-session-id'?this.sessionId:null;}};
    const node={owner,ownerDocument:document,parentElement:owner,isConnected:true,style:{},dataset:{totalRowCount:String(total),windowRowCount:String(loaded)},rect:{left:0,top:44,width:390,height:760},querySelector:()=>rows?{}:null,closest:selector=>selector==='[data-session-id]'?owner:null,getAttribute:()=>null,getClientRects(){return this.owner.hidden||!this.isConnected?[]:[this.rect];},getBoundingClientRect(){return this.rect;}};
    return node;
  };
  const tracker=createInitialContentReadiness({document,getContext:()=>context,viewReported:()=>reported,requestFrame:()=>{}});
  const services=tracker.wrap({projectService:{async readTree(){reads++;return{tasks:[]};}},zcodeAgentService:{onDynamicConversationFrame:()=>callback=>{registrations++;listener=callback;return{dispose(){}};},async subscribeConversationV4(){return{ack:{subscriptionId:'subscription',mode:'snapshot'}};}}});
  const watch=sessionId=>{watchedSession=sessionId??task;return services.zcodeAgentService.onDynamicConversationFrame({workspacePath:'/work',...(sessionId?{sessionId}:{})})(()=>{});};
  return{tracker,services,context,watch,document,observers,createTimeline,setTimelines(...nodes){timelines=nodes;},async mutation(){for(const observer of observers)if(observer.active)queueMicrotask(()=>{if(observer.active)observer.callback([]);});await Promise.resolve();},get reads(){return reads;},get registrations(){return registrations;},set reported(value){reported=value;},mount(total,loaded,rows=true,options){const timeline=createTimeline(total,loaded,rows,options);timelines=[timeline];return timeline;},home(){navigation={};},emit(total,loaded,{sessionId=watchedSession,topic='conversation/'+sessionId}={}){const rows={totalCount:total,window:Array.from({length:loaded},(_,rowId)=>({rowId}))};listener({kind:'complete',deliveryKind:'initial',topic,frame:{topic,payload:{kind:'snapshot',snapshot:{sessionId,rows}}}});}};
}

test('Codex readiness requires the existing initial snapshot and committed timeline rows',async()=>{
  const f=fixture();f.watch();assert.equal(f.registrations,1);assert.equal(f.tracker.check(),'loading');
  f.emit(90,60);assert.equal(f.tracker.check(),'loading');
  f.mount(90,60,false);assert.equal(f.tracker.check(),'loading','row-count attributes alone are not content');
  f.mount(92,62,true);assert.equal(f.tracker.check(),'ready','live rows added after initial snapshot are valid');await f.tracker.ready;
  assert.equal(f.reads,0,'readiness must not send any request');
  f.mount(92,62).dataset.loadingOlder='true';assert.equal(f.tracker.check(),'ready','older paging cannot re-open the startup screen');f.tracker.dispose();
});

test('Codex rejects another session snapshot and accepts a genuinely empty committed history',async()=>{
  const f=fixture();f.watch('other');f.emit(0,0);f.mount(0,0,false);assert.equal(f.tracker.check(),'loading');
  f.watch();f.emit(0,0);assert.equal(f.tracker.check(),'ready');await f.tracker.ready;f.tracker.dispose();
});

test('actual workspace-only frame listener finishes an empty scratch session and diagnostics contain no identity data',async()=>{
  const f=fixture({task:'private-task-id'});f.watch();f.mount(0,0,false);f.emit(0,0);
  assert.equal(f.tracker.check(),'ready');await f.tracker.ready;
  const details=f.tracker.details();assert.equal(details.observed.lastFrame.hasSessionParameter,false);assert.equal(details.observed.matchingSnapshots,1);assert.equal(details.snapshot.totalRows,0);
  assert.doesNotMatch(JSON.stringify(details),/private-task-id|\/work|conversation\//);f.tracker.dispose();
});

test('workspace-only listener rejects mismatched payload identities and wire topics',()=>{
  const f=fixture();f.watch();f.mount(0,0,false);
  f.emit(0,0,{sessionId:'other'});assert.equal(f.tracker.check(),'loading');
  f.emit(0,0,{topic:'conversation/other'});assert.equal(f.tracker.check(),'loading');
  f.emit(0,0);assert.equal(f.tracker.check(),'ready');f.tracker.dispose();
});

test('Codex large raw snapshot counts cannot trap an already committed smaller virtual window',()=>{
  const f=fixture();f.watch();f.emit(16000,400);f.mount(15980,32,true);
  assert.equal(f.tracker.check(),'ready');f.tracker.dispose();
});

test('Codex acknowledged existing subscription plus actual rows can finish when no complete snapshot was observed',async()=>{
  const f=fixture();f.watch();await f.services.zcodeAgentService.subscribeConversationV4({workspacePath:'/work',sessionId:'task'});
  f.mount(5000,40,false);assert.equal(f.tracker.check(),'loading','ACK and counters without rows must not reveal an empty shell');
  f.mount(5000,40,true);assert.equal(f.tracker.check(),'ready');assert.equal(f.registrations,1);assert.equal(f.reads,0);f.tracker.dispose();
});

test('Codex subscription ACK alone cannot invent an empty history or qualify another task',async()=>{
  const f=fixture();await f.services.zcodeAgentService.subscribeConversationV4({workspacePath:'/work',sessionId:'other'});f.mount(10,10,true);
  assert.equal(f.tracker.check(),'loading');f.mount(0,0,false);
  await f.services.zcodeAgentService.subscribeConversationV4({workspacePath:'/work',sessionId:'task'});
  assert.equal(f.tracker.check(),'loading');f.tracker.dispose();
});

test('Codex matching view reporter remains required even after history commit',()=>{
  const f=fixture({reported:false});f.watch();f.emit(1,1);f.mount(1,1);assert.equal(f.tracker.check(),'loading');
  f.reported=true;assert.equal(f.tracker.check(),'ready');f.tracker.dispose();
});

test('hidden A empty cannot block visible current B rows or contaminate readiness diagnostics',()=>{
  const f=fixture({task:'B'});f.watch();f.emit(20,20);
  const a=f.createTimeline(0,0,false,{sessionId:'A',hidden:true}),b=f.createTimeline(20,20,true,{sessionId:'B'});f.setTimelines(a,b);
  assert.equal(f.document.querySelector('[data-v4-timeline-scroll="true"]'),a);assert.equal(f.tracker.check(),'ready');
  assert.deepEqual(f.tracker.details().timeline,{present:true,totalRows:20,windowRows:20,hasRenderedRow:true});f.tracker.dispose();
});

test('hidden A ready cannot reveal a visible B whose row rendering is still pending',async()=>{
  const f=fixture({task:'B'});f.watch();f.emit(20,20);
  const a=f.createTimeline(20,20,true,{sessionId:'A',hidden:true}),b=f.createTimeline(20,20,false,{sessionId:'B'});f.setTimelines(a,b);
  assert.equal(f.tracker.check(),'loading');assert.equal(f.tracker.details().timeline.hasRenderedRow,false);
  b.querySelector=()=>({});await f.mutation();assert.equal(f.tracker.check(),'ready');assert(f.observers.every(watch=>!watch.active));f.tracker.dispose();
});

test('a visible foreign-session pane and a hidden same-session duplicate cannot qualify the current view',()=>{
  const f=fixture({task:'B'});f.watch();f.emit(20,20);
  const foreign=f.createTimeline(20,20,true,{sessionId:'A'}),hidden=f.createTimeline(20,20,true,{sessionId:'B',hidden:true});f.setTimelines(foreign,hidden);
  assert.equal(f.tracker.check(),'loading');assert.equal(f.tracker.details().timeline.present,false);
  const current=f.createTimeline(20,20,false,{sessionId:'B'});f.setTimelines(hidden,foreign,current);assert.equal(f.tracker.check(),'loading');
  current.querySelector=()=>({});assert.equal(f.tracker.check(),'ready');f.tracker.dispose();
});

test('readiness requires real geometry and native session ownership and wakes on visibility changes',async()=>{
  const f=fixture();f.watch();f.emit(1,1);const timeline=f.mount(1,1,true,{sessionId:null});
  assert.equal(f.tracker.check(),'loading','a markerless visible pane cannot borrow another session ACK');
  timeline.owner.sessionId='task';timeline.rect.width=0;assert.equal(f.tracker.check(),'loading');
  timeline.rect.width=390;timeline.owner.style.display='none';assert.equal(f.tracker.check(),'loading');
  timeline.owner.style.display='block';await f.mutation();assert.equal(f.tracker.check(),'ready');f.tracker.dispose();
});

test('Codex home waits for catalogue response and mounted navigation, including empty catalogues',async()=>{
  const f=fixture({task:null});f.home();assert.equal(f.tracker.check(),'loading');await f.services.projectService.readTree();
  assert.equal(f.tracker.check(),'ready');assert.equal(f.reads,1);f.tracker.dispose();
});

test('Codex subscription failure settles as error instead of revealing an empty task',async()=>{
  const f=fixture(),error=Error('history unavailable');
  const service=f.tracker.wrap({agent:{subscribeConversationV4:async()=>{throw error;}}});
  await assert.rejects(service.agent.subscribeConversationV4({workspacePath:'/work',sessionId:'task'}),/history unavailable/);
  assert.equal(f.tracker.check(),'error');await assert.rejects(f.tracker.ready,/history unavailable/);f.tracker.dispose();
});

test('Codex bootstrap does not remove its neutral boundary after view selection but before content readiness',async()=>{
  const content=deferred(),stages=[],controller={initialViewReady:Promise.resolve(),initialContentReady:content.promise,dispose(){}};let exposed=false;
  const pending=loadCodexMobile({origin:'https://fixture.test',request:async()=>new Response(JSON.stringify({authenticated:true,workspaces:[]})),loadModule:async path=>path==='/codex-browser-adapter.mjs'?{mountCodexOriginalH5:async()=>controller}:{__codexOriginalConnect:async()=>({}),__codexBrandIcon:''},onController:value=>{exposed=value===controller;},onStage:name=>stages.push(name)});
  await tick();assert.equal(exposed,true);assert.equal(stages.includes('mounted'),false);
  content.resolve();const result=await pending;assert.equal(stages.includes('mounted'),true);result.controller.dispose();
});
