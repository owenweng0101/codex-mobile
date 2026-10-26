import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeArchive} from '../native-archive.mjs';
const id='01a16f92-238d-79d0-b5b2-9593d82e6497',other='01a16f92-238d-79d0-b5b2-9593d82e6498';
async function fixture(t,options={}) {
 const stateDir=await mkdtemp(join(tmpdir(),'codex-native-archive-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const state={archived:false,listArchived:false,mode:'default',activeTurn:null,sends:[]};
 const callbacks={stateDir,readThread:async threadId=>({id:threadId,path:state.archived?'/codex/archived_sessions/chat.jsonl':'/codex/sessions/chat.jsonl'}),isArchived:async()=>state.listArchived,desktop:{history:async threadId=>({thread:{id:threadId},activeTurn:state.activeTurn,settings:{mode:state.mode}}),send:async(threadId,params)=>{state.sends.push({threadId,params});if(options.send)return options.send(state);return{turn:{id:'archive-turn'},text:'归档成功'};}},initialWaitMs:40,pollMs:2,readTimeoutMs:20,settleMs:2};
 const archive=new NativeArchive(callbacks);return{archive,state,stateDir,callbacks};
}
test('selected idle chat sends one explicit self-archive instruction and succeeds only after saved path changes',async t=>{const f=await fixture(t,{send:state=>{state.archived=true;return{turn:{id:'archive-turn'}}}});const r=await f.archive.run({threadId:id,requestId:'archive-path'});assert.equal(r.status,'archived');assert.equal(f.state.sends.length,1);assert.equal(f.state.sends[0].threadId,id);const prompt=f.state.sends[0].params.input[0].text;assert.ok(prompt.includes(id));assert.ok(prompt.includes('不要操作其他聊天'));assert.equal(prompt.includes(other),false);assert.equal(f.archive.isPending(id),false)});
test('model wording is ignored and authoritative archived-list confirmation can finish later',async t=>{const f=await fixture(t);const r=await f.archive.run({threadId:id,requestId:'archive-words'});await f.archive.jobs.get('archive-words').startPromise;assert.equal(r.status,'pending');assert.equal(r.archived,false);assert.equal(f.archive.isPending(id),true);f.state.listArchived=true;assert.equal((await f.archive.status({threadId:id,requestId:'archive-words'})).status,'archived');assert.equal(f.state.sends.length,1)});
test('concurrent same request and different IDs for the same pending thread never send twice',async t=>{const f=await fixture(t);const results=await Promise.all([f.archive.run({threadId:id,requestId:'archive-double'}),f.archive.run({threadId:id,requestId:'archive-double'}),f.archive.run({threadId:id,requestId:'archive-alias'})]);await f.archive.jobs.get('archive-double').startPromise;assert.equal(f.state.sends.length,1);assert.ok(results.every(r=>r.status==='pending'));await assert.rejects(f.archive.run({threadId:other,requestId:'archive-double'}),/不一致/)});
test('unknown send result remains pending and repeated run/status only verify, including after restart',async t=>{const f=await fixture(t,{send:()=>{throw Object.assign(Error('lost receipt'),{outcomeUnknown:true})}});await f.archive.run({threadId:id,requestId:'archive-unknown'});await f.archive.jobs.get('archive-unknown').startPromise;const retry=await f.archive.run({threadId:id,requestId:'archive-unknown'});assert.equal(retry.status,'pending');assert.equal(retry.outcomeUnknown,true);const restarted=new NativeArchive(f.callbacks);await restarted.ready();assert.equal(restarted.isPending(id),true);await restarted.run({threadId:id,requestId:'archive-unknown'});await restarted.run({threadId:id,requestId:'archive-new-alias'});await restarted.status({threadId:id,requestId:'archive-unknown'});assert.equal(f.state.sends.length,1)});
test('busy and Plan chats are blocked without sending, while a new explicit request may run after state changes',async t=>{const f=await fixture(t);f.state.activeTurn='active';assert.equal((await f.archive.run({threadId:id,requestId:'archive-busy'})).reason,'busy');f.state.activeTurn=null;f.state.mode='plan';assert.equal((await f.archive.run({threadId:id,requestId:'archive-plan'})).reason,'plan-mode');assert.equal(f.state.sends.length,0);f.state.mode='default';await f.archive.run({threadId:id,requestId:'archive-new-command'});await f.archive.jobs.get('archive-new-command').startPromise;assert.equal(f.state.sends.length,1)});
test('terminal archived jobs do not mask a new user archive action after unarchive',async t=>{const f=await fixture(t);f.state.archived=true;assert.equal((await f.archive.run({threadId:id,requestId:'archive-existing'})).status,'archived');assert.equal(f.state.sends.length,0);f.state.archived=false;const r=await f.archive.run({threadId:id,requestId:'archive-after-undo'});await f.archive.jobs.get('archive-after-undo').startPromise;assert.equal(r.status,'pending');assert.equal(f.state.sends.length,1)});
test('cancel stops waiting without claiming the already-sent instruction was withdrawn',async t=>{const f=await fixture(t);await f.archive.run({threadId:id,requestId:'archive-cancel'});await f.archive.jobs.get('archive-cancel').startPromise;const cancelled=await f.archive.cancel({threadId:id,requestId:'archive-cancel'});assert.equal(cancelled.status,'pending');assert.ok(cancelled.message.includes('仍可能完成'));await f.archive.run({threadId:id,requestId:'archive-cancel'});assert.equal(f.state.sends.length,1);f.state.archived=true;assert.equal((await f.archive.status({threadId:id,requestId:'archive-cancel'})).status,'archived')});
test('persisted records contain only request state, not instructions, turns, tool arguments or history',async t=>{const f=await fixture(t);await f.archive.run({threadId:id,requestId:'archive-private'});await f.archive.jobs.get('archive-private').startPromise;const path=join(f.stateDir,'native-archive','requests.json'),raw=await readFile(path,'utf8');for(const text of ['set_thread_archived','不要修改文件','input','history','prompt','token'])assert.equal(raw.includes(text),false,text);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(join(f.stateDir,'native-archive'))).mode&0o777,0o700)});
test('unknown status after restart is read-only and validates the selected chat identity',async t=>{const f=await fixture(t);const r=await f.archive.status({threadId:id,requestId:'archive-not-recorded'});assert.equal(r.status,'pending');assert.equal(f.state.sends.length,0);f.state.archived=true;assert.equal((await f.archive.status({threadId:id,requestId:'archive-not-recorded'})).status,'archived');await assert.rejects(f.archive.run({threadId:id+'?other=1',requestId:'archive-invalid'}));assert.equal(f.state.sends.length,0)});


function completedState(requestId,{turnId='archive-turn',status='completed',runtime='idle'}={}) {
 return{id,threadRuntimeStatus:{type:runtime},turnHistory:{kind:'canonical',history:{islands:[{entries:[{key:'own',value:'own'}]}],entitiesByKey:{own:{turnId,status,params:{clientUserMessageId:'native-archive-'+requestId},items:[]}}}}};
}
test('completed own turn plus fresh idle owner and a later successful unarchived path read releases the chat',async t=>{
 const f=await fixture(t),req='archive-not-done';let fresh=0;f.callbacks.desktop.snapshot=async(threadId,options)=>{assert.equal(threadId,id);assert.equal(options.fresh,true);fresh++;return f.state.sends.length?completedState(req):{id,threadRuntimeStatus:{type:'idle'},turns:[]}};
 const r=await f.archive.run({threadId:id,requestId:req});await f.archive.jobs.get(req).startPromise;
 assert.equal(r.status,'notArchived');assert.equal(r.sent,true);assert.equal(r.pending,false);assert.equal(r.archived,false);assert.equal(f.archive.isPending(id),false);assert.ok(fresh>0);assert.equal(f.state.sends.length,1);
 const reopened=new NativeArchive(f.callbacks);await reopened.ready();const restored=await reopened.run({threadId:id,requestId:req});assert.equal(restored.status,'notArchived');assert.notEqual(restored.outcomeUnknown,true);assert.equal(f.state.sends.length,1);
 await reopened.run({threadId:id,requestId:'archive-another-action'});await reopened.jobs.get('archive-another-action').startPromise;assert.equal(f.state.sends.length,2);
});
test('unconfirmed ACK can correlate its own completed canonical turn by stable clientUserMessageId and persists only the turn ID',async t=>{
 const req='archive-lost-turn',f=await fixture(t,{send:()=>{throw Object.assign(Error('ACK lost'),{outcomeUnknown:true})}});
 f.callbacks.desktop.snapshot=async()=>f.state.sends.length?completedState(req,{turnId:'correlated-turn'}):null;
 const r=await f.archive.run({threadId:id,requestId:req});assert.equal(r.status,'notArchived');assert.equal(r.turnId,'correlated-turn');assert.equal(r.sent,true);assert.equal(r.pending,false);
 const saved=JSON.parse(await readFile(join(f.stateDir,'native-archive','requests.json'),'utf8'));assert.equal(saved.jobs[0].turnId,'correlated-turn');assert.ok(saved.jobs[0].notArchivedAt);assert.equal(saved.jobs[0].params,undefined);
});
test('another completed turn or non-idle owner is never proof the archive request finished',async t=>{
 const req='archive-still-busy',f=await fixture(t);f.callbacks.desktop.snapshot=async()=>completedState('some-other-request');
 assert.equal((await f.archive.run({threadId:id,requestId:req})).status,'pending');await f.archive.jobs.get(req).startPromise;
 f.callbacks.desktop.snapshot=async()=>completedState(req,{runtime:'active'});assert.equal((await f.archive.status({threadId:id,requestId:req})).status,'pending');
 f.callbacks.desktop.snapshot=async()=>completedState(req,{status:'inProgress'});assert.equal((await f.archive.status({threadId:id,requestId:req})).status,'pending');assert.equal(f.archive.isPending(id),true);
});
test('a failed or timed-out saved-state read after owner completion cannot become notArchived',async t=>{
 const req='archive-read-failed',f=await fixture(t);f.callbacks.desktop.snapshot=async()=>f.state.sends.length?completedState(req):null;
 f.archive.readThread=async()=>{throw Error('catalog unavailable')};assert.equal((await f.archive.run({threadId:id,requestId:req})).status,'pending');assert.equal(f.archive.isPending(id),true);
 f.archive.readThread=()=>new Promise(()=>{});assert.equal((await f.archive.status({threadId:id,requestId:req})).status,'pending');
});
test('actual archive confirmation after the fresh snapshot wins over negative earlier evidence',async t=>{
 const req='archive-positive-wins',f=await fixture(t);f.callbacks.desktop.snapshot=async()=>{if(!f.state.sends.length)return null;f.state.listArchived=true;return completedState(req)};
 const r=await f.archive.run({threadId:id,requestId:req});assert.equal(r.status,'archived');assert.equal(r.archived,true);assert.equal(r.pending,false);assert.equal(f.archive.isPending(id),false);
});


test('negative completion waits for a second fresh idle observation after the quiet window',async t=>{
 const req='archive-quiet-window',f=await fixture(t);f.archive.initialWaitMs=20;f.archive.settleMs=180;
 f.callbacks.desktop.snapshot=async()=>f.state.sends.length?completedState(req):null;
 const first=await f.archive.run({threadId:id,requestId:req});assert.equal(first.status,'pending');await f.archive.jobs.get(req).startPromise;
 assert.equal((await f.archive.status({threadId:id,requestId:req})).status,'pending');
 await new Promise(resolve=>setTimeout(resolve,200));assert.equal((await f.archive.status({threadId:id,requestId:req})).status,'notArchived');
});
