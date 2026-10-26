import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadServices} from '../index.mjs';

const ID='11111111-1111-4111-8111-111111111111';
function harness(archiveResult,statusResults=[],unarchiveResult){
  const posts=[],gets=[];
  const receipt=(value,body)=>({...body,...value});
  const api={
    async get(path){
      gets.push(path);
      if(path==='/api/projects')return{projects:[{id:'p',roots:[{rootPath:'/actual'}]}]};
      if(path==='/api/organize')return{};
      if(path==='/api/threads')return{data:[{id:ID,cwd:'/actual',name:'任务',createdAt:1,updatedAt:2}]};
      if(path.startsWith('/api/thread/archive/status')){const value=statusResults.shift();if(value instanceof Error)throw value;if(!value)throw Error('no status fixture left');return receipt(value,Object.fromEntries(new URL(path,'http://fixture').searchParams));}
      if(path.startsWith('/api/history'))return{thread:{id:ID,cwd:'/actual'},turns:[]};
      throw Error('unexpected GET '+path);
    },
    async post(path,body){posts.push({path,body});if(path==='/api/thread/archive')return receipt(typeof archiveResult==='function'?await archiveResult(body):archiveResult,body);if(path==='/api/thread/unarchive')return receipt(typeof unarchiveResult==='function'?await unarchiveResult(body):unarchiveResult,body);throw Error('unexpected POST '+path);},
  };
  return{channels:createReadServices({api}),posts,gets};
}

test('archiveTask maps native archive result onto the task meta',async()=>{
  const {channels,posts}=harness({status:'archived',archived:true,verified:true,pending:false});
  const task=await channels['zcode-task'].archiveTask({taskId:ID,workspacePath:'/actual'});
  assert.equal(posts.length,1);assert.equal(posts[0].path,'/api/thread/archive');
  assert.match(posts[0].body.requestId,/^[A-Za-z0-9_-]{8,160}$/);
  assert.equal(task.taskId,ID);assert.equal(task.archived,true);
});
test('archiveTask polls a pending native verification to completion',async()=>{
  const {channels}=harness({status:'pending',pending:true,archived:false},[{status:'archived',archived:true,verified:true,pending:false}]);
  const task=await channels['zcode-task'].archiveTask({taskId:ID,workspacePath:'/actual'});
  assert.equal(task.archived,true);
});
test('archiveTask surfaces a blocked native state as a clear failure',async()=>{
  const {channels}=harness({status:'blocked',archived:false,pending:false,message:'会话正在运行，结束后再归档'});
  await assert.rejects(channels['zcode-task'].archiveTask({taskId:ID,workspacePath:'/actual'}),error=>error.message==='会话正在运行，结束后再归档'&&error.code==='CODEX_ARCHIVE_FAILED');
});
test('unarchiveTask maps native unarchive result onto the task meta',async()=>{
  const {channels,posts}=harness(null,[],{unarchived:true,verified:true,threadId:ID});
  const task=await channels['zcode-task'].unarchiveTask({taskId:ID,workspacePath:'/actual'});
  assert.equal(posts[0].path,'/api/thread/unarchive');assert.match(posts[0].body.requestId,/^[A-Za-z0-9_-]{8,160}$/);
  assert.equal(task.taskId,ID);assert.equal(task.archived,false);
});
test('unarchiveTask fails clearly when the native restore did not verify',async()=>{
  const {channels}=harness(null,[],{unarchived:false,error:'归档记录不存在'});
  await assert.rejects(channels['zcode-task'].unarchiveTask({taskId:ID,workspacePath:'/actual'}),error=>error.code==='CODEX_UNARCHIVE_FAILED');
});

const params={taskId:ID,workspacePath:'/actual'};
const archived={status:'archived',archived:true,verified:true,pending:false};

test('original flat UI params and detached RPC methods retain scope and return task metadata',async()=>{
  const {channels,posts}=harness(archived),archive=channels['zcode-task'].archiveTask;
  const task=await archive({...params,workspaceIdentity:'/actual'});
  assert.equal(task.taskId,ID);assert.equal(task.workspacePath,'/actual');assert.equal(task.archived,true);
  assert.deepEqual(Object.keys(posts[0].body).sort(),['requestId','threadId']);
});

test('duplicate concurrent archive clicks share a single native request',async()=>{
  let release;
  const barrier=new Promise(resolve=>{release=resolve;}),f=harness(async()=>{await barrier;return archived;});
  const first=f.channels['zcode-task'].archiveTask(params),second=f.channels['zcode-task'].archiveTask(params);
  release();assert.deepEqual(await first,await second);assert.equal(f.posts.length,1);
});

test('lost native reply is reconciled with the same request ID and no second POST',async()=>{
  const f=harness(async()=>{throw Object.assign(Error('lost response'),{outcomeUnknown:true});},[archived]);
  await assert.rejects(f.channels['zcode-task'].archiveTask(params),e=>e.code==='CODEX_ARCHIVE_PENDING'&&e.outcomeUnknown===true);
  const task=await f.channels['zcode-task'].archiveTask(params);
  assert.equal(task.archived,true);assert.equal(f.posts.length,1);
  const status=new URL(f.gets.find(p=>p.startsWith('/api/thread/archive/status')),'http://fixture');
  assert.equal(status.searchParams.get('requestId'),f.posts[0].body.requestId);
});

test('a failed status read preserves request identity for the next read-only reconciliation',async()=>{
  const f=harness({status:'pending',pending:true,archived:false},[Error('lost status'),archived]);
  await assert.rejects(f.channels['zcode-task'].archiveTask(params),e=>e.code==='CODEX_ARCHIVE_PENDING');
  assert.equal((await f.channels['zcode-task'].archiveTask(params)).archived,true);assert.equal(f.posts.length,1);
  const reads=f.gets.filter(p=>p.startsWith('/api/thread/archive/status'));assert.equal(reads.length,2);assert.equal(reads[0],reads[1]);
});

test('unverified, malformed, and mismatched archive receipts never claim saved success',async()=>{
  for(const value of [{...archived,verified:false},{...archived,verified:undefined},{...archived,threadId:'22222222-2222-4222-8222-222222222222'},{...archived,requestId:'other-request'},{ok:true}, {...archived,pending:true,status:'pending',requestId:'other-request'}]){
    const f=harness(value,[archived]);
    await assert.rejects(f.channels['zcode-task'].archiveTask(params),e=>e.code==='CODEX_ARCHIVE_PENDING');
    assert.equal((await f.channels['zcode-task'].archiveTask(params)).archived,true);assert.equal(f.posts.length,1);
  }
});

test('a definitely unsent archive can be explicitly retried, but a sent notArchived result is never resent',async()=>{
  let attempts=0;
  const f=harness(async()=>{if(++attempts===1)throw Object.assign(Error('busy'),{sent:false,code:'SESSION_BUSY'});return archived;});
  await assert.rejects(f.channels['zcode-task'].archiveTask(params),e=>e.code==='SESSION_BUSY');
  assert.equal((await f.channels['zcode-task'].archiveTask(params)).archived,true);assert.equal(f.posts.length,2);assert.notEqual(f.posts[0].body.requestId,f.posts[1].body.requestId);
  const terminal={status:'notArchived',archived:false,pending:false,sent:true,message:'工具未归档'},g=harness(terminal,[terminal]);
  for(let i=0;i<2;i++)await assert.rejects(g.channels['zcode-task'].archiveTask(params),e=>e.code==='CODEX_ARCHIVE_FAILED');
  assert.equal(g.posts.length,1);
});

test('archive and restore reject mismatched or remote scope before any native POST',async()=>{
  for(const method of ['archiveTask','unarchiveTask']){
    const f=harness(archived,[],{unarchived:true,verified:true});
    for(const patch of [{workspacePath:'/other'},{workspaceIdentity:'remote-identity'},{remoteSessionId:'remote'},{sourceServerId:'other'},{hostId:'other'},{workspacePath:4}]){
      await assert.rejects(f.channels['zcode-task'][method]({...params,...patch}));
    }
    assert.equal(f.posts.length,0);
  }
});

test('restore must verify the target and saved state; verified restore permits a new archive request',async()=>{
  for(const result of [{unarchived:true,verified:false},{unarchived:true,verified:true,threadId:'other'},{unarchived:true,verified:true,requestId:'other'}]){
    const f=harness(null,[],result);
    await assert.rejects(f.channels['zcode-task'].unarchiveTask(params),e=>e.code==='CODEX_UNARCHIVE_FAILED');
  }
  let attempts=0;
  const f=harness(async()=>{if(++attempts===1)throw Error('lost response');return archived;},[],{unarchived:true,verified:true});
  await assert.rejects(f.channels['zcode-task'].archiveTask(params),e=>e.code==='CODEX_ARCHIVE_PENDING');
  assert.equal((await f.channels['zcode-task'].unarchiveTask(params)).archived,false);
  assert.equal((await f.channels['zcode-task'].archiveTask(params)).archived,true);
  assert.deepEqual(f.posts.map(p=>p.path),['/api/thread/archive','/api/thread/unarchive','/api/thread/archive']);
  assert.notEqual(f.posts[0].body.requestId,f.posts[2].body.requestId);
});
