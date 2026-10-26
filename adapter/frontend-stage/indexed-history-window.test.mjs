import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,stat,utimes} from 'node:fs/promises';
import {createConversationReadServices} from './conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';
import {RolloutConversationIndex} from '../../backend/conversation-index.mjs';
import {projectConversationRows} from '../../backend/conversation-rows.mjs';
import {conversationFixture,fixtureId,fixtureThread,turnRecords} from '../../backend/test/conversation-fixture.mjs';
const params={sessionId:fixtureId,workspacePath:fixtureThread.cwd};
async function fixture(t){
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),calls=[],frames=[],events=new Emitter();let gate=null;
 const api={async get(path,options){calls.push({path,signal:options?.signal});assert(path.startsWith('/api/history-window?'),'must never traverse the full body history API');const q=new URL(path,'http://local').searchParams;const page=await index.read(f.file,{threadId:fixtureId,thread:fixtureThread,limit:Number(q.get('limit')||60),beforeRowId:q.has('beforeRowId')?Number(q.get('beforeRowId')):undefined,fromRowId:q.has('fromRowId')?Number(q.get('fromRowId')):undefined,sourceEpoch:q.get('sourceEpoch')??undefined,metadataOnly:q.get('metadataOnly')==='1'});if(gate&&q.has('beforeRowId'))await gate;return{thread:fixtureThread,turns:page.lastTurn?[page.lastTurn]:[],...page};}};
 const service=createConversationReadServices({indexedHistory:true,api,baseServices:{project:{readTree:async()=>({tasks:[{taskId:fixtureId,workspacePath:fixtureThread.cwd}]})},'zcode-task':{onDynamicTaskEvent:()=>events.event}}});
 const agent=service.channels['zcode-agent'],listener=agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));t.after(()=>{listener.dispose();service.dispose();events.dispose();});
 const {ack}=await agent.subscribeConversationV4(params);
 return{...f,index,service,agent,ack,calls,frames,setGate(value){gate=value;}};
}
test('indexed subscribe reads one sixty-row body window and row ranges fetch older bodies only on demand',async t=>{
 const f=await fixture(t),snapshot=f.frames[0].frame.payload.snapshot,expected=projectConversationRows({thread:fixtureThread,turns:f.turns});
 assert.equal(f.calls.length,1);assert.equal(snapshot.rows.totalCount,120);assert.deepEqual(snapshot.rows.window,expected.slice(-60));
 const before=f.calls.length,older=await f.agent.conversationRowsRangeV4({...params,beforeRowId:61,limit:60});assert.equal(f.calls.length,before+1);assert.deepEqual(older.rows,expected.slice(0,60));assert.equal(older.hasMore,false);assert.equal(older.atLogEpoch,snapshot.logEpoch);
});
test('loading older rows does not change revision validity and resync retains the whole loaded window',async t=>{
 const f=await fixture(t),initial=f.frames[0].frame.payload.snapshot;
 await f.agent.conversationRowsRangeV4({...params,beforeRowId:61,limit:60});
 assert.equal(await f.service.validateRevision({...params,baseRevision:initial.revision,baseLogEpoch:initial.logEpoch}),true);
 assert(f.calls.at(-1).path.includes('metadataOnly=1'));
 const appended=turnRecords(40);await f.append(appended.records.join(''));
 assert.equal(await f.service.validateRevision({...params,baseRevision:initial.revision,baseLogEpoch:initial.logEpoch}),false);
 await f.agent.resyncConversationV4({...params,subscriptionId:f.ack.subscriptionId});const snapshot=f.frames.at(-1).frame.payload.snapshot;
 assert.equal(snapshot.rows.totalCount,123);assert.equal(snapshot.rows.window.length,123);assert.equal(snapshot.rows.window[0].rowId,1);assert.equal(snapshot.rows.window.at(-1).rowId,123);assert.equal(snapshot.logEpoch,initial.logEpoch);
});
test('rewritten history rejects an old row range and publishes recovery with a new log epoch',async t=>{
 const f=await fixture(t),initial=f.frames[0].frame.payload.snapshot,info=await stat(f.file);await writeFile(f.file,f.content.replace('Answer 20','Change 20'));await utimes(f.file,info.atime,new Date(info.mtimeMs+2000));
 await assert.rejects(f.agent.conversationRowsRangeV4({...params,beforeRowId:61,limit:60}),{code:'HISTORY_WINDOW_CHANGED'});
 const latest=f.frames.at(-1);assert.equal(latest.deliveryKind,'recovery');assert.notEqual(latest.frame.payload.snapshot.logEpoch,initial.logEpoch);assert.equal(latest.frame.payload.snapshot.rows.window.length,60);
});
test('a row range whose old connection was disposed while reading cannot publish late rows',async t=>{
 const f=await fixture(t);let release;f.setGate(new Promise(r=>release=r));const pending=f.agent.conversationRowsRangeV4({...params,beforeRowId:61,limit:60});await new Promise(r=>setTimeout(r,10));f.service.dispose();release();await assert.rejects(pending,{code:'CODEX_CONNECTION_CLOSED'});
});
test('an explicitly unsupported window source preserves the old history projection as a compatibility fallback',async t=>{
 const f=await conversationFixture(t),calls=[],frames=[];
 const service=createConversationReadServices({indexedHistory:true,api:{get:async path=>{calls.push(path);if(path.startsWith('/api/history-window'))throw Object.assign(new Error('unsupported'),{statusCode:501,code:'HISTORY_WINDOW_UNSUPPORTED'});return{thread:fixtureThread,turns:f.turns,nextCursor:null};}},baseServices:{project:{readTree:async()=>({tasks:[{taskId:fixtureId,workspacePath:fixtureThread.cwd}]})},'zcode-task':{onDynamicTaskEvent:()=>()=>({dispose(){}})}}});t.after(()=>service.dispose());
 const agent=service.channels['zcode-agent'];agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));await agent.subscribeConversationV4(params);assert.equal(calls.length,2);assert.equal(frames[0].frame.payload.snapshot.rows.totalCount,120);
});
test('empty draft revision checks use metadata rather than reading historical bodies',async t=>{
 const calls=[],service=createConversationReadServices({indexedHistory:true,api:{get:async path=>{calls.push(path);return{thread:fixtureThread,turns:[],rows:{window:[],totalCount:0,firstRowId:null},sourceEpoch:'draft',revision:'empty'};}},baseServices:{project:{readTree:async()=>({tasks:[{taskId:fixtureId,workspacePath:fixtureThread.cwd}]})},'zcode-task':{onDynamicTaskEvent:()=>()=>({dispose(){}})}}});t.after(()=>service.dispose());
 assert.equal(await service.validateRevision({...params,baseRevision:0}),true);assert.equal(calls.length,1);assert(calls[0].startsWith('/api/history-window?'));assert(calls[0].includes('metadataOnly=1'));
});
