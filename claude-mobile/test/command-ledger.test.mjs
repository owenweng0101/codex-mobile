import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CommandLedger} from '../backend/lib/command-ledger.mjs';

const payload=()=>({sessionId:randomUUID(),cwd:'/isolated/project',text:'private prompt sentinel',model:'test-model',mode:'acceptEdits',attachments:[{id:'test-attachment',name:'private-name.png'}],priority:'normal'});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'claude-command-ledger-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'commands');
  return {root,dir,ledger:new CommandLedger({dir})};
}
const rejectsCode=(code,status)=>error=>{
  assert.equal(error.code,code);
  if(status){assert.equal(error.status,status);assert.equal(error.statusCode,status);}
  return true;
};

test('prepare persists stable identity and a fingerprint, with 0600 records and no prompt',async t=>{
  const {dir,ledger}=await fixture(t),id=randomUUID(),body=payload();
  const result=await ledger.prepare(id,body);
  assert.equal(result.existing,false);
  assert.equal(result.record.requestId,id);
  assert.equal(result.record.messageId,id);
  assert.equal(result.record.state,'prepared');
  assert.match(result.record.fingerprint,/^[a-f0-9]{64}$/);
  const path=join(dir,id+'.json');
  const disk=await readFile(path,'utf8');
  assert.deepEqual(JSON.parse(disk),result.record,'prepare resolves only after the record exists');
  assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await stat(dir)).mode&0o777,0o700);
  for(const secret of [body.text,body.cwd,body.attachments[0].name])assert.equal(disk.includes(secret),false);
  assert.deepEqual(await readdir(dir),[id+'.json'],'no temporary files remain');
  const reordered=Object.fromEntries(Object.entries(body).reverse());
  reordered.attachments=[{name:'private-name.png',id:'test-attachment'}];
  assert.deepEqual(await ledger.prepare(id,reordered),{record:result.record,existing:true});
  result.record.state='accepted';
  assert.equal((await ledger.get(id)).state,'prepared','returned objects cannot change durable state');
});

test('simultaneous prepare calls across instances create exactly one new command',async t=>{
  const {dir,ledger}=await fixture(t),id=randomUUID(),body=payload();
  const other=new CommandLedger({dir});
  const results=await Promise.all(Array.from({length:40},(_,index)=>(index%2?other:ledger).prepare(id,body)));
  assert.equal(results.filter(result=>!result.existing).length,1);
  assert.equal(new Set(results.map(result=>result.record.fingerprint)).size,1);
  assert.ok(results.every(result=>result.record.messageId===id&&result.record.state==='prepared'));
  assert.deepEqual(await readdir(dir),[id+'.json']);
});

test('every semantic payload field participates in same-ID conflict detection',async t=>{
  const {ledger}=await fixture(t),id=randomUUID(),body=payload();
  const original=await ledger.prepare(id,body);
  const changes={sessionId:randomUUID(),cwd:'/different',text:'different secret',model:'different',mode:'bypassPermissions',attachments:[],priority:'high'};
  for(const [key,value] of Object.entries(changes)){
    await assert.rejects(ledger.prepare(id,{...body,[key]:value}),error=>{
      rejectsCode('COMMAND_ID_COLLISION',409)(error);
      assert.equal(error.message.includes(body.text),false);
      assert.equal(error.message.includes('different secret'),false);
      assert.equal(error.record,undefined);
      return true;
    });
  }
  assert.deepEqual(await ledger.get(id),original.record);
});

test('concurrent different payloads cannot overwrite the winning request',async t=>{
  const {ledger}=await fixture(t),id=randomUUID(),body=payload();
  const results=await Promise.allSettled([ledger.prepare(id,body),ledger.prepare(id,{...body,text:'other'})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  assert.equal((await ledger.prepare(id,body)).existing,true);
});

test('mark serializes atomic updates, retains identity, and never infers accepted',async t=>{
  const {dir,ledger}=await fixture(t),id=randomUUID(),body=payload();
  const original=(await ledger.prepare(id,body)).record;
  await ledger.mark(id,{state:'dispatched',dispatchedAt:123});
  await ledger.mark(id,{httpWritten:true,httpStatus:200});
  assert.equal((await ledger.get(id)).state,'dispatched','HTTP completion is not a native ACK');
  await Promise.all([ledger.mark(id,{firstMarker:1}),ledger.mark(id,{secondMarker:2})]);
  const ack=await ledger.mark(id,{state:'accepted',ack:{messageId:id,native:true}});
  assert.equal(ack.firstMarker,1);
  assert.equal(ack.secondMarker,2);
  assert.equal(ack.messageId,id);
  assert.equal(ack.fingerprint,original.fingerprint);
  assert.equal(ack.createdAt,original.createdAt);
  assert.equal(ack.state,'accepted');
  assert.deepEqual((await ledger.prepare(id,body)).record,ack);
  assert.equal((await stat(join(dir,id+'.json'))).mode&0o777,0o600);
  assert.deepEqual(await readdir(dir),[id+'.json']);
});

test('restart recovery rejects unsent prepared, marks dispatched unknown and preserves target identity',async t=>{
  const {root,dir,ledger}=await fixture(t);
  const ids={prepared:randomUUID(),dispatched:randomUUID(),accepted:randomUUID(),rejected:randomUUID(),unknown:randomUUID()};
  const body=payload();
  for(const [state,id] of Object.entries(ids)){
    await ledger.prepare(id,body);
    if(['dispatched','accepted','unknown'].includes(state))await ledger.mark(id,{state:'dispatched'});
    if(['accepted','rejected','unknown'].includes(state))await ledger.mark(id,{state});
  }
  const sessionId=randomUUID();
  await ledger.mark(ids.prepared,{sessionId,desktopSessionId:'native-desktop-id',attachmentIds:['attachment-id'],delivery:'waiting'});
  const intentDir=join(root,'desktop-intents');await mkdir(intentDir);
  const intentPath=join(intentDir,sessionId+'.json'),intent=JSON.stringify({sessionId,phase:'importRequested'});
  await writeFile(intentPath,intent,{mode:0o600});
  const preparedBefore=await ledger.get(ids.prepared);
  const restarted=new CommandLedger({dir});
  const recovered=await restarted.recover();
  assert.equal(recovered.length,2);
  const unknown=recovered.find(record=>record.requestId===ids.dispatched);
  assert.equal(unknown.state,'unknown');assert.equal(unknown.errorCode,'NATIVE_OUTCOME_UNKNOWN');assert.equal(unknown.uncertain,true);
  const rejected=await restarted.get(ids.prepared);
  assert.equal(rejected.state,'rejected');assert.equal(rejected.delivery,'rejected');assert.equal(rejected.uncertain,false);
  assert.equal(rejected.errorCode,'GATEWAY_RESTART_BEFORE_DISPATCH');assert.match(rejected.error,/未发送/);
  for(const key of ['requestId','messageId','fingerprint','createdAt','sessionId','desktopSessionId','attachmentIds'])assert.deepEqual(rejected[key],preparedBefore[key]);
  assert.equal(await readFile(intentPath,'utf8'),intent,'recovery must not change the desktop intent');
  assert.equal((await stat(join(dir,ids.prepared+'.json'))).mode&0o777,0o600);
  for(const [state,id] of Object.entries(ids)){
    const result=await restarted.prepare(id,body);
    assert.equal(result.existing,true,'recovery never grants a second dispatch');
    assert.equal(result.record.state,state==='dispatched'?'unknown':state==='prepared'?'rejected':state);
    assert.equal(result.record.messageId,id);
  }
  assert.deepEqual(await restarted.recover(),[],'recovery is idempotent');
  await assert.rejects(restarted.mark(ids.unknown,{state:'dispatched'}),rejectsCode('INVALID_COMMAND_TRANSITION',409));
  await assert.rejects(restarted.mark(ids.dispatched,{state:'prepared'}),rejectsCode('INVALID_COMMAND_TRANSITION',409));
  assert.equal((await restarted.mark(ids.dispatched,{state:'accepted',ack:{messageId:ids.dispatched}})).state,'accepted','a late native ACK can resolve unknown');
});

test('invalid IDs and immutable patches fail without creating files',async t=>{
  const {dir,ledger}=await fixture(t),id=randomUUID();
  for(const invalid of [null,42,'','../escape',id+'.json','00000000-0000-0000-0000-000000000000']){
    await assert.rejects(ledger.prepare(invalid,payload()),rejectsCode('INVALID_REQUEST_ID',400));
    await assert.rejects(ledger.get(invalid),rejectsCode('INVALID_REQUEST_ID',400));
    await assert.rejects(ledger.mark(invalid,{state:'dispatched'}),rejectsCode('INVALID_REQUEST_ID',400));
  }
  await assert.rejects(stat(dir),{code:'ENOENT'});
  assert.equal(await ledger.get(id),null);
  await assert.rejects(ledger.mark(id,{state:'dispatched'}),rejectsCode('COMMAND_NOT_FOUND',404));
  await ledger.prepare(id,payload());
  for(const key of ['requestId','messageId','fingerprint','version','createdAt','updatedAt'])await assert.rejects(ledger.mark(id,{[key]:'changed'}),rejectsCode('INVALID_COMMAND_PATCH',400));
  await assert.rejects(ledger.mark(id,{state:'not-a-state'}),rejectsCode('INVALID_COMMAND_STATE',400));
  await assert.rejects(ledger.mark(id,{state:'accepted'}),rejectsCode('INVALID_COMMAND_TRANSITION',409));
  assert.equal((await ledger.get(id)).state,'prepared');
});

test('invalid JSON payloads do not reach persistence, and object key order is stable',async t=>{
  const {ledger}=await fixture(t);
  const cyclic={};cyclic.self=cyclic;
  for(const body of [null,[],42,cyclic,{text:1n},{text:NaN},{text:()=>{}},{text:new Date()}])await assert.rejects(ledger.prepare(randomUUID(),body),rejectsCode('INVALID_COMMAND_PAYLOAD',400));
  // An omitted optional field has the same semantics as an undefined field.
  const stable=randomUUID(),body=payload();
  await ledger.prepare(stable,{...body,optional:undefined});
  assert.equal((await ledger.prepare(stable,body)).existing,true);
});

test('recovery survives actual process exit with stable IDs and no automatic dispatch',async t=>{
  const {dir}=await fixture(t),prepared=randomUUID(),dispatched=randomUUID();
  const moduleURL=new URL('../backend/lib/command-ledger.mjs',import.meta.url).href;
  const code=`
    import {CommandLedger} from ${JSON.stringify(moduleURL)};
    const ledger=new CommandLedger({dir:process.argv[1]});
    const body={sessionId:null,cwd:'/test',text:'restart-probe',model:'test',mode:'acceptEdits',attachments:[],priority:'normal'};
    await ledger.prepare(process.argv[2],body);
    await ledger.prepare(process.argv[3],body);
    await ledger.mark(process.argv[3],{state:'dispatched'});
  `;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',code,dir,prepared,dispatched]);
  assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  const restarted=new CommandLedger({dir});
  assert.equal((await restarted.get(dispatched)).state,'dispatched');
  const recovered=await restarted.recover();
  assert.equal(recovered.length,2);
  assert.equal(recovered.find(record=>record.requestId===dispatched).messageId,dispatched);
  assert.equal((await restarted.get(dispatched)).state,'unknown');
  assert.equal((await restarted.get(prepared)).state,'rejected');
  assert.equal((await restarted.get(prepared)).errorCode,'GATEWAY_RESTART_BEFORE_DISPATCH');
});

test('accepted and rejected are terminal, and a failed recovery never invents success',async t=>{
  const {ledger}=await fixture(t);
  for(const state of ['accepted','rejected']){
    const id=randomUUID();await ledger.prepare(id,payload());
    if(state==='accepted')await ledger.mark(id,{state:'dispatched'});
    await ledger.mark(id,{state});
    for(const next of ['prepared','dispatched','unknown'])await assert.rejects(ledger.mark(id,{state:next}),rejectsCode('INVALID_COMMAND_TRANSITION',409));
    assert.equal((await ledger.get(id)).state,state);
  }
  const id=randomUUID();await ledger.prepare(id,payload());await ledger.mark(id,{state:'dispatched'});
  const save=ledger._save.bind(ledger);
  ledger._save=async()=>{throw Object.assign(new Error('simulated persistence failure'),{code:'LEDGER_WRITE_FAILED'});};
  await assert.rejects(ledger.recover(),rejectsCode('LEDGER_WRITE_FAILED'));
  assert.equal((await ledger.get(id)).state,'dispatched');
  ledger._save=save;
  assert.equal((await ledger.recover())[0].state,'unknown');
});

test('disk failure in prepare prevents dispatch and a later attempt remains controllable',async t=>{
  const {root}=await fixture(t),blocked=join(root,'not-a-directory');
  await writeFile(blocked,'block');
  const ledger=new CommandLedger({dir:join(blocked,'commands')}),id=randomUUID(),body=payload();
  let dispatched=0;
  const submit=async()=>{
    const result=await ledger.prepare(id,body);
    if(result.existing)return result;
    await ledger.mark(id,{state:'dispatched'});
    dispatched++;
  };
  await assert.rejects(submit(),rejectsCode('LEDGER_READ_FAILED',500));
  assert.equal(dispatched,0);
  await rm(blocked);await mkdir(blocked);
  await submit();
  assert.equal(dispatched,1);
  assert.equal((await ledger.get(id)).state,'dispatched');
  await submit();assert.equal(dispatched,1,'same ID is never dispatched again');
});

test('failed atomic write leaves previous state intact and does not poison the queue',async t=>{
  const {dir,ledger}=await fixture(t),id=randomUUID(),body=payload();
  const original=(await ledger.prepare(id,body)).record;
  const save=ledger._save.bind(ledger),parked=dir+'-parked';
  // Inject a real filesystem failure after the read, at the persistence boundary.
  ledger._save=async record=>{
    await rename(dir,parked);await writeFile(dir,'not a directory');
    try{return await save(record);}
    finally{await rm(dir);await rename(parked,dir);}
  };
  let dispatched=0;
  await assert.rejects((async()=>{await ledger.mark(id,{state:'dispatched'});dispatched++;})(),rejectsCode('LEDGER_WRITE_FAILED',500));
  assert.equal(dispatched,0);
  assert.deepEqual(await ledger.get(id),original);
  ledger._save=save;
  assert.equal((await ledger.mark(id,{state:'dispatched'})).state,'dispatched');
});

test('first prepare write failure exposes no prepared result or native side effect',async t=>{
  const {root,dir,ledger}=await fixture(t),id=randomUUID(),body=payload();
  const save=ledger._save.bind(ledger);
  ledger._save=async record=>{
    await writeFile(dir,'block creation');
    try{return await save(record);}finally{await rm(dir);}
  };
  let dispatches=0;
  await assert.rejects((async()=>{await ledger.prepare(id,body);dispatches++;})(),rejectsCode('LEDGER_WRITE_FAILED',500));
  assert.equal(dispatches,0);
  assert.equal(await ledger.get(id),null);
  assert.deepEqual(await readdir(root),[]);
  ledger._save=save;
  assert.equal((await ledger.prepare(id,body)).existing,false);
});

test('corrupt records fail closed, and startup ignores abandoned temporary files',async t=>{
  const {dir,ledger}=await fixture(t),id=randomUUID();
  assert.deepEqual(await ledger.recover(),[]);
  await mkdir(dir,{mode:0o700});
  await writeFile(join(dir,'.abandoned.tmp'),'incomplete',{mode:0o600});
  assert.deepEqual(await ledger.recover(),[]);
  await writeFile(join(dir,id+'.json'),'not JSON',{mode:0o600});
  await assert.rejects(ledger.get(id),rejectsCode('LEDGER_CORRUPT',500));
  await assert.rejects(ledger.prepare(id,payload()),rejectsCode('LEDGER_CORRUPT',500));
  await assert.rejects(ledger.recover(),rejectsCode('LEDGER_CORRUPT',500));
  assert.equal(await readFile(join(dir,id+'.json'),'utf8'),'not JSON');
});
