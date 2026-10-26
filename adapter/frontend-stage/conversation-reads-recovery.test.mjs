import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationReadServices} from './conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';

const id='00000000-0000-4000-8000-000000000091',params={workspacePath:'/fixture/recovery',sessionId:id};
const latest={thread:{id,cwd:params.workspacePath},turns:[{id:'latest',status:'completed',items:[{id:'answer',type:'agentMessage',text:'latest'}]}],nextCursor:'older'};
const older={thread:{...latest.thread},turns:[{id:'old',status:'completed',items:[{id:'old-answer',type:'agentMessage',text:'old'}]}],nextCursor:null};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(t,api,options={}){
 const native=new Emitter();
 const service=createConversationReadServices({api,baseServices:{project:{readTree:async()=>({tasks:[{taskId:id,workspacePath:params.workspacePath}],projects:[]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}},...options});
 const agent=service.channels['zcode-agent'],frames=[];
 agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));
 t.after(()=>{service.dispose();native.dispose();});return{service,agent,frames,native};
}

test('overlapping subscriptions share latest and older reads but own their frame identity',async t=>{
 const gate=deferred(),entered=deferred(),gets=[];
 const f=fixture(t,{get:async path=>{gets.push(path);if(!path.includes('&cursor=')){entered.resolve();await gate.promise;}return structuredClone(path.includes('&cursor=')?older:latest);}});
 const a=f.agent.subscribeConversationV4(params),b=f.agent.subscribeConversationV4(params);
 await entered.promise;gate.resolve();const results=await Promise.all([a,b]);
 assert.equal(gets.length,2);assert.notEqual(results[0].ack.subscriptionId,results[1].ack.subscriptionId);
 assert.notEqual(results[0].ack.logEpoch,results[1].ack.logEpoch);
 for(const frame of f.frames)assert.deepEqual(frame.frame.payload.snapshot.rows.window.map(row=>[row.rowId,row.text]),[[1,'old'],[2,'latest']]);
});

test('a failed shared history read releases the pending entry for retry',async t=>{
 let reads=0;
 const f=fixture(t,{get:async()=>{if(++reads===1)throw Error('temporary read failure');return structuredClone({...latest,nextCursor:null});}});
 await assert.rejects(f.agent.subscribeConversationV4(params),/temporary read/);
 await f.agent.subscribeConversationV4(params);assert.equal(reads,2);assert.equal(f.frames.length,1);
});

test('history has an aggregate deadline, retry works and late older results are not cached',async t=>{
 const oldRead=deferred();let reads=0,oldReads=0;
 const f=fixture(t,{get:async path=>{reads++;if(path.includes('&cursor=')){if(++oldReads===1)return oldRead.promise;return structuredClone(older);}return structuredClone(latest);}},{historyTimeoutMs:25});
 await assert.rejects(f.agent.subscribeConversationV4(params),e=>e.code==='CODEX_HISTORY_TIMEOUT');
 oldRead.resolve(structuredClone(older));await new Promise(r=>setImmediate(r));
 await f.agent.subscribeConversationV4(params);assert.equal(reads,4);assert.equal(oldReads,2);
});

test('revision validation bypasses an overlapping rendering snapshot',async t=>{
 let block=false,reads=0;const gate=deferred(),entered=deferred(),options=[];
 const f=fixture(t,{get:async(_path,input)=>{options.push(input);reads++;const result=structuredClone({...latest,nextCursor:null});if(block){block=false;entered.resolve();await gate.promise;}return result;}});
 const {ack}=await f.agent.subscribeConversationV4(params),revision=f.frames[0].frame.payload.snapshot.revision;
 block=true;const rendering=f.agent.subscribeConversationV4(params);await entered.promise;
 const valid=await f.service.validateRevision({...params,baseRevision:revision,baseLogEpoch:ack.logEpoch});
 assert.equal(valid,true);assert.equal(reads,3);assert.equal(options.at(-1).shareRead,false);assert.ok(options.at(-1).signal instanceof AbortSignal);
 gate.resolve();await rendering;
});

test('native invalidation prevents a new subscriber joining a pre-change snapshot',async t=>{
 const gate=deferred(),entered=deferred();let reads=0,text='before';
 const f=fixture(t,{get:async()=>{reads++;const result=structuredClone({...latest,nextCursor:null});result.turns[0].items[0].text=text;if(reads===1){entered.resolve();await gate.promise;}return result;}});
 const first=f.agent.subscribeConversationV4(params);await entered.promise;text='after';f.native.fire({});
 const second=f.agent.subscribeConversationV4(params);await second;
 assert.equal(reads,2);assert.equal(f.frames[0].frame.payload.snapshot.rows.window[0].text,'after');gate.resolve();await first;
});

function imageApi(fetchImpl){return{origin:'http://fixture.invalid',bearer:'fixture',get:async()=>structuredClone({...latest,nextCursor:null}),fetch:fetchImpl};}
const ref='/api/attachment?id='+'a'.repeat(48),range={...params,ref,offset:0,limit:100};
test('concurrent image chunk reads share bytes while every caller reauthorizes',async t=>{
 const gate=deferred(),entered=deferred();let fetches=0,authorizations=0;
 const f=fixture(t,imageApi(async()=>{fetches++;entered.resolve();await gate.promise;return new Response('image bytes',{headers:{'content-type':'image/png'}});}),{resolveAttachment:async()=>{authorizations++;return{id:'a'.repeat(48)};}});
 const a=f.agent.attachmentReadV4(range),b=f.agent.attachmentReadV4(range);await entered.promise;gate.resolve();
 const values=await Promise.all([a,b]);assert.deepEqual(values[0],values[1]);assert.equal(fetches,1);assert.equal(authorizations,2);
 await f.agent.attachmentReadV4(range);assert.equal(fetches,1);assert.equal(authorizations,3);
});

test('image timeout releases pending bytes and a late response never poisons retry',async t=>{
 const late=deferred();let fetches=0;
 const f=fixture(t,imageApi(async()=>++fetches===1?late.promise:new Response('fresh',{headers:{'content-type':'image/png'}})),{mediaTimeoutMs:25,resolveAttachment:async()=>({id:'a'.repeat(48)})});
 await assert.rejects(f.agent.attachmentReadV4(range),e=>e.code==='CODEX_MEDIA_TIMEOUT');
 late.resolve(new Response('stale',{headers:{'content-type':'image/png'}}));await new Promise(r=>setImmediate(r));
 const result=await f.agent.attachmentReadV4(range);assert.equal(Buffer.from(result.dataBase64,'base64').toString(),'fresh');assert.equal(fetches,2);
});

test('disposing the connection rejects pending reads immediately',async t=>{
 const entered=deferred();
 const f=fixture(t,{get:async()=>{entered.resolve();return new Promise(()=>{});}});
 const pending=f.agent.subscribeConversationV4(params);await entered.promise;f.service.dispose();
 await assert.rejects(pending,e=>e.code==='CODEX_CONNECTION_CLOSED');
});


test('a connection disposed during scope lookup cannot create a late subscription',async()=>{
 const entered=deferred(),gate=deferred();let reads=0,subscriptions=0;
 const service=createConversationReadServices({api:{get:async()=>{reads++;return structuredClone(latest);}},baseServices:{project:{readTree:async()=>{entered.resolve();await gate.promise;return{tasks:[{taskId:id,workspacePath:params.workspacePath}]};}},'zcode-task':{onDynamicTaskEvent:()=>{subscriptions++;return()=>({dispose(){}});}}}});
 const pending=service.channels['zcode-agent'].subscribeConversationV4(params);await entered.promise;service.dispose();gate.resolve();
 await assert.rejects(pending,e=>e.code==='CODEX_CONNECTION_CLOSED');assert.equal(reads,0);assert.equal(subscriptions,0);
});
