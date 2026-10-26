import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchivedThreads,ensureThreadUnarchived} from '../archived.mjs';
const id='01a16fbe-cb37-7600-b52b-dd2d231dbbb2';
const archived=()=>({id,name:'归档任务',preview:'<environment_context>secret context</environment_context>\n\n真实用户请求',path:'/fake/.codex/archived_sessions/2026/session.jsonl',cwd:'/fake/work',turns:[{internal:'hidden'}],extra:{secret:'hidden'},status:{type:'notLoaded'}});
test('archived execution is refused until an explicit verified restore changes its saved state',()=>{
  assert.throws(()=>ensureThreadUnarchived(archived()),{code:'THREAD_ARCHIVED',statusCode:409});const restored={...archived(),path:'/fake/.codex/sessions/session.jsonl'};assert.equal(ensureThreadUnarchived(restored),restored);assert.equal(ensureThreadUnarchived({id}).id,id);
});
test('archived list uses official title search and binds pagination to the same query',async()=>{
  const calls=[],manager=new ArchivedThreads({call:async(method,params)=>{calls.push({method,params});return{data:[archived()],nextCursor:calls.length===1?'native-next':null}}});
  const first=await manager.list(new URLSearchParams({q:'归档',limit:'2'}));assert.equal(calls[0].method,'thread/list');assert.equal(calls[0].params.archived,true);assert.equal(calls[0].params.searchTerm,'归档');assert.equal(calls[0].params.useStateDbOnly,true);assert.equal(first.data[0].archived,true);assert.equal(first.data[0].preview,'真实用户请求');assert.equal(JSON.stringify(first).includes('secret'),false);assert.equal('path' in first.data[0],false);assert.equal('turns' in first.data[0],false);
  await manager.list(new URLSearchParams({q:'归档',cursor:first.nextCursor}));assert.equal(calls[1].params.cursor,'native-next');
  await assert.rejects(manager.list(new URLSearchParams({q:'其他',cursor:first.nextCursor})),{statusCode:400});assert.equal(calls.length,2);
});
test('invalid restore and list inputs never reach an RPC',async()=>{
  const manager=new ArchivedThreads({call:async()=>{throw Error('unexpected RPC')}});
  for(const input of [{threadId:'bad',requestId:'request-123'},{threadId:id},{threadId:id,requestId:'bad id'}])await assert.rejects(manager.unarchive(input),{statusCode:400});
  for(const query of [{limit:'0'},{limit:'101'},{limit:'1.5'},{cursor:'bad'},{q:'a'.repeat(201)}])await assert.rejects(manager.list(new URLSearchParams(query)),{statusCode:400});
});
test('concurrent restore intents issue one mutation and return only officially verified metadata',async()=>{
  let restored=false,mutations=0;const methods=[],manager=new ArchivedThreads({call:async(method)=>{methods.push(method);if(method==='thread/goal/get')return{goal:null};if(method==='thread/unarchive'){mutations++;await new Promise(resolve=>setImmediate(resolve));restored=true;return{thread:archived()};}return{thread:{...archived(),path:restored?'/fake/.codex/sessions/session.jsonl':archived().path}}}});
  const results=await Promise.all([manager.unarchive({threadId:id,requestId:'request-123'}),manager.unarchive({threadId:id,requestId:'request-123'}),manager.unarchive({threadId:id,requestId:'request-456'})]);
  assert.equal(mutations,1);for(const result of results){assert.equal(result.verified,true);assert.equal(result.unarchived,true);assert.equal(result.threadId,id);assert.equal(result.thread.archived,false);assert.equal('path' in result.thread,false);}
  assert.deepEqual(methods,['thread/read','thread/goal/get','thread/unarchive','thread/read']);await manager.unarchive({threadId:id,requestId:'request-123'});assert.equal(methods.length,5);assert.equal(methods.at(-1),'thread/read');assert.equal(mutations,1);
  restored=false;await assert.rejects(manager.unarchive({threadId:id,requestId:'request-123'}),{outcomeUnknown:true});assert.equal(mutations,1);
});
test('lost restore acknowledgement remains uncertain until readonly recheck succeeds, without replay',async()=>{
  let restored=false,mutations=0;const manager=new ArchivedThreads({call:async(method)=>{if(method==='thread/goal/get')return{goal:null};if(method==='thread/unarchive'){mutations++;throw Error('lost acknowledgement');}return{thread:{...archived(),path:restored?'/fake/.codex/sessions/session.jsonl':archived().path}}}});
  const input={threadId:id,requestId:'request-123'};await assert.rejects(manager.unarchive(input),{outcomeUnknown:true,statusCode:409});await assert.rejects(manager.unarchive(input),{outcomeUnknown:true});assert.equal(mutations,1);
  restored=true;const result=await manager.unarchive(input);assert.equal(result.verified,true);assert.equal(mutations,1);
});
test('a restarted manager verifies an already restored thread without mutating or running it',async()=>{
  const methods=[],manager=new ArchivedThreads({call:async(method)=>{methods.push(method);return{thread:{...archived(),path:'/fake/.codex/sessions/session.jsonl'}}}});
  const result=await manager.unarchive({threadId:id,requestId:'request-123'});assert.equal(result.verified,true);assert.deepEqual(methods,['thread/read']);
});
test('unarchive ACK alone, unknown saved paths, or wrong identities cannot produce success',async()=>{
  for(const saved of [archived(),{...archived(),path:'/elsewhere/session.jsonl'},{...archived(),id:'another-id',path:'/fake/.codex/sessions/session.jsonl'}]){
    let calls=0;const manager=new ArchivedThreads({call:async(method)=>{if(method==='thread/goal/get')return{goal:null};if(method==='thread/unarchive')return{thread:{...archived(),path:'/fake/.codex/sessions/session.jsonl'}};return{thread:++calls===1?archived():saved}}});
    await assert.rejects(manager.unarchive({threadId:id,requestId:'request-123'}),{outcomeUnknown:true});
  }
});

test('active and limited goals retain their original state while native restoration submits no goal or turn mutation',async()=>{
  for(const status of ['active','blocked','usageLimited','budgetLimited']){
    const methods=[],goal={threadId:id,status};let restored=false;const manager=new ArchivedThreads({call:async method=>{methods.push(method);if(method==='thread/read')return{thread:{...archived(),path:restored?'/fake/.codex/sessions/session.jsonl':archived().path}};if(method==='thread/goal/get')return{goal};if(method==='thread/unarchive'){restored=true;return{};}throw Error('unexpected mutation')}});
    const result=await manager.unarchive({threadId:id,requestId:'request-123'});assert.equal(result.verified,true);assert.equal(result.goalKnown,true);assert.equal(result.goalStatus,status);assert.equal(result.mayContinueGoal,true);assert.equal(goal.status,status);assert.deepEqual(methods,['thread/read','thread/goal/get','thread/unarchive','thread/read']);
  }
});
test('a failed or unverifiable goal read remains unknown and does not block the authorized native restoration',async()=>{
  for(const response of [undefined,{}, {goal:{threadId:'another-thread',status:'paused'}}, {goal:{threadId:id}}]){
    const methods=[];let restored=false;const manager=new ArchivedThreads({call:async method=>{methods.push(method);if(method==='thread/read')return{thread:{...archived(),path:restored?'/fake/.codex/sessions/session.jsonl':archived().path}};if(method==='thread/goal/get'){if(response===undefined)throw Error('offline');return response;}if(method==='thread/unarchive'){restored=true;return{};}throw Error('unexpected mutation')}});
    const result=await manager.unarchive({threadId:id,requestId:'request-123'});assert.equal(result.verified,true);assert.equal(result.goalKnown,false);assert.equal(Object.hasOwn(result,'goalStatus'),false);assert.equal(result.mayContinueGoal,true);assert.deepEqual(methods,['thread/read','thread/goal/get','thread/unarchive','thread/read']);
  }
});
test('null, paused and complete goals are reported without adding resume or turn operations',async()=>{
  for(const status of [null,'paused','complete']){
    const methods=[];let restored=false;const manager=new ArchivedThreads({call:async method=>{methods.push(method);if(method==='thread/read')return{thread:{...archived(),path:restored?'/fake/.codex/sessions/session.jsonl':archived().path}};if(method==='thread/goal/get')return{goal:status===null?null:{threadId:id,status}};if(method==='thread/unarchive'){restored=true;return{};}throw Error('unexpected mutation')}});
    const result=await manager.unarchive({threadId:id,requestId:'request-123'});assert.equal(result.verified,true);assert.equal(result.goalKnown,true);assert.equal(result.goalStatus,status);assert.equal(result.mayContinueGoal,false);assert.deepEqual(methods,['thread/read','thread/goal/get','thread/unarchive','thread/read']);
  }
});

test('desktop refresh rechecks official saved state before notifying and does not claim attachment',async()=>{
  const calls=[],desktop={notifyUnarchived:async threadId=>{calls.push('notify:'+threadId);return{notified:true}},unfollow:threadId=>calls.push('unfollow:'+threadId)};
  for(const thread of [archived(),{...archived(),id:'another',path:'/fake/.codex/sessions/s.jsonl'}]){
    const manager=new ArchivedThreads({call:async method=>{calls.push(method);return{thread}}});
    await assert.rejects(manager.refreshDesktop(id,desktop),{code:'THREAD_ARCHIVED'});assert.deepEqual(calls,['thread/read']);calls.length=0;
  }
  const manager=new ArchivedThreads({call:async method=>{calls.push(method);return{thread:{...archived(),path:'/fake/.codex/sessions/s.jsonl'}}}});
  assert.deepEqual(await manager.refreshDesktop(id,desktop),{notified:true});assert.deepEqual(calls,['thread/read','notify:'+id,'unfollow:'+id]);
});
