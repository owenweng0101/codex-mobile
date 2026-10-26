import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageQueue } from '../queue.mjs';
import { deliverMessage, messageBusy, hasPendingDelivery } from '../message-delivery.mjs';

test('strict admission never writes a queue item when desktop becomes busy during preparation', async t => {
  const stateDir=await mkdtemp(join(tmpdir(),'codex-delivery-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  let active=false, sent=0;
  const queue=await new MessageQueue({stateDir,send:async()=>{sent++;},isActive:()=>active}).init();
  const before=await readFile(queue.path,'utf8');
  const input={threadId:'fixture-thread',requestId:'strict-request',text:'fixture only',delivery:'startNow'};
  await assert.rejects(deliverMessage(input,{
    receipt:()=>undefined,
    prepare:async()=>{active=true;},
    isBusy:()=>active||queue.hasPending(input.threadId),
    enqueue:data=>queue.enqueue(data.threadId,data),
    dispatch:async()=>{sent++;return{turn:{id:'fixture-turn'}};},
  }),{code:'SESSION_BUSY',statusCode:409,sent:false});
  assert.deepEqual(queue.get(input.threadId).items,[]);
  assert.equal(await readFile(queue.path,'utf8'),before);
  assert.equal(sent,0);
});

test('legacy automatic queue remains intact while strict sends reject that pending queue', async t => {
  const stateDir=await mkdtemp(join(tmpdir(),'codex-delivery-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const queue=await new MessageQueue({stateDir,send:async()=>{throw Error('must not run while busy');},isActive:()=>true}).init();
  const dependencies={receipt:()=>undefined,prepare:async()=>{},isBusy:()=>true,enqueue:data=>queue.enqueue(data.threadId,data),dispatch:async()=>{throw Error('busy request must not dispatch');}};
  const first=await deliverMessage({threadId:'fixture-thread',requestId:'legacy-request',text:'legacy'},dependencies);
  assert.equal(first.queued,true);
  assert.equal(queue.get('fixture-thread').items.length,1);
  await assert.rejects(deliverMessage({threadId:'fixture-thread',requestId:'strict-request',text:'strict',delivery:'startNow'},dependencies),{code:'SESSION_BUSY'});
  assert.equal(queue.get('fixture-thread').items.length,1);
});

test('successful native receipt replays during busy state; invalid delivery cannot prepare or queue', async () => {
  let prepared=0, dispatched=0, queued=0;
  const accepted={turn:{id:'native-turn'}};
  const dependencies={receipt:data=>data.requestId==='done'?Promise.resolve(accepted):undefined,prepare:async()=>{prepared++;},isBusy:()=>true,enqueue:async()=>{queued++;},dispatch:async()=>{dispatched++;}};
  assert.deepEqual(await deliverMessage({delivery:'startNow',requestId:'done'},dependencies),accepted);
  await assert.rejects(deliverMessage({delivery:'wrong',requestId:'new'},dependencies),{code:'INVALID_DELIVERY',statusCode:400,sent:false});
  assert.equal(prepared,0);assert.equal(dispatched,0);assert.equal(queued,0);
});

test('strict explicit send can continue an idle thread with an empty paused queue', async t => {
  const stateDir=await mkdtemp(join(tmpdir(),'codex-delivery-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const queue=await new MessageQueue({stateDir,send:async()=>{},isActive:()=>false}).init();
  await queue.handle('fixture-thread',{action:'pause'});
  assert.equal(queue.hasPending('fixture-thread'),true);
  const input={threadId:'fixture-thread',requestId:'continue',text:'fixture',delivery:'startNow'};
  const result=await deliverMessage(input,{receipt:()=>undefined,prepare:async()=>{},isBusy:data=>hasPendingDelivery(data,queue),enqueue:async()=>{throw Error('explicit send must not queue');},dispatch:async()=>({turn:{id:'native-continuation'}})});
  assert.equal(result.turn.id,'native-continuation');
  assert.equal(queue.get('fixture-thread').paused,true);
  assert.equal(queue.get('fixture-thread').items.length,0);
  assert.equal(hasPendingDelivery({...input,delivery:undefined},queue),false);
});

test('late dispatch busy rejection or unknown native receipt never falls back to queue', async () => {
  let queued=0;
  const dependencies={receipt:()=>undefined,prepare:async()=>{},isBusy:()=>false,enqueue:async()=>{queued++;},dispatch:async()=>{throw messageBusy();}};
  await assert.rejects(deliverMessage({delivery:'startNow'},dependencies),{code:'SESSION_BUSY',sent:false});
  dependencies.dispatch=async()=>{throw Object.assign(Error('lost receipt'),{code:'DESKTOP_TIMEOUT',outcomeUnknown:true});};
  await assert.rejects(deliverMessage({delivery:'startNow'},dependencies),{code:'DESKTOP_TIMEOUT',outcomeUnknown:true});
  assert.equal(queued,0);
});

test('automatic admission continues an idle conversation with an empty paused queue without creating a card',async t=>{const stateDir=await mkdtemp(join(tmpdir(),'codex-idle-admission-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));const queue=await new MessageQueue({stateDir,send:async()=>{},isActive:()=>false}).init();await queue.handle('task',{action:'pause'});const input={threadId:'task',requestId:'idle',text:'next'},calls=[];const result=await deliverMessage(input,{receipt:()=>null,prepare:async()=>{},isBusy:data=>hasPendingDelivery(data,queue),enqueue:async()=>assert.fail('must not queue'),dispatch:async data=>{calls.push(data.requestId);return{turn:{id:'next'}};}});assert.equal(result.turn.id,'next');assert.deepEqual(calls,['idle']);assert.equal(queue.get('task').items.length,0);});
