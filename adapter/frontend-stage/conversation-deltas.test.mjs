import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationReadServices,projectConversationV4} from './conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';
import {k as applyDeltas,w as frameSchema} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js';
const id='11111111-1111-4111-8111-111111111111',params={workspacePath:'/fixture',sessionId:id};
function fixture(t){
 const native=new Emitter(),frames=[],times=[];
 const page={thread:{id,cwd:params.workspacePath,name:'fixture'},activeTurn:'turn',turns:[{id:'turn',startedAt:1700000000,status:'inProgress',items:Array.from({length:70},(_,i)=>({id:'a'+i,type:'agentMessage',text:'x'.repeat(2000)}))}]};
 let afterRead,applied;
 const service=createConversationReadServices({writable:true,api:{get:async()=>{const result=structuredClone(page);await afterRead?.();return result;}},baseServices:{project:{readTree:async()=>({tasks:[{taskId:id,workspacePath:params.workspacePath}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}}});
 const agent=service.channels['zcode-agent'];agent.onDynamicConversationFrame(params)(wire=>{
  const frame=wire.frame;assert.equal(frameSchema.safeParse(frame).success,true);
  if(frame.payload.kind==='deltas'){assert.equal(frame.fromSeq,applied.seq);applied={...applyDeltas(applied,frame.payload.deltas),seq:frame.toSeq};}
  else applied=frame.payload.snapshot;
  frames.push(wire);times.push(frame.sentAt);
 });
 t.after(()=>{service.dispose();native.dispose();});
 return{page,frames,times,service,agent,native,get applied(){return applied;},set afterRead(value){afterRead=value;}};
}
test('one-second bursts coalesce to latest rows/state, delta reduces bytes and unchanged state emits nothing',async t=>{
 const f=fixture(t);const {ack}=await f.agent.subscribeConversationV4(params);
 assert.equal(f.applied.rows.window.length,60);
 for(let i=0;i<25;i++){f.page.turns[0].items.at(-1).text='x'.repeat(2000)+' latest '+i;f.native.fire({});}
 f.page.thread.name='new title';f.page.queue={items:[{id:'queued',text:'pending',status:'queued'}]};
 await f.service.refreshWorkspace(params);
 assert.equal(f.frames.length,2);assert.ok(f.times[1]-f.times[0]>=1000);
 assert.equal(f.applied.rows.window.at(-1).text,'x'.repeat(2000)+' latest 24');assert.equal(f.applied.meta.title,'new title');assert.equal(f.applied.queue.items.length,1);
 assert.equal(f.frames[1].deliveryKind,'online');assert.ok(JSON.stringify(f.frames[1]).length<JSON.stringify(f.frames[0]).length/20);
 await f.service.refreshWorkspace(params);assert.equal(f.frames.length,2);
 f.page.turns[0].items.push({id:'append',type:'agentMessage',text:'appended'});
 await f.service.refreshWorkspace(params);assert.equal(f.applied.rows.totalCount,72);assert.equal(f.applied.rows.window.at(-1).text,'appended');
 f.page.turns[0].items.splice(-2,1);await f.service.refreshWorkspace(params);
 assert.equal(f.frames.at(-1).frame.payload.kind,'snapshot');
 await f.agent.resyncConversationV4({...params,subscriptionId:ack.subscriptionId});assert.equal(f.frames.at(-1).deliveryKind,'recovery');
});
test('native change during an in-flight read is emitted by trailing refresh without another event',async t=>{
 const f=fixture(t);await f.agent.subscribeConversationV4(params);
 let release,entered;const readStarted=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);
 f.page.turns[0].items.at(-1).text='first';f.afterRead=async()=>{f.afterRead=null;entered();await blocked;};
 const pending=f.service.refreshWorkspace(params);await readStarted;
 f.page.turns[0].items.at(-1).text='last change';f.native.fire({});release();await pending;
 assert.equal(f.applied.rows.window.at(-1).text,'last change');assert.equal(f.frames.length,3);assert.ok(f.times[2]-f.times[1]>=1000);
});
test('native turn timing uses seconds, keeps header IDs through completion and never freezes running time',()=>{
 const page={thread:{id,cwd:params.workspacePath},activeTurn:'t',turns:[{id:'t',startedAt:1700000000,durationMs:1,status:'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'question'}]},{id:'a',type:'agentMessage',text:'answer'}]}]};
 const initial=projectConversationV4(page,{writable:true});const header=initial.rows.window[0];
 assert.equal(header.kind,'turnHeader');assert.equal(header.origin,'userInput');assert.equal(header.startedAt,1700000000000);assert.equal(header.activeMs,undefined);assert.equal(header.endedAt,undefined);assert.equal(initial.inputRouting.mode,'enqueue');assert.equal(initial.config.followupMode,'queue');
 Object.assign(page.turns[0],{status:'completed',completedAt:1700000005,durationMs:4500});page.activeTurn=null;page.queue={items:[{id:'q',text:'pending'}]};
 const done=projectConversationV4(page,{writable:true});assert.deepEqual(done.rows.window.map(r=>[r.rowId,r.entityId]),initial.rows.window.map(r=>[r.rowId,r.entityId]));
 assert.equal(done.rows.window[0].activeMs,4500);assert.equal(done.rows.window[0].endedAt,1700000005000);assert.equal(done.rows.window[0].state,'completedSuccess');assert.equal(done.inputRouting.mode,'enqueue');
 page.turns[0].items.shift();assert.equal(projectConversationV4(page).rows.window[0].origin,'backgroundResult');
 delete page.turns[0].startedAt;page.thread.createdAt=1600000000;const untimed=projectConversationV4(page);assert.ok(untimed.rows.window.every(row=>row.kind!=='turnHeader'&&row.createdAt===0));
});
test('deferred initial delivery lets a remote caller activate after ACK and is canceled on dispose',async()=>{
 const native=new Emitter(),params={workspacePath:'/fixture',sessionId:id},api={get:async()=>({thread:{id,cwd:'/fixture'},turns:[]})},baseServices={project:{readTree:async()=>({tasks:[{taskId:id,workspacePath:'/fixture'}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}};
 const service=createConversationReadServices({api,baseServices,deferInitialFrame:true});const agent=service.channels['zcode-agent'];const {ack}=await agent.subscribeConversationV4(params);const frames=[];agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));assert.equal(frames.length,0);await new Promise(r=>setTimeout(r,140));assert.equal(frames.length,1);assert.equal(frames[0].subscriptionId,ack.subscriptionId);assert.equal(frames[0].deliveryKind,'initial');service.dispose();native.dispose();
});
