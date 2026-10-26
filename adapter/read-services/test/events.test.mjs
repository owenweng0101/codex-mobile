import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {wrapReadEvents} from '../events.mjs';

const ID='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const page=(sequence,events=[],epoch='epoch-1',reset=false)=>({sequence,events,epoch,reset});
const event=(id,method,threadId=ID,extra={})=>({id,method,params:{threadId,...extra}});
function harness(pages){const calls=[];let index=0;const api={async get(path){calls.push(path);if(path.startsWith('/api/events?'))return pages[index++];if(path.startsWith('/api/threads?ids='))return{data:[{id:ID,cwd:'/actual'},{id:OTHER,cwd:'/other'}]};throw Error('Unexpected GET '+path);}};return{...wrapReadEvents({'zcode-task':{},project:{}},{api,autoStart:false}),calls};}
test('original dynamic events register immediately; historical baseline never becomes a new outcome',async()=>{
  const w=harness([page(8,[event(8,'turn/completed',ID,{turn:{status:'completed'}})])]),outcomes=[],snapshots=[];
  const a=w.channels['zcode-task'].onDynamicTaskTerminalOutcome(ID)(v=>outcomes.push(v)),b=w.channels['zcode-task'].onDynamicTaskEvent({taskId:ID,workspacePath:'/actual'})(v=>snapshots.push(v));
  try{await w.pollNow();assert.equal(outcomes.length,0);assert.equal(snapshots.length,0);assert.equal(w.status.connected,true);}finally{a.dispose();b.dispose();w.dispose();}
});
test('real fresh deltas become scoped snapshot invalidations and duplicate sequences do not replay',async()=>{
  const w=harness([page(1),page(4,[event(2,'item/agentMessage/delta',ID,{delta:'not forwarded'}),event(3,'item/completed'),event(4,'turn/started',OTHER)]),page(4,[event(3,'item/completed')])]),got=[],wrong=[],workspaces=[];
  const a=w.channels['zcode-task'].onDynamicTaskEvent({taskId:ID,workspacePath:'/actual'})(v=>got.push(v)),b=w.channels['zcode-task'].onDynamicTaskEvent({taskId:ID,workspacePath:'/wrong'})(v=>wrong.push(v)),c=w.channels['zcode-task'].onDynamicWorkspaceEvent({workspacePath:'/other'})(v=>workspaces.push(v));
  try{await w.pollNow();await w.pollNow();await w.pollNow();assert.equal(got.length,1);assert.equal(got[0].type,'task_snapshot_updated');assert.equal(wrong.length,0);assert.equal(workspaces.length,1);assert(!JSON.stringify(got).includes('not forwarded'));}finally{a.dispose();b.dispose();c.dispose();w.dispose();}
});
test('fresh real completion is delivered once even with later usage event and unknown stop is not success',async()=>{
  const w=harness([page(1),page(4,[event(2,'turn/completed',ID,{turn:{status:'completed'}}),event(3,'thread/tokenUsage/updated'),event(4,'turn/completed',ID,{turn:{status:'interrupted'}})])]),outcomes=[];
  const sub=w.channels['zcode-task'].onDynamicTaskTerminalOutcome(ID)(v=>outcomes.push(v));
  try{await w.pollNow();await w.pollNow();assert.deepEqual(outcomes,[{taskId:ID,outcome:'succeeded'}]);}finally{sub.dispose();w.dispose();}
});
test('source reset invalidates snapshots and project catalog without inventing turn outcomes',async()=>{
  const w=harness([page(5),page(1,[],'epoch-2')]),snapshots=[],catalog=[],outcomes=[];
  const a=w.channels['zcode-task'].onDynamicTaskEvent({taskId:ID})(v=>snapshots.push(v)),b=w.channels.broadcast.onMessage(v=>catalog.push(v)),c=w.channels['zcode-task'].onDynamicTaskTerminalOutcome(ID)(v=>outcomes.push(v));
  try{await w.pollNow();await w.pollNow();assert.equal(snapshots.length,1);assert.equal(catalog[0].channel,'state:projects');assert.equal(outcomes.length,0);}finally{a.dispose();b.dispose();c.dispose();w.dispose();}
});

test('queue updates invalidate only the matching task and stream once per page without replay or terminal outcomes',async()=>{
  const w=harness([page(1,[event(1,'bridge/queueUpdated')]),page(4,[event(2,'bridge/queueUpdated'),event(3,'bridge/queueUpdated'),event(4,'bridge/queueUpdated',OTHER)]),page(4,[event(3,'bridge/queueUpdated')])]),snapshots=[],streams=[],wrong=[],outcomes=[],catalog=[];
  const task=w.channels['zcode-task'],subs=[
    task.onDynamicTaskEvent({taskId:ID,workspacePath:'/actual'})(v=>snapshots.push(v)),
    task.onDynamicStreamEvent(ID)(v=>streams.push(v)),
    task.onDynamicTaskEvent({taskId:ID,workspacePath:'/wrong'})(v=>wrong.push(v)),
    task.onDynamicTaskTerminalOutcome(ID)(v=>outcomes.push(v)),
    task.onTaskChanged(v=>catalog.push(v)),w.changes(v=>catalog.push(v)),
  ];
  try{
    await w.pollNow();assert.equal(snapshots.length,0);
    await w.pollNow();await w.pollNow();
    assert.equal(snapshots.length,1);assert.equal(streams.length,1);assert.equal(snapshots[0].codexSourceMethod,'bridge/queueUpdated');assert.equal(snapshots[0].traceId,'codex-event-3');
    assert.deepEqual(wrong,[]);assert.deepEqual(outcomes,[]);assert.deepEqual(catalog,[]);
    assert.deepEqual(w.calls.filter(p=>p.startsWith('/api/threads?')),['/api/threads?ids='+ID]);
  }finally{for(const sub of subs)sub.dispose();w.dispose();}
});

test('unrelated snapshot traffic neither reads metadata nor fans out global task refreshes',async()=>{
  const events=Array.from({length:250},(_,i)=>event(i+2,'item/agentMessage/delta','unrelated-'+i));
  const w=harness([page(1),page(251,events),page(252,[event(252,'item/agentMessage/delta')])]),snapshots=[],global=[];
  const task=w.channels['zcode-task'],subs=[task.onDynamicTaskEvent({taskId:ID})(v=>snapshots.push(v)),task.onTaskChanged(v=>global.push(v)),task.onDynamicWorkspaceEvent({workspacePath:'/actual'})(v=>global.push(v)),w.channels.project.onDidChange(v=>global.push(v)),w.channels.broadcast.onMessage(v=>global.push(v)),w.changes(v=>global.push(v))];
  try{
    await w.pollNow();await w.pollNow();
    assert.deepEqual(w.calls.filter(p=>p.startsWith('/api/threads?')),[]);assert.deepEqual(snapshots,[]);assert.deepEqual(global,[]);assert.equal(w.status.sequence,251);
    await w.pollNow();assert.equal(snapshots.length,1);assert.deepEqual(global,[]);
    assert.deepEqual(w.calls.filter(p=>p.startsWith('/api/threads?')),['/api/threads?ids='+ID]);
  }finally{for(const sub of subs)sub.dispose();w.dispose();}
});

test('catalog changes survive later snapshot events and still refresh lists for other threads',async()=>{
  const w=harness([page(1),page(5,[event(2,'thread/name/updated',OTHER),event(3,'item/agentMessage/delta',OTHER),event(4,'turn/started'),event(5,'thread/tokenUsage/updated')])]),changed=[],workspace=[],catalog=[],snapshots=[];
  const task=w.channels['zcode-task'],subs=[task.onTaskChanged(v=>changed.push(v)),task.onDynamicWorkspaceEvent({workspacePath:'/other'})(v=>workspace.push(v)),task.onDynamicTaskEvent(ID)(v=>snapshots.push(v)),w.changes(v=>catalog.push(v))];
  try{
    await w.pollNow();await w.pollNow();
    assert.deepEqual(changed.map(v=>v.taskId),[OTHER,ID]);assert.equal(workspace.length,1);assert.equal(workspace[0].reason,'task_meta_changed');assert.equal(catalog.length,1);assert.equal(snapshots.length,1);
  }finally{for(const sub of subs)sub.dispose();w.dispose();}
});

test('terminal-only listeners receive completion without fetching unused snapshot metadata',async()=>{
  const w=harness([page(1),page(2,[event(2,'turn/completed',ID,{turn:{status:'failed'}})])]),outcomes=[];
  const sub=w.channels['zcode-task'].onDynamicTaskTerminalOutcome(ID)(v=>outcomes.push(v));
  try{await w.pollNow();await w.pollNow();assert.deepEqual(outcomes,[{taskId:ID,outcome:'failed'}]);assert.deepEqual(w.calls.filter(p=>p.startsWith('/api/threads?')),[]);}finally{sub.dispose();w.dispose();}
});

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=1000){const started=Date.now();while(!predicate()){if(Date.now()-started>timeout)throw Error('Expected event state did not arrive');await delay(2);}}
async function longPollHarness(t){
 let sequence=1,waits=0,aborted=0,immediate=0;const pending=new Set(),snapshots=[],errors=[];
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://fixture');res.setHeader('content-type','application/json');
  if(url.pathname==='/api/threads'){res.end(JSON.stringify({data:[{id:ID,cwd:'/actual'}]}));return;}
  if(url.searchParams.get('wait')==='1'){
   waits++;pending.add(res);res.once('close',()=>{pending.delete(res);if(!res.writableEnded)aborted++;});return;
  }
  immediate++;res.end(JSON.stringify(page(sequence)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const api={get:async(path,{signal}={})=>(await fetch(base+path,{signal})).json()};
 const w=wrapReadEvents({'zcode-task':{},project:{}},{api,useLongPolling:true,pollMs:5});
 const errorSub=w.channels['zcode-task'].onError(value=>errors.push(value)),sub=w.channels['zcode-task'].onDynamicTaskEvent({taskId:ID,workspacePath:'/actual'})(value=>snapshots.push(value));
 t.after(async()=>{sub.dispose();errorSub.dispose();w.dispose();for(const response of pending)response.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return{w,snapshots,errors,get waits(){return waits;},get aborted(){return aborted;},get immediate(){return immediate;},get waiting(){return pending.size;},fire(){sequence++;for(const response of pending)response.end(JSON.stringify(page(sequence,[event(sequence,'item/agentMessage/delta')])));}};
}

test('optional long polling delivers a native event through the held request without a one-second timer',{timeout:3000},async t=>{
 const f=await longPollHarness(t);await until(()=>f.waiting>0);const started=Date.now();f.fire();await until(()=>f.snapshots.length===1);
 assert.ok(Date.now()-started<500);assert.equal(f.snapshots[0].codexSourceMethod,'item/agentMessage/delta');assert.equal(f.w.status.connected,true);assert.equal(f.errors.length,0);
});

test('manual pollNow cancels the idle wait and immediately reads without reporting a transport failure',{timeout:3000},async t=>{
 const f=await longPollHarness(t);await until(()=>f.waiting>0);const before=f.immediate,started=Date.now();
 await Promise.race([f.w.pollNow(),delay(500).then(()=>{throw Error('Manual baseline remained blocked by a long poll');})]);
 assert.ok(Date.now()-started<500);assert.equal(f.immediate,before+1);await until(()=>f.aborted>=1);assert.equal(f.errors.length,0);assert.equal(f.w.status.connected,true);
});

test('dispose aborts the held HTTP read and releases the backend wait without scheduling another request',{timeout:3000},async t=>{
 const f=await longPollHarness(t);await until(()=>f.waiting>0);f.w.dispose();await until(()=>f.aborted===1&&f.waiting===0);const waits=f.waits;
 await delay(25);assert.equal(f.waits,waits);assert.equal(f.errors.length,0);assert.equal(f.w.status.connected,false);
});
