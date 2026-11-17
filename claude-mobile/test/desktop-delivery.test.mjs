import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';
import {CommandLedger} from '../backend/lib/command-ledger.mjs';
import {DesktopDelivery} from '../backend/lib/desktop-delivery.mjs';

const input=(extra={})=>({requestId:randomUUID(),cwd:'/fake/project',text:'private message sentinel',model:'fake-model',permissionMode:'acceptEdits',attachments:[],priority:'now',...extra});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const ack=(id)=>({id,role:'user',text:'native user record'});

async function fixture(t,options={}){
  const dir=await mkdtemp(join(tmpdir(),'claude-desktop-delivery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const ledger=new CommandLedger({dir});
  const ctx={creates:[],attaches:[],sent:[],reads:[],lives:[],files:[],stats:[],checkpoints:[],settingsReads:0,messages:new Map(),sleeps:[],clock:1000,cursor:42};
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
    // Tests never touch the real ~/.claude/settings.json. Default: the inbound
    // switch is accepted so only dedicated preflight cases opt out.
    async readUserSettings(){ctx.settingsReads++;return ctx.settingsHook?ctx.settingsHook():{crossSessionInbound:'accept'};},
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

// --- 追加修复：bypass 会话的跨会话接收预检 -------------------------

test('a bypass target without crossSessionInbound accept is rejected before dispatch instead of hanging',async t=>{
  for(const settings of [null,{},{crossSessionInbound:'hold'},{crossSessionInbound:'refuse'}]){
    const f=await fixture(t),body=input({sessionId:randomUUID()});
    f.ctx.attachHook=id=>({sessionId:id,desktopSessionId:'desktop-'+id,permissionMode:'bypassPermissions'});
    f.ctx.settingsHook=()=>settings;
    const result=await f.delivery.submit(body);
    assert.equal(result.state,'rejected');assert.equal(result.delivery,'rejected');assert.equal(result.uncertain,false);
    assert.equal(result.errorCode,'CROSS_SESSION_INBOUND_NOT_ACCEPTED');
    assert.match(result.error,/~\/\.claude\/settings\.json/);
    assert.match(result.error,/"crossSessionInbound": "accept"/);
    assert.match(result.error,/未发送/);
    assert.equal(result.sessionId,body.sessionId);assert.equal(result.desktopSessionId,'desktop-'+body.sessionId);
    assert.equal(f.ctx.sent.length,0);assert.equal(f.ctx.lives.length,0);
    assert.equal(f.ctx.reads.length,0);assert.equal(f.ctx.files.length,0);
    assert.equal((await f.ledger.get(body.requestId)).dispatchedAt,undefined);
  }
});

test('unreadable user settings cannot prove the inbound switch, so a bypass target is rejected',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=id=>({sessionId:id,desktopSessionId:'desktop-'+id,permissionMode:'bypassPermissions'});
  f.ctx.settingsHook=()=>{throw new Error('EACCES: settings unreadable');};
  const result=await f.delivery.submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.errorCode,'CROSS_SESSION_INBOUND_NOT_ACCEPTED');
  assert.equal(JSON.stringify(result).includes('EACCES'),false);
  assert.equal(f.ctx.sent.length,0);
});

test('accepting crossSessionInbound dispatches a bypass target with the matching permission class',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=id=>({sessionId:id,desktopSessionId:'desktop-'+id,permissionMode:'bypassPermissions'});
  f.ctx.settingsHook=()=>({crossSessionInbound:'accept'});
  f.ctx.sendHook=frame=>{f.addAck(body.sessionId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  assert.equal((await f.delivery.submit(body)).state,'accepted');
  assert.equal(f.ctx.sent[0].fromMode,'bypass');
  assert.equal(f.ctx.settingsReads,1);
});

test('a new bypass session also needs the inbound switch; other modes never read user settings',async t=>{
  const created=await fixture(t),body=input({permissionMode:'bypassPermissions'});
  created.ctx.settingsHook=()=>null;
  assert.equal((await created.delivery.submit(body)).state,'rejected');
  assert.equal(created.ctx.sent.length,0);

  const plain=await fixture(t),plainBody=input();
  plain.ctx.sendHook=frame=>{plain.addAck(plainBody.requestId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  assert.equal((await plain.delivery.submit(plainBody)).state,'accepted');

  const existing=await fixture(t),existingBody=input({sessionId:randomUUID()});
  existing.ctx.sendHook=frame=>{existing.addAck(existingBody.sessionId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  assert.equal((await existing.delivery.submit(existingBody)).state,'accepted');
  assert.equal(existing.ctx.settingsReads,0);
});

// Point the documented default settings reader at an isolated config directory
// and drop the injected fake, so the real settings.json parsing runs.
async function useRealUserSettings(t,text){
  const configDir=await mkdtemp(join(tmpdir(),'claude-user-settings-'));
  t.after(()=>rm(configDir,{recursive:true,force:true}));
  await writeFile(join(configDir,'settings.json'),text,'utf8');
  const previous=process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR=configDir;
  t.after(()=>{
    if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR=previous;
  });
}
function realSettingsDelivery(f){
  const deps={...f.deps};delete deps.readUserSettings;
  return new DesktopDelivery(deps);
}

test('a user settings file that is not valid JSON does not reject a legitimate bypass send',async t=>{
  await useRealUserSettings(t,'{"crossSessionInbound":"accept",}');
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=id=>({sessionId:id,desktopSessionId:'desktop-'+id,permissionMode:'bypassPermissions'});
  f.ctx.sendHook=frame=>{f.addAck(body.sessionId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  const result=await realSettingsDelivery(f).submit(body);
  assert.equal(result.state,'accepted','an unparsable switch cannot prove the inbox is off');
  assert.equal(f.ctx.sent.length,1);
  assert.equal(f.ctx.sent[0].fromMode,'bypass');
  assert.equal(f.ctx.settingsReads,0,'the real reader replaced the injected fake');
});

test('a parsed user settings file without accept still rejects a bypass send',async t=>{
  await useRealUserSettings(t,JSON.stringify({crossSessionInbound:'hold'}));
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.attachHook=id=>({sessionId:id,desktopSessionId:'desktop-'+id,permissionMode:'bypassPermissions'});
  const result=await realSettingsDelivery(f).submit(body);
  assert.equal(result.state,'rejected');assert.equal(result.errorCode,'CROSS_SESSION_INBOUND_NOT_ACCEPTED');
  assert.equal(f.ctx.sent.length,0);
});

// --- 追加修复：dispatch 之前/之后的错误语义 -----------------------

test('pre-dispatch failures are tagged notDispatched so the phone never treats them as unknown',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  f.ctx.sendHook=frame=>{f.addAck(body.sessionId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  await f.delivery.submit(body);
  await assert.rejects(f.delivery.submit({...body,text:'changed payload'}),error=>{
    assert.equal(error.code,'COMMAND_ID_COLLISION');assert.equal(error.status,409);
    assert.equal(error.notDispatched,true);
    return true;
  });
  assert.equal(f.ctx.sent.length,1);
});

test('a failure after the dispatched checkpoint stays unknown without a notDispatched claim',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()}),mark=f.ledger.mark.bind(f.ledger);
  f.ctx.sendHook=frame=>{f.addAck(body.sessionId,frame.msgId);return{accepted:true,msgId:frame.msgId};};
  f.ledger.mark=async(id,patch)=>{
    if(patch.state==='accepted')throw Object.assign(Error('ledger write failed after dispatch'),{code:'LEDGER_WRITE_FAILED',statusCode:500});
    return mark(id,patch);
  };
  await assert.rejects(f.delivery.submit(body),error=>{
    assert.equal(error.code,'LEDGER_WRITE_FAILED');
    assert.equal(error.notDispatched,undefined);
    return true;
  });
  assert.equal(f.ctx.sent.length,1);
  assert.equal((await f.ledger.get(body.requestId)).state,'dispatched');
});

test('a reconcile failure on a replayed dispatched request never becomes a resendable rejection',async t=>{
  for(const prior of ['dispatched','unknown']){
    const f=await fixture(t),body=input({sessionId:randomUUID()});
    if(prior==='unknown')f.ctx.sendHook=()=>{throw new Error('socket wrote then disconnected');};
    assert.equal((await f.delivery.submit(body)).state,prior);
    assert.equal(f.ctx.sent.length,1);
    // The native message is already in the transcript; only persisting the ACK
    // fails, which is exactly the reconcile error a replay must absorb.
    f.addAck(body.sessionId,body.requestId);
    const mark=f.ledger.mark.bind(f.ledger);
    f.ledger.mark=async(id,patch)=>{
      if(patch.state==='accepted')throw Object.assign(new Error('ledger write failed'),{code:'LEDGER_WRITE_FAILED',statusCode:500});
      return mark(id,patch);
    };
    const replay=await f.delivery.submit(body);
    assert.equal(replay.state,prior,'the stored post-dispatch state is preserved, never rejected');
    assert.equal(replay.delivery,prior==='unknown'?'unknown':'waiting');
    assert.equal(replay.uncertain,prior==='unknown');
    assert.equal(f.ctx.sent.length,1,'a replay never reaches native I/O again');
    assert.equal((await f.ledger.get(body.requestId)).state,prior,'no rejected rewrite happened');
    f.ledger.mark=mark;
    assert.equal((await f.delivery.status(body.requestId)).state,'accepted','a later reconcile still accepts');
    assert.equal(f.ctx.sent.length,1);
  }
});

test('the gateway turns notDispatched errors into 409 rejections and keeps post-dispatch errors unknown',async()=>{
  const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function deliveryFailure(error){'),end=source.indexOf('\nasync function chat(req,res){',start);
  assert.ok(start>=0&&end>start);
  const deliveryFailure=runInNewContext(source.slice(start,end)+'\ndeliveryFailure;',{});
  // VM-realm objects have a different Object.prototype, so compare fields.
  const preDispatch=deliveryFailure(Object.assign(Error('本条消息未发送'),{code:'COMMAND_ID_COLLISION',statusCode:409,notDispatched:true}));
  assert.equal(preDispatch.status,409);
  assert.equal(preDispatch.body.error,'本条消息未发送');
  assert.equal(preDispatch.body.code,'COMMAND_ID_COLLISION');
  assert.equal(preDispatch.body.delivery,'rejected');
  assert.equal(preDispatch.body.notDispatched,true);
  const afterDispatch=deliveryFailure(Object.assign(Error('写入失败'),{code:'LEDGER_WRITE_FAILED',statusCode:500}));
  assert.equal(afterDispatch.status,500);assert.equal(afterDispatch.body.delivery,'unknown');assert.equal(afterDispatch.body.notDispatched,false);
  const plain=deliveryFailure(Error('boom'));
  assert.equal(plain.status,500);assert.equal(plain.body.code,'DELIVERY_ERROR');
});

// --- 追加修复：启动时先 reconcile 再服务请求 ----------------------

test('startup reconcile accepts a dispatched command the native JSONL already contains',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  assert.equal((await f.delivery.submit(body)).state,'dispatched');
  f.addAck(body.sessionId,body.requestId);
  const ledger=new CommandLedger({dir:f.dir});
  const restarted=new DesktopDelivery({...f.deps,ledger});
  const recovered=await restarted.recoverStartup();
  assert.equal(recovered.length,1);
  assert.equal(recovered[0].state,'accepted');assert.equal(recovered[0].errorCode,null);
  assert.equal((await ledger.get(body.requestId)).state,'accepted');
  assert.equal(f.ctx.sent.length,1,'recovery never replays the native write');
});

test('startup reconcile keeps a command unknown when the native transcript cannot be read',async t=>{
  const f=await fixture(t),body=input({sessionId:randomUUID()});
  assert.equal((await f.delivery.submit(body)).state,'dispatched');
  const ledger=new CommandLedger({dir:f.dir});
  const restarted=new DesktopDelivery({...f.deps,ledger});
  f.ctx.readHook=()=>{throw new Error('transcript temporarily unavailable');};
  f.ctx.liveHook=id=>({socketPath:'/fake/socket',status:'idle',entrypoint:'claude-desktop-3p',hostSessionId:'desktop-'+id});
  const recovered=await restarted.recoverStartup();
  assert.equal(recovered.length,1);
  assert.equal(recovered[0].state,'unknown');assert.equal(recovered[0].uncertain,true);
  assert.equal((await ledger.get(body.requestId)).state,'unknown');
  assert.equal(f.ctx.sent.length,1);
});

test('startup reconcile rejects a prepared command without reading any session transcript',async t=>{
  const f=await fixture(t),body=input(),mark=f.ledger.mark.bind(f.ledger);
  f.ledger.mark=async(id,patch)=>{if(patch.state==='dispatched')throw Error('interrupted before dispatch');return mark(id,patch);};
  await assert.rejects(f.delivery.submit(body),/interrupted before dispatch/);
  f.ledger.mark=mark;
  const reads=f.ctx.reads.length;
  const ledger=new CommandLedger({dir:f.dir});
  const restarted=new DesktopDelivery({...f.deps,ledger});
  const recovered=await restarted.recoverStartup();
  assert.equal(recovered.length,1);
  assert.equal(recovered[0].state,'rejected');assert.equal(recovered[0].errorCode,'GATEWAY_RESTART_BEFORE_DISPATCH');
  assert.equal(f.ctx.reads.length,reads,'a never-dispatched command needs no transcript');
  assert.equal(f.ctx.sent.length,0);
});

test('gateway reserves its listener before recovery but serves requests only after recovery',async()=>{
  const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
  const reconcile=source.indexOf('await desktopDelivery.recoverStartup()');
  const listen=source.indexOf('server.listen('),ready=source.indexOf('initialized=true');
  assert.ok(listen>0&&reconcile>listen,'a conflicting process cannot recover another live gateway ledger');
  assert.ok(ready>reconcile,'recovery finishes before the listener serves application requests');
  assert.match(source,/if\(!initialized\)return json\(res,503/);
  assert.equal(source.includes('await commandLedger.recover()'),false,'the old blind recovery is gone');
});

// --- 追加修复：上传超限与文件预览缓存 -----------------------------

test('oversized bodies drain and reject with an overflow marker instead of destroying the socket',async()=>{
  const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function readBody(req,limit=200*1024){'),end=source.indexOf('\nconst UPLOADS=',start);
  assert.ok(start>=0&&end>start);
  const readBody=runInNewContext(source.slice(start,end)+'\nreadBody;',{Buffer});
  const {EventEmitter}=await import('node:events');
  const drive=async(limit,chunks)=>{
    const req=new EventEmitter();let resumed=0,destroyed=0;
    req.resume=()=>{resumed++;};req.destroy=()=>{destroyed++;};
    const result=readBody(req,limit).then(value=>({value}),error=>({error}));
    for(const chunk of chunks)req.emit('data',Buffer.from(chunk));
    req.emit('end');
    return {...await result,resumed,destroyed};
  };
  const over=await drive(8,['x'.repeat(8),'y'.repeat(8)]);
  assert.equal(over.error.overflow,true);
  assert.equal(over.resumed,1,'the remaining upload body is drained, not buffered');
  assert.equal(over.destroyed,0,'the response must stay writable so the phone receives 413');
  const ok=await drive(64,['{"text":"hi"}']);
  assert.equal(ok.value.text,'hi');
  const invalid=await drive(64,['not json']);
  assert.equal(invalid.error.message,'请求格式无效');
});

async function referencedHelpers(){
  const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const REFERENCED_CACHE_LIMIT=32;'),end=source.indexOf('\nasync function upload(req,res){',start);
  assert.ok(start>=0&&end>start);
  return runInNewContext(source.slice(start,end)+'\n({sessionCwdCached,allowedPathsFor,resolveReferencedFileCached});',{
    readFile:async()=>{throw Error('readFile must be injected');},
    stat:async()=>({isFile:()=>true}),
    dirname:path=>path.slice(0,path.lastIndexOf('/'))||'/',
    localPath:(value,cwd)=>value.startsWith('/')?value:(cwd.replace(/\/+$/,'')+'/'+value),
    referencedPaths:(raw,cwd)=>new Set(raw.split('\n').filter(Boolean)),
    isReferencedDependency:async()=>false,
    sessionCwd:async()=>null,
  });
}

test('file previews reuse the cached transcript authorization set until the file changes',async()=>{
  const helpers=await referencedHelpers();
  const entry={path:'/sessions/s.jsonl',mtimeMs:10,size:20};
  let reads=0;
  const readText=async()=>{reads++;return '/proj/a.png\n/proj/b.png';};
  assert.equal((await helpers.resolveReferencedFileCached({entry,cwd:'/proj',requested:'a.png',readText})).file,'/proj/a.png');
  assert.equal(reads,1);
  assert.equal((await helpers.resolveReferencedFileCached({entry,cwd:'/proj',requested:'b.png',readText})).file,'/proj/b.png');
  assert.equal(reads,1,'a cache hit does not read the whole transcript again');
  assert.equal(await helpers.resolveReferencedFileCached({entry,cwd:'/proj',requested:'secret.png',readText}),null);
  assert.equal(reads,1);
  await helpers.resolveReferencedFileCached({entry:{...entry,size:21,mtimeMs:11},cwd:'/proj',requested:'a.png',readText});
  assert.equal(reads,2,'path+mtime+size change rebuilds the set');
});

test('concurrent file previews share one transcript rebuild',async()=>{
  const helpers=await referencedHelpers();
  let reads=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const readText=async()=>{reads++;await gate;return '/proj/a.png';};
  const entry={path:'/sessions/c.jsonl',mtimeMs:1,size:5};
  const pending=[
    helpers.resolveReferencedFileCached({entry,cwd:'/proj',requested:'a.png',readText}),
    helpers.resolveReferencedFileCached({entry,cwd:'/proj',requested:'a.png',readText}),
  ];
  release();
  const [one,two]=await Promise.all(pending);
  assert.equal(reads,1,'both requests await the same rebuild');
  assert.equal(one.file,'/proj/a.png');assert.equal(two.file,'/proj/a.png');
});

// --- 追加修复：/claude/api/session/:id 上滑加载更早消息 ------------

test('session transcript route pages backwards with before and normalizes invalid cursors',async()=>{
  const source=await readFile(new URL('../backend/server.mjs',import.meta.url),'utf8');
  const helperStart=source.indexOf('function transcriptQuery(searchParams){');
  const helperEnd=source.indexOf('\nconst UPLOADS=',helperStart);
  const routeStart=source.indexOf("if(path.startsWith('/claude/api/session/')){");
  const routeEnd=source.indexOf("\n  if(path.startsWith('/claude/api/command/')",routeStart);
  assert.ok(helperStart>=0&&helperEnd>helperStart);
  assert.ok(routeStart>=0&&routeEnd>routeStart);
  const transcriptQuery=runInNewContext(source.slice(helperStart,helperEnd)+'\ntranscriptQuery;',{});
  const id='11111111-1111-4111-8111-111111111111';
  const invoke=async search=>{
    const calls=[],result={};
    const context={
      path:'/claude/api/session/'+id,
      url:{searchParams:new URLSearchParams(search)},
      req:{headers:{}},
      res:{},
      accessToken:'token',COOKIE_CLAUDE:'cookie',
      readCookie:()=>'token',
      json:(res,status,value)=>{result.status=status;result.value=value;},
      readTranscript:async(...args)=>{calls.push(args);return {messages:[{id:'message-1',role:'user',seq:1}],cursor:9,before:7,hasMore:true};},
      hydratePhoneAttachments:async()=>{},
      desktopDelivery:{annotateTranscript:value=>structuredClone(value)},
      sessionControl:async()=>({attached:true,permissionMode:'acceptEdits'}),
      sessionReadMarker:async()=>null,
      transcriptQuery,
    };
    await runInNewContext('(async()=>{\n'+source.slice(routeStart,routeEnd)+'\n})',context)();
    return {calls,result};
  };
  const paged=await invoke('?before=7&since=3');
  assert.deepEqual(paged.calls,[[id,0,7,null]],'before wins over since and an absent prefix anchor is forwarded as null');
  assert.equal(paged.result.status,200);
  assert.deepEqual(paged.result.value.messages,[{id:'message-1',role:'user',seq:1}]);
  assert.equal(paged.result.value.before,7);assert.equal(paged.result.value.hasMore,true);assert.equal(paged.result.value.cursor,9);
  assert.equal(paged.result.value.control.attached,true);
  assert.deepEqual((await invoke('?since=4')).calls,[[id,4,0,null]]);
  assert.deepEqual((await invoke('?before=0&since=4')).calls,[[id,4,0,null]],'before=0 means no page request');
  assert.deepEqual((await invoke('?before=abc&since=-5')).calls,[[id,0,0,null]],'non-finite and negative are absent');
  assert.deepEqual((await invoke('?since=4&before=abc')).calls,[[id,4,0,null]],'invalid before keeps the incremental cursor');
  assert.deepEqual((await invoke('?before=12.7')).calls,[[id,0,12,null]],'fractional seq is floored');
  assert.deepEqual((await invoke('?before=Infinity')).calls,[[id,0,0,null]]);
  assert.deepEqual((await invoke('')).calls,[[id,0,0,null]]);
  const anchor='a'.repeat(64);
  assert.deepEqual((await invoke('?since=4&anchor='+anchor)).calls,[[id,4,0,anchor]],'the native prefix digest reaches rewrite detection unchanged');
});
