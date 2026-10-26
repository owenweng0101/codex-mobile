import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopIntent,desktopThreadUrl,ensureDesktopOwner} from '../desktop-intent.mjs';
const id='01a16f77-6b33-7dc0-8ef6-d9f240976815';
async function fixture(t,{persist=true,owner=true,failName=false,failStage}={}) {
  const cwd=await mkdtemp(join(tmpdir(),'codex-desktop-intent-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const events=[],calls=[],starts=[],path=join(cwd,'empty.jsonl');let creators=0;
  const createCore=()=>{
    creators++;const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kill=signal=>{child.signalCode=signal;child.emit('exit',null,signal)};
    return {child,async start(options){starts.push(options);events.push('core-start');if(failStage==='initialize')throw Error('initialize timeout')},async call(method,params,timeout){calls.push({method,params,timeout});events.push(method);if(failStage===method)throw Error(method+' timeout');if(method==='thread/start'||method==='thread/fork')return{thread:{id,path,cwd,turns:[]},model:'m',reasoningEffort:'high',approvalPolicy:'untrusted'};if(method==='thread/name/set'){if(failName)throw Error('name failed');if(persist)await writeFile(path,JSON.stringify({type:'session_meta'})+'\n');}return{status:'unsubscribed'}},stop(){events.push('core-stop');queueMicrotask(()=>{child.exitCode=0;events.push('core-exit');child.emit('exit',0,null)})}};
  };
  const desktop={async owner(){events.push('owner');return owner?'native-owner':null}},openThread=async threadId=>{assert.equal(threadId,id);events.push('open-intent')};
  const intent=new DesktopIntent({desktop,createCore,openThread,attachTimeoutMs:15,probeTimeoutMs:5,pollMs:1,persistTimeoutMs:10,closeTimeoutMs:100});
  return{intent,cwd,events,calls,starts,creators:()=>creators};
}
test('thread URL accepts only an exact UUID with no injected intent fields',()=>{assert.equal(desktopThreadUrl(id),`codex://threads/${id}`);for(const value of ['x',`${id}?prompt=send`,`${id}/wake`,undefined])assert.throws(()=>desktopThreadUrl(value));});
test('empty draft is named and persisted, and private writer exits before product intent',async t=>{const f=await fixture(t);const r=await f.intent.create({cwd:f.cwd,name:' 正式新任务 ',model:'m',effort:'high',sandbox:'read-only',approvalPolicy:'untrusted'});assert.equal(r.thread.id,id);assert.equal(r.thread.name,'正式新任务');assert.equal(r.desktop.attached,true);assert.ok(f.events.indexOf('core-exit')<f.events.indexOf('open-intent'));assert.deepEqual(f.calls.map(x=>x.method),['thread/start','thread/name/set','thread/unsubscribe']);assert.equal(f.calls[0].params.config.model_reasoning_effort,'high');assert.equal(f.creators(),1);assert.equal(f.events.includes('turn/start'),false)});
test('missing rollout never opens Desktop or calls a model and releases creator',async t=>{const f=await fixture(t,{persist:false});await assert.rejects(f.intent.create({cwd:f.cwd}),e=>e.threadId===id&&!e.persisted&&e.writerReleased);assert.equal(f.events.includes('open-intent'),false);assert.equal(f.events.at(-1),'core-exit')});
test('attach timeout retains created thread identity for retry rather than creating another thread',async t=>{const f=await fixture(t,{owner:false});await assert.rejects(f.intent.create({cwd:f.cwd}),e=>e.code==='DESKTOP_ATTACH_TIMEOUT'&&e.threadId===id&&e.persisted&&e.writerReleased);assert.equal(f.creators(),1);assert.equal(f.calls.filter(x=>x.method==='thread/start').length,1)});
test('name failure closes only its creator and reports recoverable created identity',async t=>{const f=await fixture(t,{failName:true});await assert.rejects(f.intent.create({cwd:f.cwd}),e=>e.message==='name failed'&&e.threadId===id&&e.writerReleased);assert.equal(f.events.includes('open-intent'),false);assert.equal(f.events.at(-1),'core-exit')});
test('recovering an existing draft only dispatches product intent and ownership discovery',async t=>{const f=await fixture(t);assert.deepEqual(await f.intent.attach(id),{threadId:id,desktop:{attached:true,persisted:true,writerReleased:true}});assert.equal(f.creators(),0);assert.deepEqual(f.events,['open-intent','owner'])});


test('fork uses a dedicated creator, exact mutually exclusive boundary and releases it before attach',async t=>{
  const f=await fixture(t);const result=await f.intent.fork(id,{cwd:f.cwd,lastTurnId:'first-turn',name:'指定位置副本'});
  assert.equal(result.desktop.attached,true);const request=f.calls.find(c=>c.method==='thread/fork');assert.equal(request.params.lastTurnId,'first-turn');assert.equal('beforeTurnId' in request.params,false);assert.equal(request.params.excludeTurns,false);assert.equal(request.params.deferGoalContinuation,true);assert.ok(f.events.indexOf('core-exit')<f.events.indexOf('open-intent'));assert.equal(f.calls.some(c=>c.method==='thread/start'),false);
});
test('fork refuses empty and conflicting boundaries and requires explicit whole-thread semantics',async t=>{
  const f=await fixture(t);for(const options of [{},{lastTurnId:''},{beforeTurnId:null},{lastTurnId:'a',beforeTurnId:'b'},{lastTurnId:'a',wholeThread:true}])await assert.rejects(f.intent.fork(id,{cwd:f.cwd,...options}));assert.equal(f.creators(),0);
  await f.intent.fork(id,{cwd:f.cwd,wholeThread:true});const request=f.calls.find(c=>c.method==='thread/fork');assert.equal('lastTurnId' in request.params,false);assert.equal('beforeTurnId' in request.params,false);
});
test('fork before a selected turn uses the exclusive field without changing source ownership',async t=>{
  const f=await fixture(t);await f.intent.fork(id,{cwd:f.cwd,beforeTurnId:'target'});const request=f.calls.find(c=>c.method==='thread/fork');assert.equal(request.params.threadId,id);assert.equal(request.params.beforeTurnId,'target');assert.equal('lastTurnId' in request.params,false);assert.equal(f.calls.some(c=>c.method==='thread/rollback'||c.method==='thread/revert'),false);
});

test('creation allocation and persistence hooks are awaited before releasing creator or opening Desktop',async t=>{
  const f=await fixture(t),hooks=[];
  await f.intent.create({cwd:f.cwd,onCreated:async info=>{assert.equal(f.events.includes('thread/name/set'),false);assert.deepEqual(info,{threadId:id,persisted:false,writerReleased:false});hooks.push('created');await new Promise(r=>setTimeout(r,2))},onPersisted:async info=>{assert.equal(f.events.includes('thread/name/set'),true);assert.equal(f.events.includes('core-stop'),false);assert.deepEqual(info,{threadId:id,persisted:true,writerReleased:false});hooks.push('persisted')}});
  assert.deepEqual(hooks,['created','persisted']);assert.ok(f.events.indexOf('core-exit')<f.events.indexOf('open-intent'));
});

test('private creator initialization and mutation RPCs use bounded timeouts',async t=>{
  const f=await fixture(t);await f.intent.create({cwd:f.cwd});
  assert.deepEqual(f.starts,[{timeoutMs:10000}]);assert.deepEqual(f.calls.map(c=>[c.method,c.timeout]),[['thread/start',15000],['thread/name/set',5000],['thread/unsubscribe',5000]]);
  const fork=await fixture(t);await fork.intent.fork(id,{cwd:fork.cwd,lastTurnId:'first'});
  assert.deepEqual(fork.starts,[{timeoutMs:10000}]);assert.equal(fork.calls.find(c=>c.method==='thread/fork').timeout,15000);
});
test('private creator failures close the child and retain the actual failed stage and allocated identity',async t=>{
  for(const stage of ['initialize','thread/start','thread/name/set']){
    const f=await fixture(t,{failStage:stage});
    await assert.rejects(f.intent.create({cwd:f.cwd}),e=>e.stage===stage&&(stage==='thread/name/set'?e.threadId===id&&e.writerReleased:!e.threadId));
    assert.equal(f.events.at(-1),'core-exit');assert.equal(f.events.includes('open-intent'),false);assert.equal(f.creators(),1);
  }
});

test('a cold operation attaches the original thread before sending, while warm owners do not reopen it',async()=>{
  const calls=[];let attached=false;
  const dependencies={isOwned:()=>false,isStale:()=>false,owner:async()=>{calls.push('owner');return attached?'desktop-owner':null},attach:async()=>{calls.push('attach:'+id);attached=true}};
  const send=async()=>{const owner=await ensureDesktopOwner(id,dependencies);assert.equal(owner,'desktop-owner');calls.push('send:'+id)};
  await send();assert.deepEqual(calls,['owner','attach:'+id,'owner','send:'+id]);calls.length=0;await send();assert.deepEqual(calls,['owner','send:'+id]);
});
test('failed cold attachment preserves recovery identity and never reaches a send or independent engine',async()=>{
  const calls=[];const operation=async()=>{await ensureDesktopOwner(id,{isOwned:()=>false,isStale:()=>false,owner:async()=>null,attach:async()=>{calls.push('attach');throw Error('not ready')}});calls.push('send')};
  await assert.rejects(operation(),{threadId:id,needsAttach:true,persisted:true,writerReleased:true});assert.deepEqual(calls,['attach']);
});
test('known stale or failed known-owner discovery never opens a fallback writer or sends',async()=>{
  for(const stale of [true,false]){
    const calls=[];const operation=async()=>{await ensureDesktopOwner(id,{isOwned:()=>false,isStale:()=>stale,owner:async()=>{calls.push('owner');throw Error('known owner offline')},attach:async()=>calls.push('attach')});calls.push('send')};
    await assert.rejects(operation(),{statusCode:503});assert.deepEqual(calls,stale?[]:['owner']);
  }
});
test('legacy independent writer requires explicit recovery without disrupting any shared process',async()=>{
  const calls=[];await assert.rejects(ensureDesktopOwner(id,{isOwned:()=>true,isStale:()=>false,owner:async()=>calls.push('owner'),attach:async()=>calls.push('attach')}),{threadId:id,writerReleased:false,needsAttach:true});assert.deepEqual(calls,[]);
});
