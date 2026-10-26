import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationReadServices} from './conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';
const id='11111111-1111-4111-8111-111111111111',params={workspacePath:'/fixture',sessionId:id};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
 const events=new Emitter(),frames=[],page={thread:{id,cwd:'/fixture',name:'fixture'},turns:[{id:'turn',status:'inProgress',items:[{id:'answer',type:'agentMessage',text:'first'}]}]};
 let reads=0,fail=false;
 const service=createConversationReadServices({api:{get:async()=>{reads++;if(fail)throw Error('temporary read failure');return structuredClone(page);}},baseServices:{project:{readTree:async()=>({tasks:[{taskId:id,workspacePath:'/fixture'}]})},'zcode-task':{onDynamicTaskEvent:()=>events.event}}});
 const agent=service.channels['zcode-agent'],listener=agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));
 t.after(()=>{listener.dispose();service.dispose();events.dispose();});
 return{service,agent,page,events,frames,get reads(){return reads;},set fail(value){fail=value;}};
}
test('unchanged native events stay within one complete-history read per second and retain the trailing update',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 const f=fixture(t);await f.agent.subscribeConversationV4(params);assert.equal(f.reads,1);
 t.mock.timers.tick(1100);f.events.fire({});t.mock.timers.tick(0);await flush();assert.equal(f.reads,2);
 for(let i=0;i<20;i++){t.mock.timers.tick(20);f.events.fire({});t.mock.timers.tick(0);await flush();}
 assert.equal(f.reads,2);assert.equal(f.frames.length,1);
 f.page.turns[0].items[0].text='latest native text';
 t.mock.timers.tick(600);await flush();assert.equal(f.reads,3);assert.equal(f.frames.length,2);
 assert.equal(f.frames.at(-1).frame.payload.deltas.find(delta=>delta.op==='row.upserted').row.text,'latest native text');
});
test('repeated failing reads are also throttled and a later native event can recover',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 const f=fixture(t);await f.agent.subscribeConversationV4(params);f.fail=true;
 t.mock.timers.tick(1100);f.events.fire({});t.mock.timers.tick(0);await flush();assert.equal(f.reads,2);
 for(let i=0;i<10;i++){t.mock.timers.tick(20);f.events.fire({});t.mock.timers.tick(0);await flush();}
 assert.equal(f.reads,2);
 f.fail=false;f.page.turns[0].items[0].text='recovered';t.mock.timers.tick(800);await flush();assert.equal(f.reads,3);assert.equal(f.frames.length,2);
});
test('explicit resync still immediately publishes a full recovery frame',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 const f=fixture(t);const {ack}=await f.agent.subscribeConversationV4(params);
 await f.agent.resyncConversationV4({...params,subscriptionId:ack.subscriptionId});
 assert.equal(f.reads,2);assert.equal(f.frames.length,2);assert.equal(f.frames[1].deliveryKind,'recovery');assert.equal(f.frames[1].frame.payload.kind,'snapshot');
});
