import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeRead} from '../backend/lib/native-read.mjs';
const cli='12345678-1234-4123-8123-123456789012',desktop='local_native-read-test',reply='reply-a';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'claude-native-read-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const state={unread:true,known:true,revision:'100',reply,desktop,opened:[]};
 const options={stateDir:dir,catalog:async()=>[{cliSessionId:cli,sessionId:state.desktop,lastAssistantUuid:state.reply}],unread:()=>({known:state.known,revision:state.revision,unreadIds:new Set(state.unread?[desktop]:[]),explicitUnreadIds:new Set()}),isRunning:async()=>true,timeoutMs:15,intervalMs:1,
 resume:async id=>{state.opened.push(id);state.unread=false;state.revision='101';}};
 const input={requestId:randomUUID(),sessionId:cli,desktopSessionId:desktop,unreadVersion:'reply-a:reply:100'};
 return {dir,state,options,input,service:new NativeRead(options)};
}
test('native mutation is confirmed by native unread read-back, and retries survive restart without another open',async t=>{
 const f=await fixture(t),r=await f.service.acknowledge(f.input);assert.equal(r.verified,true);assert.equal(r.unread,false);assert.deepEqual(f.state.opened,[cli]);
 assert.equal((await new NativeRead(f.options).acknowledge(f.input)).verified,true);assert.deepEqual(f.state.opened,[cli]);
 const path=join(f.dir,'native-read-commands',f.input.requestId+'.json');assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(JSON.parse(await readFile(path,'utf8')).state,'confirmed');
});
test('an already-read native session never opens or starts anything',async t=>{const f=await fixture(t);f.state.unread=false;assert.equal((await f.service.acknowledge(f.input)).verified,true);assert.deepEqual(f.state.opened,[]);});
test('successful URL dispatch alone is not a read receipt, and pending requests are never replayed',async t=>{
 const f=await fixture(t);f.options.resume=async id=>f.state.opened.push(id);f.service=new NativeRead(f.options);
 const first=await f.service.acknowledge(f.input);assert.equal(first.verified,false);assert.equal(first.pending,true);
 const next=await new NativeRead(f.options).acknowledge(f.input);assert.equal(next.verified,false);assert.deepEqual(f.state.opened,[cli]);
 f.state.unread=false;assert.equal((await new NativeRead(f.options).acknowledge(f.input)).verified,true);assert.deepEqual(f.state.opened,[cli]);
});
test('a lost native dispatch response still succeeds if native state confirms it, with no replay',async t=>{
 const f=await fixture(t);f.options.resume=async id=>{f.state.opened.push(id);f.state.unread=false;throw Error('reply lost');};
 assert.equal((await new NativeRead(f.options).acknowledge(f.input)).verified,true);assert.deepEqual(f.state.opened,[cli]);
});
test('simultaneous same-ID requests coalesce, conflicting scope cannot alter another session',async t=>{
 const f=await fixture(t);const [a,b]=await Promise.all([f.service.acknowledge(f.input),f.service.acknowledge(f.input)]);assert.deepEqual(a,b);assert.deepEqual(f.state.opened,[cli]);
 await assert.rejects(f.service.acknowledge({...f.input,desktopSessionId:'local_other'}),e=>e.code==='READ_ID_CONFLICT');assert.deepEqual(f.state.opened,[cli]);
});
for(const [name,mutate,code] of [
 ['unknown native state',f=>{f.state.known=false;},'NATIVE_READ_UNKNOWN'],
 ['different desktop target',f=>{f.state.desktop='local_other';},'READ_TARGET_CHANGED'],
 ['new reply',f=>{f.state.reply='reply-b';},'READ_REPLY_CHANGED'],
 ['new unread generation',f=>{f.state.revision='102';},'READ_STATE_CHANGED'],
 ['closed desktop',f=>{f.options.isRunning=async()=>false;f.service=new NativeRead(f.options);},'DESKTOP_NOT_RUNNING']
])test(name+' refuses before any native action',async t=>{const f=await fixture(t);mutate(f);await assert.rejects(f.service.acknowledge(f.input),e=>e.code===code);assert.deepEqual(f.state.opened,[]);});
test('a metadata race while waiting for the App is revalidated before dispatch',async t=>{
 const f=await fixture(t);f.options.isRunning=async()=>{f.state.reply='newer';return true;};
 await assert.rejects(new NativeRead(f.options).acknowledge(f.input),e=>e.code==='READ_REPLY_CHANGED');assert.deepEqual(f.state.opened,[]);
});
test('corrupt existing command record and invalid IDs fail without native dispatch',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.acknowledge({...f.input,requestId:'../../no'}),e=>e.statusCode===400);
 const first=await f.service.acknowledge(f.input);assert.equal(first.verified,true);
 await writeFile(join(f.dir,'native-read-commands',f.input.requestId+'.json'),'{invalid');f.state.unread=true;
 await assert.rejects(f.service.acknowledge(f.input),e=>e.code==='READ_RECORD_UNAVAILABLE');assert.deepEqual(f.state.opened,[cli]);
});
