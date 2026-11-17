import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationReadServices} from '../frontend-stage/conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';
import {projectConversationRows} from '../../backend/conversation-rows.mjs';

const sessionId='00000000-0000-4000-8000-000000000042';
const params={workspacePath:'/fixture/rescan',sessionId};
const thread={id:sessionId,cwd:params.workspacePath,createdAt:1};

// A real local Codex window index identifies itself with a per-scan generation,
// so a cache eviction or a file touch changes sourceEpoch while every row keeps
// the same identity. The fake backend reproduces exactly that: the same rows can
// be published under a new epoch, and a rewritten conversation changes the rows.
function fixture(t,{turnCount=60}={}){
 const turns=Array.from({length:turnCount},(_,index)=>({id:'turn-'+index,status:'completed',items:[{id:'user-'+index,type:'userMessage',content:[{type:'text',text:'Question '+index}]},{id:'answer-'+index,type:'agentMessage',text:'Answer '+index}]}));
 let scan=1,rewritten='';
 const rows=()=>projectConversationRows({thread,turns:turns.map(turn=>({...turn,items:turn.items.map(item=>item.type==='agentMessage'?{...item,text:item.text+rewritten}:item)}))});
 const calls=[];
 const api={get:async path=>{
  assert(path.startsWith('/api/history-window?'),'must never traverse the full body history API');
  const query=new URL(path,'http://local').searchParams;calls.push(Object.fromEntries(query));
  const sourceEpoch=query.get('sourceEpoch')??undefined;
  if(sourceEpoch!==undefined&&sourceEpoch!=='scan-'+scan)throw Object.assign(new Error('历史索引已更新'),{code:'HISTORY_WINDOW_CHANGED',statusCode:409});
  const all=rows(),total=all.length,limit=Number(query.get('limit')||60),beforeRowId=query.has('beforeRowId')?Number(query.get('beforeRowId')):undefined,fromRowId=query.has('fromRowId')?Number(query.get('fromRowId')):undefined,metadataOnly=query.get('metadataOnly')==='1';
  if(beforeRowId!==undefined&&beforeRowId>total+1)throw Object.assign(new Error('历史窗口已更新'),{code:'HISTORY_WINDOW_CHANGED',statusCode:409});
  const end=beforeRowId===undefined?total:beforeRowId-1,start=metadataOnly?end:fromRowId===undefined?Math.max(0,end-limit):fromRowId-1;
  return{thread,sourceEpoch:'scan-'+scan,revision:'revision-'+scan+'-'+rewritten,rows:{window:metadataOnly?[]:all.slice(start,end),totalCount:total,firstRowId:total?1:null},hasMore:start>0,lastTurn:null};
 }};
 const native=new Emitter();
 const service=createConversationReadServices({indexedHistory:true,api,baseServices:{project:{readTree:async()=>({tasks:[{taskId:sessionId,workspacePath:params.workspacePath}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}}});
 const agent=service.channels['zcode-agent'],frames=[];
 const listener=agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));
 t.after(()=>{listener.dispose();service.dispose();native.dispose();});
 return{service,agent,frames,calls,rescan(){scan+=1;},rewrite(value){rewritten=value;scan+=1;},total:()=>rows().length};
}

test('a re-scanned window index keeps the client epoch so the next older page still merges',async t=>{
 const f=await fixture(t);
 const {ack}=await f.agent.subscribeConversationV4(params);
 const initial=f.frames[0].frame.payload.snapshot,logEpoch=initial.logEpoch,total=f.total();
 assert.equal(initial.rows.totalCount,total);
 assert.equal(initial.rows.window.length,60);
 assert.equal(initial.rows.window[0].rowId,total-59);

 // The index cache is evicted (or the rollout file is touched) and re-scanned
 // under the same content: only the backend epoch changes.
 f.rescan();
 const older=await f.agent.conversationRowsRangeV4({...params,beforeRowId:initial.rows.window[0].rowId,limit:60});
 assert.equal(older.rows.length,60,'the reader gesture survives the re-scan');
 assert.deepEqual(older.rows.map(row=>row.rowId),Array.from({length:60},(_,index)=>index+1));
 assert.equal(older.atLogEpoch,logEpoch,'the returned page keeps the client log epoch');
 assert(older.atSeq>=initial.seq,'the page reports the current published sequence');
 assert.equal(older.hasMore,false);

 // The recovery frame published during the retry keeps the same epoch and the
 // already visible window, so the reader never sees the conversation collapse
 // back to an empty tail while the retried page is still in flight.
 const recovery=f.frames.filter(frame=>frame.deliveryKind==='recovery').at(-1);
 assert(recovery,'a recovery snapshot is published for the changed window');
 assert.equal(recovery.frame.payload.snapshot.logEpoch,logEpoch);
 assert.equal(recovery.frame.payload.snapshot.rows.window.length,60);
 assert.equal(recovery.frame.payload.snapshot.rows.window[0].rowId,total-59);

 await f.agent.resyncConversationV4({...params,subscriptionId:ack.subscriptionId});
 const resynced=f.frames.at(-1).frame.payload.snapshot;
 assert.equal(resynced.rows.window.length,total,'resync keeps every loaded row');
 assert.equal(resynced.rows.window[0].rowId,1);
 assert.equal(resynced.logEpoch,logEpoch);
});

test('a re-scanned window index can still page back to the very start',async t=>{
 const f=await fixture(t);
 await f.agent.subscribeConversationV4(params);
 const initial=f.frames[0].frame.payload.snapshot;
 let cursor=initial.rows.window[0].rowId,pages=0;
 for(;;){
  f.rescan();
  const page=await f.agent.conversationRowsRangeV4({...params,beforeRowId:cursor,limit:60});
  pages+=1;
  assert.equal(page.atLogEpoch,initial.logEpoch,'each page keeps the client epoch across re-scans');
  if(!page.rows.length)break;
  assert.equal(page.rows.at(-1).rowId,cursor-1,'pages stay contiguous');
  cursor=page.rows[0].rowId;
  if(!page.hasMore)break;
  assert(pages<10,'paging terminates');
 }
 assert.deepEqual(f.calls.filter(call=>call.sourceEpoch==='scan-1').length>0,true,'a range read started under the old epoch');
 assert.ok(f.calls.some(call=>call.sourceEpoch===undefined),'the retry reads the new epoch without pinning the stale one');
});

test('a rewritten conversation still rotates the epoch so stale rows are never merged',async t=>{
 const f=await fixture(t);
 await f.agent.subscribeConversationV4(params);
 const initial=f.frames[0].frame.payload.snapshot;
 f.rewrite(' changed');
 await assert.rejects(f.agent.conversationRowsRangeV4({...params,beforeRowId:initial.rows.window[0].rowId,limit:60}),{code:'HISTORY_WINDOW_CHANGED'});
 const recovery=f.frames.at(-1);
 assert.equal(recovery.deliveryKind,'recovery');
 assert.notEqual(recovery.frame.payload.snapshot.logEpoch,initial.logEpoch,'rewritten history gets a new log epoch');
 assert.equal(recovery.frame.payload.snapshot.rows.window.length,60,'the client restarts from a clean tail window');
});
