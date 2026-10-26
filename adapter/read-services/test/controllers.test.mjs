import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapReadControllers} from '../controllers.mjs';

const ID='11111111-1111-4111-8111-111111111111';
function harness(options){
  const task={taskId:ID,title:'真实任务',workspacePath:'/actual',createdAt:0,updatedAt:10,provider:'glm',executionBackend:'codex-app',pinned:false,archived:false};let writes=0;
  const channels={project:{async readTree(){return{projects:[{id:'p',roots:[{rootPath:'/actual'}]}],tasks:[structuredClone(task)]};}},'task-groups':{async read(){return{groups:[],members:[],order:[]};}},'zcode-task':{async getTaskMeta(p){assert.equal(p.taskId,ID);return task;},async listArchivedTasks(){return[];}}};
  return{...wrapReadControllers(channels,options),task,get writes(){return writes;}};
}
test('uses exact original projection for valid snapshots, ack and resync sequencing',async()=>{
  const w=harness(),frames=[],c=w.channels['window-controller'],listener=c.onDynamicControllerFrame()(frame=>frames.push(frame));
  try{
    const result=await c.subscribeControllerV4({topic:'controller/tasks-index'});assert.equal(result.ack.mode,'snapshot');assert.equal(frames.length,1);
    const frame=frames[0];assert.equal(frame.fromSeq,0);assert.equal(frame.topic,'controller/tasks-index');assert.equal(frame.payload.snapshot.protocolVersion,1);assert.equal(frame.payload.snapshot.logEpoch,frame.logEpoch);assert.equal(frame.payload.snapshot.tasks[0].meta.taskId,ID);
    w.task.updatedAt=20;await w.refresh();assert.equal(frames.at(-1).payload.kind,'deltas');assert.equal(frames.at(-1).payload.deltas[0].op,'task.upserted');
    await c.resyncControllerV4({subscriptionId:result.ack.subscriptionId});assert.equal(frames.at(-1).payload.kind,'snapshot');
    await c.unsubscribeControllerV4({subscriptionId:result.ack.subscriptionId});assert.equal(w.writes,0);
  }finally{listener.dispose();w.dispose();}
});
test('controller list respects original active/timeline/pinned scope contract and address wrapper',async()=>{
  const w=harness(),c=w.channels['window-controller'];
  try{
    w.task.pinned=true;const scope=[{workspacePath:'/actual'}];
    assert.equal((await c.listTaskList({kind:'active',workspaceScopes:scope})).total,1);
    assert.equal((await c.listTaskList({kind:'timeline',workspaceScopes:scope})).total,0);
    assert.equal((await c.listTaskList({kind:'pinned',workspaceScopes:scope})).total,1);
    assert.equal((await c.listTaskList({kind:'active',workspaceScopes:[{workspacePath:'/wrong'}]})).total,0);
    assert.equal((await c.getTaskMeta({address:{taskId:ID,workspacePath:'/actual'}})).taskId,ID);
  }finally{w.dispose();}
});
test('group admit only recognizes actual catalog tasks and creates no membership or group',async()=>{
  const w=harness();try{
    const r=await w.channels['task-groups'].admit({tasks:[{hostId:'local',taskId:ID,workspacePath:'/actual'}]});assert.equal(r.groupsCreated,0);assert.deepEqual(r.admittedTaskIds,[]);assert.deepEqual(r.alreadyKnownTaskIds,[ID]);
    await assert.rejects(w.channels['task-groups'].admit({tasks:[{hostId:'local',taskId:ID,workspacePath:'/wrong'}]}),/not found/);
  }finally{w.dispose();}
});
test('controller archive entry dispatches to verified native task methods and propagates failure',async()=>{
 const w=harness(),calls=[],c=w.channels['window-controller'],address={taskId:ID,workspacePath:'/actual'};
 w.channels['zcode-task'].archiveTask=async p=>{calls.push(p);return{...w.task,archived:true}};
 w.channels['zcode-task'].unarchiveTask=async()=>{throw Error('native verification pending')};
 try{assert.equal((await c.mutateTask({address,mutation:{kind:'archive',archived:true}})).archived,true);assert.deepEqual(calls,[address]);await assert.rejects(c.mutateTask({address,mutation:{kind:'archive',archived:false}}),/verification pending/);await assert.rejects(c.mutateTask({address:{...address,sourceServerId:'remote'},mutation:{kind:'archive',archived:true}}));await assert.rejects(c.mutateTask({address,mutation:{kind:'delete'}}));assert.equal(calls.length,1)}finally{w.dispose()}
});

test('native running state reaches task-list activity and clears on completion or disconnect',async()=>{
 const w=harness(),frames=[],c=w.channels['window-controller'];const listener=c.onDynamicControllerFrame()(f=>frames.push(f));
 try{
  w.task.status='running';await c.subscribeControllerV4({topic:'controller/tasks-index'});
  const row=frames[0].payload.snapshot.tasks[0];assert.equal(row.liveStatus,'running');assert.equal(row.activity.phase,'running');assert.equal(row.activity.lastActivityAt,w.task.updatedAt);
  const list=await c.listTaskList({kind:'active',workspaceScopes:[{workspacePath:'/actual'}]});assert.equal(list.items[0].activity.phase,'running');
  for(const status of ['completed','running',undefined,'running','error']){
   w.task.status=status;await w.refresh();const delta=frames.at(-1).payload.deltas.find(d=>d.op==='task.upserted');
   assert(delta);assert.equal(delta.task.liveStatus,status==='running'?'running':status==='completed'?'completed':status==='error'?'error':'idle');assert.equal(delta.task.activity?.phase,status==='running'?'running':undefined);
  }
  w.task.archived=true;w.task.status='running';await w.refresh();assert.equal(frames.at(-1).payload.deltas[0].task.activity,undefined);
 }finally{listener.dispose();w.dispose();}
});

test('live runtime overrides unloaded catalog and disappears when native execution ends',async()=>{
 let runtime={active:{[ID]:'native-turn'},uncertainDesktop:[]};const w=harness({api:{get:async path=>{assert.equal(path,'/api/status');return runtime;}}});
 try{
  const c=w.channels['window-controller'],params={kind:'active',workspaceScopes:[{workspacePath:'/actual'}]};
  assert.equal((await c.listTaskList(params)).items[0].activity.phase,'running');
  runtime={active:{},uncertainDesktop:[]};assert.equal((await c.listTaskList(params)).items[0].activity,undefined);
  runtime={active:{[ID]:'native-turn'},uncertainDesktop:[ID]};assert.equal((await c.listTaskList(params)).items[0].activity,undefined);
 }finally{w.dispose();}
});
