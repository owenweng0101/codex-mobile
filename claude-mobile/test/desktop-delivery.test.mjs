import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {CommandLedger} from '../backend/lib/command-ledger.mjs';
import {DesktopDelivery} from '../backend/lib/desktop-delivery.mjs';

const input=(extra={})=>({requestId:randomUUID(),cwd:'/fake/project',text:'private message sentinel',model:'fake-model',permissionMode:'acceptEdits',attachments:[],priority:'now',...extra});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const ack=(id)=>({id,role:'user',text:'native user record'});

async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'claude-desktop-delivery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ledger=new CommandLedger({dir});
  const ctx={creates:[],attaches:[],sent:[],reads:[],lives:[],files:[],stats:[],checkpoints:[],messages:new Map(),sleeps:[],clock:1000,cursor:42};
  const deps={
    ledger,
    intent:{
      async create(args){ctx.creates.push(args);return ctx.createHook?ctx.createHook(args):{sessionId:args.sessionId,desktopSessionId:'desktop-'+args.sessionId};},
      async attach(id){ctx.attaches.push(id);return ctx.attachHook?ctx.attachHook(id):{sessionId:id,desktopSessionId:'desktop-'+id};},
    },
    async sendPeerMessage(frame){
      ctx.sent.push(frame);
      ctx.checkpoints.push(await ledger.get(frame.msgId));
      return ctx.sendHook?ctx.sendHook(frame):{accepted:true,msgId:frame.msgId};
    },
    async liveSession(id){ctx.lives.push(id);return ctx.liveHook?ctx.liveHook(id):{socketPath:'/fake/socket',token:'SECRET_NATIVE_TOKEN',status:'busy',entrypoint:'claude-desktop-3p',hostSessionId:'desktop-'+id};},
    async readTranscript(id){ctx.reads.push(id);return ctx.readHook?ctx.readHook(id):{messages:ctx.messages.get(id)||[],cursor:ctx.cursor};},
    async sessionFile(id){ctx.files.push(id);return ctx.fileHook?ctx.fileHook(id):{path:'/fake/transcript.jsonl'};},
    async statFile(path){ctx.stats.push(path);return ctx.statHook?ctx.statHook(path):{size:128};},
    now:()=>ctx.clock,
    async sleep(ms){ctx.sleeps.push(ms);ctx.clock+=ms;await ctx.sleepHook?.(ms);},
    ...options,
  };
  const delivery=new DesktopDelivery(deps);
  const addAck=(sessionId,id)=>ctx.messages.set(sessionId,[...(ctx.messages.get(sessionId)||[]),ack(id)]);
  return {dir,ledger,ctx,deps,delivery,addAck};
}

test('peer sender class matches the target desktop owner so a bypass session does not hold the phone message',async t=>{
  const f=await fixture(t),target=randomUUID(),body=input({sessionId:target});
  f.ctx.attachHook=async id=>({sessionId:id,desktopSessionId:'desktop-'+id,permissionMode:'bypassPermissions'});
  f.ctx.sendHook=frame=>{f.addAck(target,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  assert.equal((await f.delivery.submit(body)).state,'accepted');
  assert.equal(f.ctx.sent[0].fromMode,'bypass');

  const g=await fixture(t),plain=input({sessionId:randomUUID()});
  g.ctx.sendHook=frame=>{g.addAck(plain.sessionId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  assert.equal((await g.delivery.submit(plain)).state,'accepted');
  assert.equal(g.ctx.sent[0].fromMode,'prompting');
});

test('new session intent and dispatch follow durable checkpoints; only user UUID ACK accepts',async t=>{
  const f=await fixture(t),body=input();
  let prepared;
  f.ctx.createHook=async args=>{
    prepared=await f.ledger.get(body.requestId);
    assert.equal(prepared.state,'prepared');
    assert.equal(prepared.sessionId,body.requestId,'target saved before create');
    return {sessionId:args.sessionId,desktopSessionId:'desktop-native-id'};
  };
  f.ctx.liveHook=()=>({socketPath:'/fake/socket',token:'SECRET_NATIVE_TOKEN',entrypoint:'claude-desktop',hostSessionId:'desktop-native-id'});
  f.ctx.sendHook=frame=>{f.addAck(body.requestId,frame.msgId);return 'http-write-finished';};
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'accepted');assert.equal(result.delivery,'accepted');
  assert.equal(result.uncertain,false);assert.equal(result.error,null);
  assert.equal(result.sessionId,body.requestId);assert.equal(result.desktopSessionId,'desktop-native-id');
  assert.deepEqual(f.ctx.creates,[{sessionId:body.requestId,cwd:body.cwd,title:body.text,model:body.model,permissionMode:body.permissionMode}]);
  assert.equal(f.ctx.attaches.length,0);
  assert.equal(f.ctx.sent.length,1);
  assert.equal(f.ctx.sent[0].msgId,body.requestId);assert.equal(f.ctx.sent[0].text,body.text);
  assert.equal(f.ctx.checkpoints[0].state,'dispatched');
  assert.deepEqual(f.ctx.checkpoints[0].baseline,{cursor:42,startSize:128});
  assert.equal(result.cursor,42);
  const saved=await f.ledger.get(body.requestId);
  assert.equal(saved.fingerprint,prepared.fingerprint);
  for(const serialized of [JSON.stringify(result),await readFile(join(f.dir,body.requestId+'.json'),'utf8')]){
    for(const secret of [body.text,'SECRET_NATIVE_TOKEN','/fake/socket','/fake/transcript.jsonl'])assert.equal(serialized.includes(secret),false);
  }
  assert.equal(result.fingerprint,undefined,'public response exposes only delivery fields');
});

test('socket completion, assistant IDs, uuid aliases and matching text do not constitute ACK',async t=>{
  const f=await fixture(t,{ackTimeoutMs:5000}),body=input({sessionId:randomUUID()});
  f.ctx.messages.set(body.sessionId,[{id:body.requestId,role:'assistant'},{uuid:body.requestId,role:'user'},{id:randomUUID(),role:'user',text:body.text}]);
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'dispatched');assert.equal(result.delivery,'waiting');
  assert.equal(result.uncertain,false);assert.equal(result.error,null);
  assert.equal(f.ctx.sleeps.length,15);
  assert.ok(f.ctx.sleeps.every(ms=>ms===100));
  assert.equal(f.ctx.sleeps.reduce((a,b)=>a+b,0),1500,'wait capped even when configured higher');
  f.addAck(body.sessionId,body.requestId);
  assert.equal((await f.delivery.status(body.requestId)).state,'accepted');
  assert.equal(f.ctx.sent.length,1);
});

test('disconnect returns unknown; retry cannot resend and a later real ACK corrects status',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.sendHook=()=>{throw new Error('SECRET_NATIVE_TOKEN: socket wrote then disconnected');};
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'unknown');assert.equal(result.delivery,'unknown');assert.equal(result.uncertain,true);
  assert.equal(result.error.includes('SECRET_NATIVE_TOKEN'),false);
  const fingerprint=(await f.ledger.get(body.requestId)).fingerprint;
  assert.equal((await f.delivery.submit(body)).state,'unknown');
  assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.attaches.length,1);
  f.addAck(body.sessionId,body.requestId);
  const accepted=await f.delivery.get(body.requestId);
  assert.equal(accepted.state,'accepted');assert.equal(accepted.error,null);assert.equal(accepted.uncertain,false);
  const saved=await f.ledger.get(body.requestId);
  assert.equal(saved.fingerprint,fingerprint);assert.equal(saved.errorCode,null);
});

test('restart unknown recovery can only be resolved by transcript, never replay',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  assert.equal((await f.delivery.submit(body)).state,'dispatched');
  const fingerprint=(await f.ledger.get(body.requestId)).fingerprint;
  const ledger=new CommandLedger({dir:f.dir});
  await ledger.recover();
  const restarted=new DesktopDelivery({...f.deps,ledger});
  const waiting=await restarted.status(body.requestId);
  assert.equal(waiting.state,'unknown');assert.equal(waiting.delivery,'unknown');assert.equal(waiting.uncertain,true);
  assert.equal((await restarted.submit(body)).state,'unknown');
  assert.equal(f.ctx.sent.length,1);
  f.addAck(body.sessionId,body.requestId);
  assert.equal((await restarted.reconcile(body.requestId)).state,'accepted');
  assert.equal((await ledger.get(body.requestId)).fingerprint,fingerprint);
});

test('same request ID across delivery instances is serialized and dispatched exactly once',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  const other=new DesktopDelivery({...f.deps,ledger:new CommandLedger({dir:f.dir})});
  const results=await Promise.all(Array.from({length:30},(_,i)=>(i%2?other:f.delivery).submit(body)));
  assert.ok(results.every(record=>record.requestId===body.requestId&&record.state==='dispatched'));
  assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.attaches.length,1);assert.equal(f.ctx.creates.length,0);
});

test('two request IDs in the same busy session can dispatch independently with now/next priorities',{timeout:2000},async t=>{
  const f=await fixture(t),sessionId=randomUUID(),bothEntered=deferred();
  const first=input({sessionId,priority:'now'}),second=input({sessionId,priority:'next'});
  f.ctx.sendHook=async frame=>{
    if(f.ctx.sent.length===2)bothEntered.resolve();
    await bothEntered.promise;
    f.addAck(sessionId,frame.msgId);
  };
  const results=await Promise.all([f.delivery.submit(first),f.delivery.submit(second)]);
  assert.ok(results.every(record=>record.state==='accepted'));
  assert.deepEqual(f.ctx.sent.map(frame=>frame.priority).sort(),['next','now']);
  assert.ok(f.ctx.sent.every(frame=>frame.status==='busy'));
  assert.equal(f.ctx.attaches.length,2);
});

test('all delivery payload changes conflict under the same ID without another write',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID(),attachments:['attachment-one'],prompt:'expanded attachment prompt'});
  f.ctx.sendHook=frame=>f.addAck(body.sessionId,frame.msgId);
  await f.delivery.submit(body);
  const changes={sessionId:randomUUID(),cwd:'/other',text:'changed',model:'other',permissionMode:'bypassPermissions',attachments:['attachment-two'],priority:'next',prompt:'different expanded prompt'};
  for(const [key,value] of Object.entries(changes))await assert.rejects(f.delivery.submit({...body,[key]:value}),error=>error.code==='COMMAND_ID_COLLISION'&&error.status===409);
  assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.attaches.length,1);
});

test('attach failure is rejected, keeps the session ID and does not access a writer',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=()=>{throw Object.assign(new Error('SECRET_NATIVE_TOKEN'),{sessionId:body.sessionId});};
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.delivery,'rejected');assert.equal(result.uncertain,false);
  assert.equal(result.sessionId,body.sessionId);assert.ok(result.error);
  assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.lives.length,0);
  assert.equal((await f.ledger.get(body.requestId)).error,result.error);
  assert.equal((await f.delivery.submit(body)).state,'rejected');assert.equal(f.ctx.attaches.length,1);
});

test('create already-created failure retains deterministic target and never submits text',async t=>{
  const f=await fixture(t),body=input();
  f.ctx.createHook=()=>{throw Object.assign(new Error('already created'),{code:'SESSION_ALREADY_EXISTS',sessionId:body.requestId});};
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.sessionId,body.requestId);
  assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.creates.length,1);
  assert.equal((await f.ledger.get(body.requestId)).sessionId,body.requestId);
});

test('attachments use the same peer writer and server-expanded prompt, with no secondary writer',async t=>{
  let alternateWrites=0;
  const f=await fixture(t,{startTurn:()=>alternateWrites++,attachmentWriter:()=>alternateWrites++});
  const body=input({sessionId:randomUUID(),attachments:['image-id','file-id'],prompt:'private expanded prompt containing image and file references',priority:'next'});
  f.ctx.sendHook=frame=>f.addAck(body.sessionId,frame.msgId);
  assert.equal((await f.delivery.submit(body)).state,'accepted');
  assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.sent[0].text,body.prompt);assert.equal(f.ctx.sent[0].priority,'next');
  assert.equal(alternateWrites,0);
  const disk=await readFile(join(f.dir,body.requestId+'.json'),'utf8');
  for(const secret of [body.text,body.prompt])assert.equal(disk.includes(secret),false);
  assert.deepEqual(JSON.parse(disk).attachmentIds,body.attachments); // IDs restore uploaded previews; bytes/text remain private.
});

test('prepared duplicates never create, attach or send, even after a metadata write failure',async t=>{
  const f=await fixture(t),body=input();
  const mark=f.ledger.mark.bind(f.ledger);
  f.ledger.mark=async()=>{throw new Error('simulated metadata persistence failure');};
  await assert.rejects(f.delivery.submit(body),/metadata persistence failure/);
  assert.equal((await f.ledger.get(body.requestId)).state,'prepared');
  f.ledger.mark=mark;
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'prepared');assert.equal(result.delivery,'waiting');
  assert.equal(f.ctx.creates.length,0);assert.equal(f.ctx.sent.length,0);
});

test('failed prepare or dispatched checkpoint cannot reach native I/O',async t=>{
  const f=await fixture(t),first=input();
  const save=f.ledger._save.bind(f.ledger);
  f.ledger._save=async()=>{throw new Error('simulated disk full');};
  await assert.rejects(f.delivery.submit(first),/disk full/);
  assert.equal(f.ctx.creates.length,0);assert.equal(f.ctx.sent.length,0);
  f.ledger._save=save;
  const second=input({sessionId:randomUUID()}),mark=f.ledger.mark.bind(f.ledger);
  f.ledger.mark=async(id,patch)=>{if(patch.state==='dispatched')throw new Error('checkpoint failed');return mark(id,patch);};
  await assert.rejects(f.delivery.submit(second),/checkpoint failed/);
  assert.equal(f.ctx.sent.length,0);assert.equal((await f.ledger.get(second.requestId)).state,'prepared');
  f.ledger.mark=mark;
  assert.equal((await f.delivery.submit(second)).state,'prepared');
  assert.equal(f.ctx.attaches.length,1);assert.equal(f.ctx.sent.length,0);
});

test('native channel and baseline exceptions reject before I/O without any dispatched or unknown checkpoint',async t=>{
  for(const hook of ['liveHook','readHook','fileHook','statHook']){
    const f=await fixture(t),body=input({sessionId:randomUUID()});
    const mark=f.ledger.mark.bind(f.ledger),states=[];
    f.ledger.mark=async(id,patch)=>{states.push(patch.state);return mark(id,patch);};
    f.ctx[hook]=()=>{throw new Error('SECRET_NATIVE_TOKEN');};
    const result=await f.delivery.submit(body);
    assert.equal(result.state,'rejected',hook);assert.equal(result.uncertain,false);
    assert.equal(result.delivery,'rejected');
    assert.equal(result.errorCode,hook==='liveHook'?'DESKTOP_CHANNEL_UNAVAILABLE':'DESKTOP_BASELINE_UNAVAILABLE');
    assert.equal(result.sessionId,body.sessionId);
    assert.equal(result.desktopSessionId,'desktop-'+body.sessionId);
    assert.equal(f.ctx.sent.length,0);
    assert.equal(states.includes('dispatched'),false);assert.equal(states.includes('unknown'),false);
    assert.equal(JSON.stringify(result).includes('SECRET_NATIVE_TOKEN'),false);
    assert.equal((await f.delivery.submit(body)).state,'rejected');
    assert.equal(f.ctx.attaches.length,1);
    assert.equal(f.ctx.sent.length,0);
    assert.equal((await f.ledger.get(body.requestId)).dispatchedAt,undefined);
  }
});

test('missing or malformed native channel and baseline data are definitely not delivered',async t=>{
  for(const [hook,value] of [
    ['liveHook',null],['liveHook',{}],['readHook',null],['readHook',{messages:[],cursor:NaN}],
    ['fileHook',null],['fileHook',{}],['statHook',{size:-1}],['statHook',{size:1.5}],
  ]){
    const f=await fixture(t),body=input({sessionId:randomUUID()});
    f.ctx[hook]=()=>value;
    const result=await f.delivery.submit(body);
    assert.equal(result.state,'rejected');assert.equal(result.delivery,'rejected');assert.equal(result.uncertain,false);
    assert.equal(f.ctx.sent.length,0);
    const saved=await f.ledger.get(body.requestId);
    assert.equal(saved.state,'rejected');assert.equal(saved.baseline,undefined);assert.equal(saved.dispatchedAt,undefined);
    const before=saved.fingerprint;
    assert.equal((await f.delivery.status(body.requestId)).state,'rejected');
    assert.equal((await f.ledger.get(body.requestId)).fingerprint,before);
  }
});

test('foreign writer replacing an attached native owner is rejected before transcript or socket I/O',async t=>{
  for(const owner of [
    {entrypoint:'cli'},
    {entrypoint:undefined},
    {hostSessionId:'different-desktop-session'},
    {hostSessionId:undefined},
  ]){
    const f=await fixture(t),body=input({sessionId:randomUUID()});
    f.ctx.liveHook=()=>({socketPath:'/fake/replaced-socket',token:'SECRET_NATIVE_TOKEN',entrypoint:'claude-desktop-3p',hostSessionId:'desktop-'+body.sessionId,...owner});
    const result=await f.delivery.submit(body);
    assert.equal(result.state,'rejected');assert.equal(result.errorCode,'DESKTOP_FOREIGN_WRITER');
    assert.equal(result.uncertain,false);assert.equal(result.sessionId,body.sessionId);
    assert.equal(result.desktopSessionId,'desktop-'+body.sessionId);
    assert.equal(f.ctx.attaches.length,1);assert.equal(f.ctx.lives.length,1);
    assert.equal(f.ctx.reads.length,0);assert.equal(f.ctx.files.length,0);assert.equal(f.ctx.stats.length,0);assert.equal(f.ctx.sent.length,0);
    assert.equal((await f.delivery.submit(body)).state,'rejected');
    assert.equal(f.ctx.lives.length,1,'retry cannot reacquire or send to a replacement owner');
    assert.equal((await f.ledger.get(body.requestId)).dispatchedAt,undefined);
  }
});

test('missing attached desktop identity cannot authorize a writer even when both host IDs are missing',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=id=>({sessionId:id,desktopSessionId:null});
  f.ctx.liveHook=()=>({socketPath:'/fake/socket',entrypoint:'claude-desktop',hostSessionId:null});
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.errorCode,'DESKTOP_FOREIGN_WRITER');
  assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.reads.length,0);
});

test('wrong target session returned by intent is rejected before native I/O',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=()=>({sessionId:randomUUID(),desktopSessionId:'wrong-desktop'});
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.errorCode,'DESKTOP_TARGET_MISMATCH');
  assert.equal(result.sessionId,body.sessionId);assert.equal(f.ctx.sent.length,0);
});

test('ACK on a later 100ms query is accepted within the bounded window',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.sleepHook=()=>{if(f.ctx.clock>=1300)f.addAck(body.sessionId,body.requestId);};
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'accepted');assert.deepEqual(f.ctx.sleeps,[100,100,100]);
});

test('hard ACK deadline returns waiting even with a stuck read; late read cannot mutate outside guard',{timeout:2000},async t=>{
  const started=deferred(),blocked=deferred();let expire;
  const f=await fixture(t,{setTimer:callback=>{expire=callback;return 1;},clearTimer:()=>{}});
  const body=input({sessionId:randomUUID()});let reads=0;
  f.ctx.readHook=()=>{if(++reads===1)return {messages:[],cursor:42};started.resolve();return blocked.promise;};
  const submit=f.delivery.submit(body);
  await started.promise;expire();
  assert.equal((await submit).state,'dispatched');
  blocked.resolve({messages:[ack(body.requestId)],cursor:99});
  await yieldTurn();
  assert.equal((await f.ledger.get(body.requestId)).state,'dispatched');
  f.ctx.readHook=()=>({messages:[ack(body.requestId)],cursor:99});
  assert.equal((await f.delivery.status(body.requestId)).state,'accepted');
});

test('ACK query failure on an idle owner becomes unknown and later queries can reconcile it',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.liveHook=()=>({socketPath:'/fake/socket',token:'SECRET_NATIVE_TOKEN',status:'idle',entrypoint:'claude-desktop-3p',hostSessionId:'desktop-'+body.sessionId});
  f.ctx.sendHook=()=>{f.ctx.readHook=()=>{throw new Error('temporary transcript failure');};};
  assert.equal((await f.delivery.submit(body)).state,'unknown');
  delete f.ctx.readHook;f.addAck(body.sessionId,body.requestId);
  assert.equal((await f.delivery.status(body.requestId)).state,'accepted');
  assert.equal(f.ctx.sent.length,1);
});

test('status has no dispatch side effects for missing or rejected IDs',async t=>{
  const f=await fixture(t);
  assert.equal(await f.delivery.status(randomUUID()),null);
  await assert.rejects(f.delivery.status('../invalid'),error=>error.code==='INVALID_REQUEST_ID');
  assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.creates.length,0);assert.equal(f.ctx.attaches.length,0);
});

test('startup rejects interrupted prepared delivery; explicit new-ID retry attaches the original session',async t=>{
  const f=await fixture(t),body=input(),mark=f.ledger.mark.bind(f.ledger);
  f.ledger.mark=async(id,patch)=>{if(patch.state==='dispatched')throw Error('checkpoint interrupted');return mark(id,patch);};
  await assert.rejects(f.delivery.submit(body),/checkpoint interrupted/);
  const before=await f.ledger.get(body.requestId);assert.equal(before.state,'prepared');assert.equal(before.sessionId,body.requestId);
  assert.equal(f.ctx.creates.length,1);assert.equal(f.ctx.sent.length,0);
  const restartedLedger=new CommandLedger({dir:f.dir});await restartedLedger.recover();
  const restarted=new DesktopDelivery({...f.deps,ledger:restartedLedger});
  const rejected=await restarted.status(body.requestId);
  assert.equal(rejected.state,'rejected');assert.equal(rejected.delivery,'rejected');assert.equal(rejected.uncertain,false);
  assert.equal(rejected.errorCode,'GATEWAY_RESTART_BEFORE_DISPATCH');assert.match(rejected.error,/未发送/);assert.match(rejected.error,/新请求编号/);
  assert.equal(rejected.sessionId,body.requestId);assert.equal(rejected.desktopSessionId,before.desktopSessionId);
  assert.equal((await restartedLedger.get(body.requestId)).fingerprint,before.fingerprint);
  assert.equal((await restarted.submit(body)).state,'rejected');assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.creates.length,1);
  const retry=input({...body,requestId:randomUUID(),sessionId:rejected.sessionId});
  f.ctx.sendHook=frame=>f.addAck(retry.sessionId,frame.msgId);
  assert.equal((await restarted.submit(retry)).state,'accepted');
  assert.deepEqual(f.ctx.attaches,[body.requestId]);assert.equal(f.ctx.creates.length,1);assert.equal(f.ctx.sent.length,1);
  assert.equal(f.ctx.sent[0].msgId,retry.requestId);
});

test('restart before target checkpoint rejects prepared without inventing a desktop session',async t=>{
  const f=await fixture(t),body=input();
  f.ledger.mark=async()=>{throw Error('target checkpoint interrupted');};
  await assert.rejects(f.delivery.submit(body),/target checkpoint interrupted/);
  const ledger=new CommandLedger({dir:f.dir});await ledger.recover();
  const restarted=new DesktopDelivery({...f.deps,ledger});
  const result=await restarted.submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.errorCode,'GATEWAY_RESTART_BEFORE_DISPATCH');
  assert.equal(result.sessionId,null);assert.equal(result.desktopSessionId,null);
  assert.equal(f.ctx.creates.length,0);assert.equal(f.ctx.sent.length,0);
});

test('DESKTOP_PENDING is definitely unsent, retaining the original session for explicit new-ID attach',async t=>{
  for(const existing of [false,true]){
    const f=await fixture(t),body=input(existing?{sessionId:randomUUID()}:{}),target=body.sessionId||body.requestId;
    const hook=existing?'attachHook':'createHook';
    f.ctx[hook]=()=>{throw Object.assign(Error('SECRET_NATIVE_TOKEN'),{code:'DESKTOP_PENDING',sessionId:target,pendingDesktop:true,recoverable:true,stage:'importRequested'});};
    const result=await f.delivery.submit(body);
    assert.equal(result.state,'rejected');assert.equal(result.delivery,'rejected');assert.equal(result.uncertain,false);
    assert.equal(result.errorCode,'DESKTOP_ATTACH_PENDING');assert.match(result.error,/尚未确认/);assert.match(result.error,/未发送/);assert.match(result.error,/原会话/);
    assert.equal(result.sessionId,target);assert.equal(result.desktopSessionId,null);
    assert.equal(JSON.stringify(result).includes('SECRET_NATIVE_TOKEN'),false);
    assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.lives.length,0);
    assert.equal((await f.ledger.get(body.requestId)).dispatchedAt,undefined);
    delete f.ctx[hook];
    assert.equal((await f.delivery.submit(body)).state,'rejected','same rejected ID never restarts preflight');
    const retry={...body,sessionId:target,requestId:randomUUID()};
    f.ctx.sendHook=frame=>f.addAck(target,frame.msgId);
    assert.equal((await f.delivery.submit(retry)).state,'accepted');
    assert.equal(f.ctx.creates.length,existing?0:1);assert.equal(f.ctx.attaches.at(-1),target);assert.equal(f.ctx.sent.length,1);
  }
});

test('dispatched expires after 30s from dispatch on an idle owner, never resends, and late native ACK still accepts',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  assert.equal((await f.delivery.submit(body)).state,'dispatched');
  f.ctx.liveHook=()=>({socketPath:'/fake/socket',token:'SECRET_NATIVE_TOKEN',status:'idle',entrypoint:'claude-desktop-3p',hostSessionId:'desktop-'+body.sessionId});
  const before=await f.ledger.get(body.requestId);
  f.ctx.clock=before.dispatchedAt+29999;
  assert.equal((await f.delivery.status(body.requestId)).state,'dispatched');
  assert.equal((await f.delivery.status(body.requestId)).state,'dispatched');
  f.ctx.clock=before.dispatchedAt+30000;
  const expired=await f.delivery.status(body.requestId);
  assert.equal(expired.state,'unknown');assert.equal(expired.delivery,'unknown');assert.equal(expired.uncertain,true);
  assert.equal(expired.errorCode,'NATIVE_OUTCOME_UNKNOWN');
  const after=await f.ledger.get(body.requestId);
  assert.equal(after.dispatchedAt,before.dispatchedAt);assert.equal(after.fingerprint,before.fingerprint);
  assert.equal((await f.delivery.submit(body)).state,'unknown');assert.equal(f.ctx.sent.length,1);assert.equal(f.ctx.attaches.length,1);
  f.ctx.clock+=100000;f.addAck(body.sessionId,body.requestId);
  const accepted=await f.delivery.status(body.requestId);
  assert.equal(accepted.state,'accepted');assert.equal(accepted.uncertain,false);assert.equal(accepted.error,null);
  assert.equal(f.ctx.sent.length,1);
});

test('a busy owner keeps a dispatched message waiting past 30s instead of turning it into an unknown error',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});await f.delivery.submit(body);
  f.ctx.clock=(await f.ledger.get(body.requestId)).dispatchedAt+30001;
  const entered=deferred(),blocked=deferred();
  f.ctx.readHook=()=>{entered.resolve();return blocked.promise;};
  const query=f.delivery.status(body.requestId);await entered.promise;
  assert.equal((await f.ledger.get(body.requestId)).state,'dispatched');
  blocked.resolve({messages:[],cursor:100});
  const waiting=await query;
  assert.equal(waiting.state,'dispatched');assert.equal(waiting.delivery,'waiting');
  assert.equal(waiting.uncertain,false);
  assert.equal(f.ctx.sent.length,1);
});


test('a transport sent:false error remains conservatively unknown without automatic retry',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.sendHook=()=>{throw Object.assign(Error('connect failure'),{sent:false});};
  assert.equal((await f.delivery.submit(body)).state,'unknown');
  assert.equal((await f.delivery.submit(body)).state,'unknown');assert.equal(f.ctx.sent.length,1);
});

test('sends the first message after desktop attachment without a separate desktop controller',async t=>{
 const f=await fixture(t),body=input();
 f.ctx.sendHook=frame=>f.addAck(body.requestId,frame.msgId);
 const result=await f.delivery.submit(body);
 assert.equal(result.state,'accepted');
 assert.equal(f.ctx.creates.length,1);
 assert.equal(f.ctx.sent.length,1);
});
