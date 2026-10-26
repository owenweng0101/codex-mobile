import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadServices,projectMessages,projectTask} from '../index.mjs';

const ID='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',THIRD='33333333-3333-4333-8333-333333333333';
const thread={id:ID,name:'真实中文任务',cwd:'/workspace/main',projectId:'project-1',updatedAt:1792900000,status:{type:'notLoaded'},model:'gpt-test'};
function harness(overrides={}){
  const calls=[];
  const defaults={
    '/api/projects':{projects:[{id:'project-1',name:'双根项目',roots:['/workspace/main','/workspace/second']}]},
    '/api/organize':{pins:[ID],unread:[ID],groups:[{id:'group-1',name:'我的分组',color:'#123456'}],assignments:{[ID]:'group-1'}},
    '/api/threads':{data:[thread],nextCursor:null},
    ['/api/history?threadId='+ID]:{thread,turns:[{id:'turn-1',status:'completed',startedAt:1792900000,items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'问题'}]},{id:'a1',type:'agentMessage',text:'回复'}]}],nextCursor:null,approvals:[]},
  };
  const api={async get(path){calls.push(path);const value=Object.hasOwn(overrides,path)?overrides[path]:defaults[path];if(value===undefined)throw Error('Unexpected GET '+path);return structuredClone(typeof value==='function'?value():value);}};
  return{channels:createReadServices({api,cacheMs:10000}),calls,api};
}

test('original project tree shape retains real multi-root/task identities and unknown engine status',async()=>{
  const {channels}=harness(),tree=await channels.project.readTree();
  assert.equal(tree.projects[0].id,'project-1');assert.equal(tree.projects[0].hostId,'local');
  assert.deepEqual(tree.projects[0].roots,[{rootPath:'/workspace/main',position:0,isPrimary:true},{rootPath:'/workspace/second',position:1,isPrimary:false}]);
  assert.equal(tree.tasks[0].taskId,ID);assert.equal(tree.tasks[0].workspacePath,thread.cwd);assert.equal(tree.tasks[0].status,undefined);
  assert.equal(tree.tasks[0].codexConnectionStatus,'notLoaded');assert.equal(tree.tasks[0].provider,'glm');assert.equal(tree.tasks[0].executionBackend,'codex-app');assert.equal(tree.tasks[0].pinned,true);assert.equal(tree.tasks[0].unreadAt,1792900000000);
});
test('catalog follows backend cursors and deduplicates repeated metadata',async()=>{
  const {channels,calls}=harness({'/api/threads':{data:[thread],nextCursor:'50'},'/api/threads?cursor=50':{data:[thread,{...thread,id:OTHER,cwd:'/workspace/second'},{...thread,id:THIRD}],nextCursor:null}});
  const tree=await channels.project.readTree();assert.equal(tree.tasks.length,3);assert(calls.includes('/api/threads?cursor=50'));
  const scopes=[{workspacePath:'/workspace/main'},{workspacePath:'/workspace/second'}];
  assert.deepEqual((await channels['zcode-task'].listTaskList({kind:'pinned',workspaceScopes:scopes})).items.map(v=>v.taskId),[ID]);
  const first=await channels['zcode-task'].listTaskList({kind:'active',workspaceScopes:scopes,limit:1});assert.equal(first.total,2);assert.equal(first.hasMore,true);assert.equal(first.items[0].taskId,OTHER);
  const next=await channels['zcode-task'].listTaskList({kind:'active',workspaceScopes:scopes,offset:1,limit:1});assert.equal(next.total,2);assert.equal(next.hasMore,false);assert.equal(next.items[0].taskId,THIRD);
  assert.equal((await channels['zcode-task'].listTaskList({workspaceScopes:[]})).total,0);
});
test('truncated/stalled catalog cannot masquerade as the complete tree',async()=>{
  await assert.rejects(harness({'/api/projects':{projects:[],truncated:true}}).channels.project.readTree(),e=>e.code==='CODEX_CATALOG_TRUNCATED');
  await assert.rejects(harness({'/api/threads':{data:[thread],nextCursor:'50'},'/api/threads?cursor=50':{data:[],nextCursor:'50'}}).channels.project.readTree(),/游标未前进/);
});
test('cross-host and wrong-workspace snapshot are rejected',async()=>{
  const {channels}=harness();await assert.rejects(channels.project.readTree({hostId:'another-host'}),e=>e.code==='CODEX_HOST_UNAVAILABLE');
  await assert.rejects(channels['zcode-task'].getTaskSnapshot({taskId:ID,workspacePath:'/elsewhere'}),e=>e.code==='CODEX_WORKSPACE_MISMATCH');
  await assert.rejects(channels['zcode-task'].getTaskSnapshot({taskId:'../../secret'}),e=>e.code==='CODEX_INVALID_TASK_ID');
});
test('tool/history projection preserves ordering and original renderer parts without raw event JSON',()=>{
  const result=projectMessages([{id:'t',status:'completed',startedAt:1,items:[
    {id:'u',type:'userMessage',content:[{type:'text',text:'中文需求'},{type:'image',url:'/private/not-published'}]},
    {id:'reason',type:'reasoning',summary:['思考摘要']},
    {id:'cmd',type:'commandExecution',status:'completed',command:'pwd',aggregatedOutput:'/workspace/main',exitCode:0},
    {id:'answer',type:'agentMessage',text:'最终答复'},
  ]}]);
  assert.equal(result.length,2);assert.equal(result[0].content,'中文需求\n[图片]');assert.equal(result[1].content,'最终答复');
  assert.equal(result[1].thought,'思考摘要');assert.equal(result[1].tools[0].raw.toolCallId,'cmd');
  assert.deepEqual(result[1].parts.map(x=>x.type),['thought','tool-call','content']);
  assert(!JSON.stringify(result).includes('/private/not-published'));
});
test('original snapshot + ETag use real history; last completed turn is actual completion evidence',async()=>{
  const {channels}=harness(),task=channels['zcode-task'];
  const first=await task.getTaskSnapshotWithEtag({taskId:ID,workspacePath:'/workspace/main'});
  assert.equal(first.snapshot.meta.status,'completed');assert.equal(first.snapshot.messages[1].content,'回复');assert.equal(first.snapshot.runtime.readOnly,true);
  for(const unknown of ['pendingPermissions','pendingCommands','backgroundBashJobs','contextUsage','activeTurnKind'])assert(!Object.hasOwn(first.snapshot.runtime,unknown));
  const second=await task.getTaskSnapshotWithEtag({taskId:ID,ifNoneMatch:first.etag});assert.equal(second.notModified,true);assert.equal(second.snapshot,null);
});
test('around older pages merge in chronological order and message limit does not invent all-history totals',async()=>{
  const current={thread,turns:[{id:'new',status:'completed',items:[{id:'newU',type:'userMessage',content:[{type:'text',text:'新问题'}]}]}],nextCursor:'older:1'};
  const older={thread,turns:[{id:'old',status:'completed',items:[{id:'oldU',type:'userMessage',content:[{type:'text',text:'旧问题'}]}]}],nextCursor:'older:2'};
  const {channels,calls}=harness({['/api/history?threadId='+ID]:current,['/api/history?threadId='+ID+'&cursor=older%3A1']:older});
  const snapshot=await channels['zcode-task'].getTaskSnapshot({taskId:ID,messageLimit:2});
  assert.deepEqual(snapshot.messages.map(v=>v.content),['旧问题','新问题']);assert.equal(snapshot.history.truncatedBefore,true);assert.equal(snapshot.history.totalMessagesKnown,false);assert(!('totalMessages'in snapshot.history));
  assert.equal(calls.filter(p=>p.startsWith('/api/history')).length,2);
});
test('original group structure contains real membership and remote directory is a valid empty local-only shape',async()=>{
  const {channels}=harness(),groups=await channels['task-groups'].read();assert.deepEqual(groups.groups,[{id:'group-1',title:'我的分组',color:'#123456'}]);
  assert.deepEqual(groups.members,[{workspaceKey:'/workspace/main',taskId:ID,groupId:'group-1'}]);
  assert.deepEqual(await channels['remote-projects'].readDirectory(),{hosts:[],entries:[]});
});
test('unimplemented mutation/event routes explicitly fail and never send a backend write',async()=>{
  const {channels,calls}=harness();
  assert.throws(()=>channels['zcode-task'].sendPrompt({taskId:ID,text:'must not be sent'}),e=>e.code==='CODEX_READ_ONLY_METHOD_UNAVAILABLE');
  assert.throws(()=>channels.project.saveProject({name:'must not write'}),e=>e.code==='CODEX_READ_ONLY_METHOD_UNAVAILABLE');
  assert.deepEqual(calls,[]);
});
test('unloaded and idle metadata never becomes completed without history evidence',()=>{
  assert.equal(projectTask({...thread,status:{type:'idle'}}).status,undefined);
  assert.equal(projectTask({...thread,status:{type:'active'}}).status,'running');
  assert.equal(projectTask(thread,{lastTurn:{status:'interrupted'}}).status,'stopped');
});
