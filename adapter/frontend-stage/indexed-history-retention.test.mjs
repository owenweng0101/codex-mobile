import test from 'node:test';
import assert from 'node:assert/strict';
import {RolloutConversationIndex} from '../../backend/conversation-index.mjs';
import {createConversationReadServices} from './conversation-read.mjs';
import {k as applyDeltas} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js';
import {Emitter} from '../vendor/rpc.mjs';
import {conversationFixture,fixtureId as threadId,fixtureThread as thread} from '../../backend/test/conversation-fixture.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
for(const order of ['resync-first','range-first'])test('serialized '+order+' cannot erase a concurrently requested older window',{timeout:5000},async t=>{
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),native=new Emitter(),frames=[];let heldKind,gate,entered,headReads=0,rangeReads=0,applied;
 const params={workspacePath:thread.cwd,sessionId:threadId};
 const api={get:async path=>{
  const url=new URL(path,'http://fixture');assert.equal(url.pathname,'/api/history-window');const query=url.searchParams,isRange=query.has('beforeRowId');if(isRange)rangeReads++;else if(query.has('fromRowId'))headReads++;
  const result=await index.read(f.file,{threadId,thread,limit:Number(query.get('limit')||60),beforeRowId:query.has('beforeRowId')?Number(query.get('beforeRowId')):undefined,fromRowId:query.has('fromRowId')?Number(query.get('fromRowId')):undefined,sourceEpoch:query.get('sourceEpoch')??undefined,metadataOnly:query.get('metadataOnly')==='1'});
  const page={...result,thread,turns:result.lastTurn?[result.lastTurn]:[],activeTurn:null};
  if(heldKind&&(heldKind==='range'&&isRange||heldKind==='head'&&!isRange&&query.has('fromRowId'))){heldKind=null;entered.resolve();await gate.promise;}
  return page;
 }};
 const service=createConversationReadServices({indexedHistory:true,api,baseServices:{project:{readTree:async()=>({tasks:[{taskId:threadId,workspacePath:thread.cwd}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}}});
 const agent=service.channels['zcode-agent'],listener=agent.onDynamicConversationFrame(params)(frame=>{frames.push(frame);applied=frame.frame.payload.kind==='snapshot'?frame.frame.payload.snapshot:{...applyDeltas(applied,frame.frame.payload.deltas),seq:frame.frame.toSeq};});t.after(()=>{listener.dispose();service.dispose();native.dispose();});
 const {ack}=await agent.subscribeConversationV4(params),first=frames.at(-1).frame.payload.snapshot.rows.window[0].rowId;
 gate=deferred();entered=deferred();heldKind=order==='resync-first'?'head':'range';
 const range=async()=>{
  const value=await agent.conversationRowsRangeV4({...params,beforeRowId:first,limit:17});
  if(value.atLogEpoch===applied.logEpoch&&applied.rows.window[0].rowId===first){
   const merged=new Map(applied.rows.window.map(row=>[row.rowId,row]));for(const row of value.rows)merged.set(row.rowId,row);
   applied={...applied,rows:{...applied.rows,window:[...merged.values()].sort((a,b)=>a.rowId-b.rowId)}};
  }
  return value;
 };
 const resync=()=>agent.resyncConversationV4({...params,subscriptionId:ack.subscriptionId});
 let olderPromise,resyncPromise;
 try{
  if(order==='resync-first'){resyncPromise=resync();await entered.promise;olderPromise=range();await new Promise(r=>setImmediate(r));assert.equal(rangeReads,0,'range is queued behind the held resync');}
  else{olderPromise=range();await entered.promise;resyncPromise=resync();await new Promise(r=>setImmediate(r));assert.equal(headReads,0,'resync is queued behind the held range');}
 }finally{gate.resolve();}
 const [older]=await Promise.all([olderPromise,resyncPromise]);assert(older.rows.length>0);assert.equal(applied.rows.window[0].rowId,older.rows[0].rowId);assert(applied.rows.window.some(row=>row.rowId===first));
});
