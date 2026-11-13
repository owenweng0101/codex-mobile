import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DesktopIntent,readDesktopOwners,readDesktopMetadata,normalizeDesktopTitle} from '../backend/lib/desktop-intent.mjs';

const code=expected=>error=>{assert.equal(error.code,expected);return true;};
const unknownDesktopFields={model:null,actualModel:null,permissionMode:null,title:null};
const reply=model=>`Set model to \`${model}\` for this session only`;
// Matches the observed SDK /model response. The synthetic assistant is an SDK
// echo only; persisted JSONL contains command records, never this assistant.
const syntheticModelEvent=(id,model)=>({
  type:'assistant',session_id:id,uuid:randomUUID(),
  local_command_source:`<local-command-stdout>${reply(model)}</local-command-stdout>`,
  local_command_run:{command:'model',args:model},
  message:{id:randomUUID(),type:'message',role:'assistant',model:'<synthetic>',
    content:[{type:'text',text:reply(model)}],stop_reason:'end_turn',stop_sequence:null,
    usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}},
});
const localRecords=(id,model)=>[
  {type:'user',sessionId:id,message:{content:`<command-name>/model</command-name>\n<command-args>${model}</command-args>`}},
  {type:'user',sessionId:id,message:{content:`<local-command-stdout>Set model to ${model}</local-command-stdout>`}},
];
async function fixture(t,overrides={}){
  const root=await mkdtemp(join(tmpdir(),'claude-desktop-intent-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const id=randomUUID(),model='test-model',desktopId='native-'+randomUUID();
  const f={root,id,model,desktopId,seedCount:0,openCount:0,live:[],meta:null,saved:null,exited:false};
  f.options={sessionId:id,cwd:root,model,permissionMode:'acceptEdits'};
  f.dependencies={stateDir:root,attachTimeoutMs:10,pollMs:1,seedTimeoutMs:100,
    readiness:async()=>({cli:'/mock/claude'}),getLaunch:async()=>({env:{},models:[{model}]}),buildEnv:()=>({}),
    readTranscript:async()=>f.saved,metadata:async()=>f.meta,liveSession:async()=>f.live,isPidAlive:pid=>pid===202||pid===101&&!f.exited,
    startTurn:async options=>{
      f.seedCount++;assert.equal(options.prompt,'/model '+model);assert.equal(options.sessionId,id);assert.equal(options.resume,undefined);
      const intent=JSON.parse(await readFile(join(root,'desktop-intents',id+'.json'),'utf8'));
      assert.equal(intent.phase,'create');assert.equal(intent.seedStarted,true,'intent must precede spawn');
      const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:null,signalCode:null});f.child=child;
      const events=(async function*(){f.saved={records:localRecords(id,model)};yield{type:'result',total_cost_usd:0,is_error:false,result:''};setTimeout(()=>{f.exited=true;child.exitCode=0;child.emit('exit',0,null);},2);})();
      return{child,events};
    },
    openSession:async sessionId=>{
      f.openCount++;assert.equal(sessionId,id);assert.equal(f.exited,true,'native import must wait for real child exit');
      const intent=JSON.parse(await readFile(join(root,'desktop-intents',id+'.json'),'utf8'));assert.equal(intent.phase,'importRequested');
      f.meta={sessionId:desktopId,cliSessionId:id};f.live=[{sessionId:id,hostSessionId:desktopId,pid:202,entrypoint:'claude-desktop-3p',status:'idle'}];
    },...overrides,
  };
  f.intent=new DesktopIntent(f.dependencies);f.record=async()=>JSON.parse(await readFile(join(root,'desktop-intents',id+'.json'),'utf8'));
  return f;
}

test('creates local-only bootstrap, waits for exit, imports and confirms mapped native owner',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.intent.create(f.options),{sessionId:f.id,desktopSessionId:f.desktopId,attached:true,canInterrupt:false,...unknownDesktopFields});
  assert.equal(f.seedCount,1);assert.equal(f.openCount,1);
  assert.equal((await f.record()).phase,'attached');
  assert.equal((await stat(join(f.root,'desktop-intents',f.id+'.json'))).mode&0o777,0o600);
  assert.equal((await stat(join(f.root,'desktop-intents'))).mode&0o777,0o700);
  assert.deepEqual(await readdir(join(f.root,'desktop-intents')),[f.id+'.json']);
  assert.deepEqual(await f.intent.readState(f.id),{desktopSessionId:f.desktopId,attached:true,running:false,status:'idle',canInterrupt:false,...unknownDesktopFields});
});

test('concurrent calls and a new instance reuse the same intent without reseeding',async t=>{
  const f=await fixture(t),other=new DesktopIntent(f.dependencies);
  const values=await Promise.all([f.intent.create(f.options),other.create(f.options),f.intent.create(f.options)]);
  assert.equal(values.length,3);assert.equal(f.seedCount,1);assert.equal(f.openCount,1);
  await assert.rejects(other.create({...f.options,model:'different'}),code('DESKTOP_INTENT_COLLISION'));
  assert.equal(f.seedCount,1);
});

test('process restart reclaims a dead lock but never removes a live process lock',async t=>{
  const f=await fixture(t),dir=join(f.root,'desktop-intents');await mkdir(dir);
  const path=join(dir,f.id+'.lock');
  await writeFile(path,JSON.stringify({pid:process.pid}));
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  assert.equal(f.seedCount,0);assert.equal(JSON.parse(await readFile(path,'utf8')).pid,process.pid);
  await writeFile(path,JSON.stringify({pid:2147483647}));
  assert.equal((await f.intent.create(f.options)).attached,true);assert.equal(f.seedCount,1);
  assert.deepEqual(await readdir(dir),[f.id+'.json']);
});

test('rejects arbitrary existing transcript or metadata before reserving an intent',async t=>{
  for(const kind of ['transcript','metadata']){
    const f=await fixture(t);if(kind==='transcript')f.saved={records:localRecords(f.id,f.model)};else f.meta={sessionId:f.desktopId,cliSessionId:f.id};
    await assert.rejects(f.intent.create(f.options),code('SESSION_ALREADY_EXISTS'));
    assert.equal(f.seedCount,0);assert.equal(f.openCount,0);
    assert.deepEqual(await readdir(join(f.root,'desktop-intents')),[]);
  }
});

test('model newline, command injection, wrong permissions and malformed id cannot reach seed',async t=>{
  const f=await fixture(t);
  for(const model of ['test-model\nuser text','test-model\r/model other','test\tmodel','test\u2028model','test\u2029model','test\0model',' model','model ','','/model x','model</command-args>'])await assert.rejects(f.intent.create({...f.options,model}),code('INVALID_MODEL'));
  await assert.rejects(f.intent.create({...f.options,permissionMode:'unsupported-mode'}),code('INVALID_PERMISSION_MODE'));
  await assert.rejects(f.intent.create({...f.options,sessionId:'../file'}),code('INVALID_SESSION_ID'));
  assert.equal(f.seedCount,0);
});

test('end of output does not release writer; attachment waits for exit event',async t=>{
  const f=await fixture(t,{seedTimeoutMs:1000});let release;
  f.intent.startTurn=async()=>{
    f.seedCount++;const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:null,signalCode:null});
    release=()=>{f.exited=true;child.exitCode=0;child.emit('exit',0,null);};
    f.saved={records:localRecords(f.id,f.model)};
    return{child,events:(async function*(){yield{type:'result',total_cost_usd:0};})()};
  };
  const result=f.intent.create(f.options);
  while(!release)await new Promise(r=>setTimeout(r,1));
  const deadline=Date.now()+800;
  while((await f.record()).phase!=='persisted'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,2));
  assert.equal(f.openCount,0);
  assert.equal((await f.record()).phase,'persisted');release();await result;assert.equal(f.openCount,1);
});

test('timeout preserves same id and retry imports again without spawning a new seed',async t=>{
  const f=await fixture(t);f.intent.openSession=async()=>{f.openCount++;};
  await assert.rejects(f.intent.create(f.options),e=>{assert.equal(e.pendingDesktop,true);assert.equal(e.sessionId,f.id);assert.equal(e.recoverable,true);return e.code==='DESKTOP_PENDING';});
  assert.equal((await f.record()).phase,'importRequested');
  const retry=new DesktopIntent(f.dependencies);await retry.create(f.options);
  assert.equal(f.seedCount,1);assert.equal(f.openCount,2);
});

test('uncertain spawn never replays seed, even when no transcript was returned',async t=>{
  const f=await fixture(t);f.intent.startTurn=async()=>{f.seedCount++;throw Error('spawn uncertain');};
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  const next=new DesktopIntent(f.dependencies);
  await assert.rejects(next.create(f.options),code('DESKTOP_PENDING'));
  assert.equal(f.seedCount,1);assert.equal(f.openCount,0);
});

test('persisted seed is reusable only after its actual pid is gone; retry never seeds again',async t=>{
  const f=await fixture(t,{seedTimeoutMs:10});f.intent.startTurn=async()=>{
    f.seedCount++;f.saved={records:localRecords(f.id,f.model)};
    const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:null,signalCode:null});
    return{child,events:(async function*(){yield{type:'result',total_cost_usd:0};})()};
  };
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  assert.equal((await f.record()).phase,'persisted');
  await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('DESKTOP_PENDING'));
  assert.equal(f.openCount,0);f.exited=true;
  assert.equal((await new DesktopIntent(f.dependencies).create(f.options)).attached,true);
  assert.equal(f.seedCount,1);
});

test('changed or missing seed transcript on recovery cannot be imported',async t=>{
  for(const missing of [true,false]){
    const f=await fixture(t,{seedTimeoutMs:10});f.intent.startTurn=async()=>{
      f.seedCount++;f.saved={records:localRecords(f.id,f.model)};
      const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:null,signalCode:null});
      return{child,events:(async function*(){yield{type:'result',total_cost_usd:0};})()};
    };
    await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
    f.exited=true;f.saved=missing?null:{records:[...localRecords(f.id,f.model),{type:'assistant',message:{content:'unexpected answer'}}]};
    await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('SEED_REJECTED'));
    assert.equal(f.seedCount,1);assert.equal(f.openCount,0);
  }
});

test('rejects cost, tools, assistant answers, error results and missing local marker without importing',async t=>{
  for(const variant of ['cost','tool','assistant','answer','error','marker','missing-result','wrong-session','wrong-transcript']){
    const f=await fixture(t);f.intent.startTurn=async()=>{
      f.seedCount++;f.saved={records:variant==='marker'?[{type:'user',message:{content:'ordinary prompt'}}]:localRecords(variant==='wrong-transcript'?randomUUID():f.id,f.model)};
      const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:0,signalCode:null});f.exited=true;
      const events=[];
      if(variant==='tool')events.push({type:'tool_use',name:'Read'});
      if(variant==='assistant')events.push({type:'assistant',message:{content:[{type:'text',text:'answer'}]}});
      if(variant!=='missing-result')events.push({type:'result',total_cost_usd:variant==='cost'?0.01:0,is_error:variant==='error',...(variant==='answer'?{result:'ordinary model answer'}:{}),...(variant==='wrong-session'?{session_id:randomUUID()}:{})});
      return{child,events:(async function*(){yield* events;})()};
    };
    await assert.rejects(f.intent.create(f.options),code('SEED_REJECTED'));
    await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('SEED_REJECTED'));
    assert.equal(f.seedCount,1);assert.equal(f.openCount,0);
  }
});

test('abnormal or unconfirmed child exit cannot lead to desktop import',async t=>{
  for(const exitCode of [1,null]){
    const f=await fixture(t,{seedTimeoutMs:10});f.intent.startTurn=async()=>{
      f.saved={records:localRecords(f.id,f.model)};
      const child=new EventEmitter();Object.assign(child,{pid:101,exitCode,signalCode:null});
      return{child,events:(async function*(){yield{type:'result',total_cost_usd:0};})()};
    };
    await assert.rejects(f.intent.create(f.options),code(exitCode===null?'DESKTOP_PENDING':'SEED_REJECTED'));assert.equal(f.openCount,0);
  }
});

test('attach refuses foreign live CLI writer and never seeds or forks',async t=>{
  const f=await fixture(t);f.live=[{sessionId:f.id,pid:202,entrypoint:'cli',status:'busy'}];
  await assert.rejects(f.intent.attach(f.id),code('CLI_WRITER_ACTIVE'));
  assert.equal(f.seedCount,0);assert.equal(f.openCount,0);
});

test('attach existing session uses native metadata identity rather than local_ concatenation',async t=>{
  const f=await fixture(t);f.exited=true;
  // attach has no creation intent; the injection must not require one.
  f.intent.openSession=async()=>{f.openCount++;f.meta={cliSessionId:f.id,sessionId:f.desktopId};f.live=[{sessionId:f.id,hostSessionId:f.desktopId,pid:202,entrypoint:'claude-desktop',status:'busy'}];};
  assert.deepEqual(await f.intent.attach(f.id),{sessionId:f.id,desktopSessionId:f.desktopId,attached:true,canInterrupt:false,...unknownDesktopFields});
  assert.equal(f.seedCount,0);assert.deepEqual(await readdir(join(f.root,'desktop-intents')),[]);
  assert.deepEqual(await f.intent.readState(f.id),{desktopSessionId:f.desktopId,attached:true,running:true,status:'busy',canInterrupt:false,...unknownDesktopFields});
});

test('dead pid, incorrect hostSessionId and wrong entrypoint cannot prove attachment',async t=>{
  const f=await fixture(t);f.meta={cliSessionId:f.id,sessionId:f.desktopId};
  for(const patch of [{pid:999},{hostSessionId:'local_'+f.id},{entrypoint:'cli'}]){
    f.live=[{sessionId:f.id,hostSessionId:f.desktopId,pid:202,entrypoint:'claude-desktop',status:'busy',...patch}];
    const state=await f.intent.readState(f.id);assert.equal(state.attached,false);assert.equal(state.canInterrupt,false);
  }
});

test('default readers map nested profile metadata and strip credential fields from owners',async t=>{
  const f=await fixture(t),meta=join(f.root,'Claude-3p','account','org'),registry=join(f.root,'registry');await mkdir(meta,{recursive:true});await mkdir(registry);
  await writeFile(join(meta,'opaque-desktop.json'),JSON.stringify({cliSessionId:f.id,sessionId:f.desktopId,cwd:f.root,model:'desktop-default',permissionMode:'acceptEdits',title:'真实桌面标题',token:'metadata-secret'}));
  await writeFile(join(registry,'202.json'),JSON.stringify({sessionId:f.id,hostSessionId:f.desktopId,pid:202,entrypoint:'claude-desktop-3p',status:'idle',token:'private-sentinel'}));
  await writeFile(join(registry,'202.key'),'not read');
  const metadata=await readDesktopMetadata(f.id,{directories:[join(f.root,'Claude-3p'),join(f.root,'missing-Claude')]});
  assert.equal(metadata.sessionId,f.desktopId);
  assert.equal(metadata.model,'desktop-default');assert.equal(metadata.actualModel,'desktop-default');
  assert.equal(metadata.permissionMode,'acceptEdits');assert.equal(metadata.title,'真实桌面标题');assert.equal('token'in metadata,false);
  const owners=await readDesktopOwners(f.id,{directory:registry});assert.equal(owners.length,1);assert.equal('token'in owners[0],false);
  const intent=new DesktopIntent({...f.dependencies,metadata:id=>readDesktopMetadata(id,{directories:[join(f.root,'Claude-3p')]}),liveSession:id=>readDesktopOwners(id,{directory:registry})});
  const state=await intent.readState(f.id);assert.equal(state.attached,true);
  assert.equal(state.model,'desktop-default');assert.equal(state.permissionMode,'acceptEdits');assert.equal(state.title,'真实桌面标题');
});

test('realistic /model synthetic SDK fixtures support [1m] and catalog names with spaces',async t=>{
  for(const model of ['jd2/DeepSeek-V4.1-Flash-a[1m]','jd/DeepSeek-V4.1-Flash-A-joybuilder[1m]','JoyCode DeepSeek V4.1 Flash [1m]']){
    const f=await fixture(t);f.options.model=model;
    f.intent.startTurn=async options=>{
      f.seedCount++;assert.equal(options.model,model);assert.equal(options.prompt,'/model '+model);
      f.saved={raw:localRecords(f.id,model).map(record=>JSON.stringify(record)).join('\n')+'\n'};
      const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:0,signalCode:null});f.exited=true;
      return{child,events:(async function*(){
        yield syntheticModelEvent(f.id,model);
        yield{type:'result',subtype:'success',session_id:f.id,is_error:false,total_cost_usd:0,result:reply(model),
          usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0},modelUsage:{},num_turns:0};
      })()};
    };
    const result=await f.intent.create(f.options);
    assert.equal(result.attached,true);assert.equal(f.seedCount,1);assert.equal(f.openCount,1);
    assert.equal(result.model,null,'unknown native model must not fall back to requested seed model');
    assert.equal(result.actualModel,null);assert.equal(result.canInterrupt,false);
  }
});

test('synthetic allowlist requires every observed local-command fact and still rejects real assistants',async t=>{
  const changes=[
    event=>{event.message.model='real-model';},
    event=>{event.message.usage.input_tokens=1;},
    event=>{event.message.usage.cache_read_input_tokens=1;},
    event=>{delete event.message.usage.output_tokens;},
    event=>{event.message.usage.server_tool_use={web_search_requests:1};},
    event=>{event.local_command_run.args='another-model';},
    event=>{event.local_command_run.command='other-command';},
    event=>{delete event.local_command_run;},
    event=>{event.local_command_source='ordinary answer';},
    event=>{event.message.content.push({type:'tool_use',id:'tool',name:'Read',input:{}});},
    event=>{event.message.content=[{type:'text',text:'ordinary answer'}];},
    event=>{event.message.stop_reason='tool_use';},
    event=>{event.total_cost_usd=0.01;},
    event=>{event.session_id=randomUUID();},
  ];
  for(const change of changes){
    const f=await fixture(t);f.intent.startTurn=async()=>{
      f.seedCount++;f.saved={records:localRecords(f.id,f.model)};
      const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:0,signalCode:null});f.exited=true;
      const event=syntheticModelEvent(f.id,f.model);change(event);
      return{child,events:(async function*(){yield event;yield{type:'result',total_cost_usd:0,result:reply(f.model)};})()};
    };
    // A custom marker checker cannot disable the synthetic/cost/tool guard.
    f.intent.checkLocalModelMarker=()=>true;
    await assert.rejects(f.intent.create(f.options),code('SEED_REJECTED'));
    assert.equal(f.openCount,0);
  }
});

test('even an otherwise valid synthetic assistant is forbidden in durable JSONL',async t=>{
  const f=await fixture(t);f.intent.startTurn=async()=>{
    f.saved={records:[...localRecords(f.id,f.model),syntheticModelEvent(f.id,f.model)]};
    const child=new EventEmitter();Object.assign(child,{pid:101,exitCode:0,signalCode:null});f.exited=true;
    return{child,events:(async function*(){yield syntheticModelEvent(f.id,f.model);yield{type:'result',total_cost_usd:0,result:reply(f.model)};})()};
  };
  await assert.rejects(f.intent.create(f.options),code('SEED_REJECTED'));assert.equal(f.openCount,0);
});

test('import result and later state expose actual native model, never seed model or interrupt capability',async t=>{
  const f=await fixture(t),openSession=f.intent.openSession;
  f.intent.openSession=async id=>{await openSession(id);Object.assign(f.meta,{model:'desktop-default',permissionMode:'bypassPermissions',title:'桌面实际会话'});f.live[0].status='busy';};
  const result=await f.intent.create(f.options);
  assert.equal(result.model,'desktop-default');assert.equal(result.actualModel,'desktop-default');
  assert.equal(result.permissionMode,'bypassPermissions');assert.equal(result.title,'桌面实际会话');assert.equal(result.canInterrupt,false);
  let state=await f.intent.readState(f.id);assert.equal(state.running,true);assert.equal(state.canInterrupt,false);
  assert.equal(state.model,'desktop-default');assert.equal(state.actualModel,'desktop-default');
  assert.equal(state.permissionMode,'bypassPermissions');assert.equal(state.title,'桌面实际会话');
  f.meta.model='desktop-changed';state=await f.intent.readState(f.id);assert.equal(state.model,'desktop-changed');assert.equal(state.actualModel,'desktop-changed');
  const replay=await new DesktopIntent(f.dependencies).create(f.options);assert.equal(replay.model,'desktop-changed');assert.equal(f.seedCount,1);
  f.meta={cliSessionId:randomUUID(),sessionId:f.desktopId,model:'wrong-session-model',title:'wrong-session-title'};
  state=await f.intent.readState(f.id);assert.equal(state.model,null);assert.equal(state.title,null);assert.equal(state.attached,false);
});

// Title-only extension: the original /model fixtures above are unchanged.
// Matches the verified native /rename output and its actual JSONL order:
// custom-title precedes the caveat/command records, with no durable assistant.
const renameText=title=>`Session renamed to: ${title}`;
const renameEvent=(id,title)=>({
  ...syntheticModelEvent(id,title),local_command_run:{command:'rename',args:title},
  local_command_source:`<local-command-stdout>${renameText(title)}</local-command-stdout>`,
  message:{...syntheticModelEvent(id,title).message,content:[{type:'text',text:renameText(title)}]},
});
async function titleFixture(t,title='手机验收标题'){
  const f=await fixture(t),modelStart=f.intent.startTurn,modelAlive=f.intent.isPidAlive,importNative=f.intent.openSession;
  f.options.title=title;f.renameCount=0;f.renameExited=false;
  f.intent.isPidAlive=pid=>pid===303?!f.renameExited:modelAlive(pid);
  f.intent.startTurn=async options=>{
    if(!options.resume)return modelStart(options);
    f.renameCount++;assert.equal(options.resume,f.id);assert.equal(options.sessionId,undefined);
    const expected=normalizeDesktopTitle(f.options.title);
    assert.equal(options.prompt,'/rename '+expected);assert.equal(/[\r\n\0]/.test(options.prompt),false);
    const record=await f.record();assert.equal(record.phase,'renaming');assert.equal(record.titleStarted,true);assert.equal(record.title,expected);
    assert.equal(f.exited,true,'/model writer must release before /rename');assert.equal(f.live.length,0);
    if(f.spawnUncertain)throw Error('rename spawn uncertain');
    const child=new EventEmitter();Object.assign(child,{pid:303,exitCode:null,signalCode:null});f.renameChild=child;
    const events=(async function*(){
      const records=[...f.saved.records,
        {type:'custom-title',customTitle:expected,sessionId:f.id},
        {type:'user',sessionId:f.id,isMeta:true,message:{content:'<local-command-caveat>This command was run directly, not sent as a request.</local-command-caveat>'}},
        {type:'user',sessionId:f.id,message:{content:`<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>${expected}</command-args>`}},
        {type:'cost-state',sessionId:f.id,totalCostUSD:0,totalAPIDuration:0,totalToolDuration:0,modelUsage:{}}];
      const output=[renameEvent(f.id,expected),{type:'result',subtype:'success',session_id:f.id,is_error:false,total_cost_usd:0,result:renameText(expected),num_turns:0,
        usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0},modelUsage:{}}];
      f.mutateRename?.({records,events:output});f.saved={records};
      yield* output;
      if(!f.holdRename)setTimeout(()=>{f.renameExited=true;child.exitCode=f.renameExitCode??0;child.emit('exit',child.exitCode,null);},2);
    })();return {child,events};
  };
  f.intent.openSession=async id=>{
    assert.equal(f.renameExited,true,'native import must wait for /rename writer release');
    const record=await f.record();assert.equal(record.titleValidated,true);
    await importNative(id);f.meta.title=normalizeDesktopTitle(f.options.title);
  };
  f.dependencies={...f.dependencies,startTurn:f.intent.startTurn,isPidAlive:f.intent.isPidAlive,openSession:f.intent.openSession};
  return f;
}

test('native title follows /model exit -> literal resumed /rename -> exit -> import with official custom-title',async t=>{
  const f=await titleFixture(t,' 手机\n验收\t标题\0 ');
  const result=await f.intent.create(f.options);
  assert.equal(result.title,'手机 验收 标题');assert.equal(result.attached,true);
  assert.equal(f.seedCount,1);assert.equal(f.renameCount,1);assert.equal(f.openCount,1);
  const record=await f.record();assert.equal(record.title,'手机 验收 标题');assert.equal(record.titleValidated,true);assert.deepEqual(record.titleExit,{code:0,signal:null});
  assert.equal(record.phase,'attached');assert.equal((await stat(join(f.root,'desktop-intents',f.id+'.json'))).mode&0o777,0o600);
  await new DesktopIntent(f.dependencies).create(f.options);assert.equal(f.renameCount,1);assert.equal(f.seedCount,1);
});
test('title normalization is single line and caps Unicode code points without splitting surrogate pairs',()=>{
  assert.equal(normalizeDesktopTitle(' a\r\nb\u0000c\u200bd\u2028e '),'a b c d e');
  assert.equal(Array.from(normalizeDesktopTitle('😀'.repeat(80))).length,72);
  assert.equal(normalizeDesktopTitle('😀'.repeat(80)),'😀'.repeat(72));
  assert.equal(normalizeDesktopTitle(undefined),'');assert.equal(normalizeDesktopTitle(' \n\0 '),'');
  assert.throws(()=>normalizeDesktopTitle({}),code('INVALID_TITLE'));
});
test('title is one literal /rename argument; shell and slash text never becomes a user task',async t=>{
  const title='title /model other $(echo nope) `literal` <tag> & text',f=await titleFixture(t,title);
  assert.equal((await f.intent.create(f.options)).title,title);assert.equal(f.renameCount,1);
});
test('normalized title participates in same-ID collisions; whitespace equivalent requests reuse intent',async t=>{
  const f=await titleFixture(t,'Title\n one');await f.intent.create(f.options);
  await new DesktopIntent(f.dependencies).create({...f.options,title:'  Title   one '});
  await assert.rejects(f.intent.create({...f.options,title:'Title two'}),code('DESKTOP_INTENT_COLLISION'));
  assert.equal(f.seedCount,1);assert.equal(f.renameCount,1);
});
test('legacy intent without title accepts old fingerprint and skips rename even if caller supplies a title',async t=>{
  const f=await fixture(t);await f.intent.create(f.options);
  const record=await f.record();delete record.title;
  record.fingerprint=createHash('sha256').update(JSON.stringify({cwd:await realpath(f.root),model:f.model,permissionMode:f.options.permissionMode})).digest('hex');
  await f.intent.save(record);
  const result=await new DesktopIntent(f.dependencies).create({...f.options,title:'new caller title'});
  assert.equal(result.attached,true);assert.equal(result.title,null);assert.equal(f.seedCount,1);assert.equal(f.openCount,1);
  assert.equal(Object.hasOwn(await f.record(),'title'),false);
});
test('empty normalized title keeps original model-only path',async t=>{
  const f=await fixture(t);await f.intent.create({...f.options,title:'\n\0\t'});
  assert.equal(f.seedCount,1);assert.equal(f.openCount,1);assert.equal((await f.record()).title,'');
});
test('completed rename survives failed import/restart without rerunning either CLI command',async t=>{
  const f=await titleFixture(t);f.intent.openSession=async()=>{f.openCount++;};
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  assert.equal((await f.record()).phase,'importRequested');
  assert.equal((await new DesktopIntent(f.dependencies).create(f.options)).title,'手机验收标题');
  assert.equal(f.seedCount,1);assert.equal(f.renameCount,1);assert.equal(f.openCount,2);
});
test('uncertain rename spawn preserves UUID and never repeats /rename',async t=>{
  const f=await titleFixture(t);f.spawnUncertain=true;
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('DESKTOP_PENDING'));
  assert.equal((await f.record()).phase,'renaming');assert.equal(f.seedCount,1);assert.equal(f.renameCount,1);assert.equal(f.openCount,0);
});
test('titlePersisted waits for actual writer exit; recovery only releases a positively dead PID',async t=>{
  const f=await titleFixture(t);f.holdRename=true;f.intent.seedTimeoutMs=15;
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  assert.equal((await f.record()).phase,'titlePersisted');assert.equal(f.openCount,0);
  await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('DESKTOP_PENDING'));
  f.renameExited=true;
  assert.equal((await new DesktopIntent(f.dependencies).create(f.options)).attached,true);
  assert.equal(f.renameCount,1);assert.equal((await f.record()).titleReleaseEvidence,'pid-gone-after-restart');
});
test('native owner appearing after bootstrap prevents an independent /rename CLI',async t=>{
  const f=await titleFixture(t);f.intent.liveSession=async()=>f.exited?[{sessionId:f.id,hostSessionId:f.desktopId,pid:202,entrypoint:'claude-desktop-3p'}]:[];
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  assert.equal(f.seedCount,1);assert.equal(f.renameCount,0);assert.equal(f.openCount,0);
});
test('rename rejects any real assistant, usage/cost, tool, wrong UUID, altered marker or non-exact custom-title',async t=>{
  const changes=[
    ({events})=>{events[0].message.model='real-model';},
    ({events})=>{events[0].message.usage.output_tokens=1;},
    ({events})=>{events[0].local_command_run.command='model';},
    ({events})=>{events[0].local_command_run.args='different';},
    ({events})=>{events[0].local_command_source='ordinary output';},
    ({events})=>{events[0].message.content=[{type:'text',text:'ordinary answer'}];},
    ({events})=>{events[0].message.content.push({type:'tool_use',name:'Read'});},
    ({events})=>{events[0].session_id=randomUUID();},
    ({events})=>{events[1].total_cost_usd=0.01;},
    ({events})=>{events[1].usage.input_tokens=1;},
    ({events})=>{events[1].result='ordinary answer';},
    ({events})=>{events.splice(0,1);},
    ({records})=>{records.find(v=>v.type==='custom-title').customTitle='different';},
    ({records})=>{records.find(v=>v.type==='custom-title').sessionId=randomUUID();},
    ({records})=>{records.splice(records.findIndex(v=>v.type==='custom-title'),1);},
    ({records})=>{records.find(v=>v.type==='cost-state').totalCostUSD=0.01;},
    ({records})=>{records.find(v=>v.type==='cost-state').totalToolDuration=1;},
    ({records})=>{records.push({type:'assistant',message:{model:'real',content:'answer'}});},
    ({records})=>{records.push({type:'tool_use',name:'Read'});},
  ];
  for(const change of changes){const f=await titleFixture(t);f.mutateRename=change;
    await assert.rejects(f.intent.create(f.options),code('SEED_REJECTED'));
    await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('SEED_REJECTED'));
    assert.equal(f.renameCount,1);assert.equal(f.openCount,0);
  }
});
test('import retry revalidates official custom-title before opening the native session',async t=>{
  const f=await titleFixture(t);f.intent.openSession=async()=>{f.openCount++;};
  await assert.rejects(f.intent.create(f.options),code('DESKTOP_PENDING'));
  f.saved.records.find(v=>v.type==='custom-title').customTitle='changed after validated';
  await assert.rejects(new DesktopIntent(f.dependencies).create(f.options),code('SEED_REJECTED'));
  assert.equal(f.renameCount,1);assert.equal(f.openCount,1);
});
test('abnormal title writer exit prevents import even when stdout/custom-title were valid',async t=>{
  const f=await titleFixture(t);f.renameExitCode=1;
  await assert.rejects(f.intent.create(f.options),code('SEED_REJECTED'));assert.equal(f.openCount,0);
});
