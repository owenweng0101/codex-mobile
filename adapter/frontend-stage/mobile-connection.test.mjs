import test from 'node:test';
import assert from 'node:assert/strict';
import {connectMobileServices} from '../mobile-connection.mjs';
import {mountCodexOriginalH5,shareStartupReads} from './browser-adapter.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,2));}assert.fail('condition did not settle');};
function fixture(overrides={}){
 const records=[],states=[],views=[];let commands=0;
 const environment=new EventTarget();environment.document=new EventTarget();environment.document.visibilityState='visible';
 const connect=async(_url,options)=>{
  const index=records.length;
  const socket={readyState:1,close(){if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>options.onClose({code:1006}));}};
  const services={modelSelectionService:{getView:async()=>({revision:index})},zcodeAgentService:{sendConversationCommandV4:()=>{commands++;return new Promise(()=>{});}}};
  records.push({socket,services,options});options.onCreateSocket(socket);options.onOpenSocket(socket);return services;
 };
 return{records,states,views,environment,get commands(){return commands;},options:{connect,url:'wss://fixture.invalid/ws',environment,retryDelayMs:1,maxRetryDelayMs:2,healthTimeoutMs:8,readTimeoutMs:25,writeTimeoutMs:100,onState:state=>states.push(state),onServices:services=>views.push(services),...overrides}};
}
test('closed connections reject hanging requests, replace services and never replay commands',async()=>{
 // Disconnect behavior is independent of the separately tested short deadlines.
 const f=fixture({writeTimeoutMs:10000}),connection=await connectMobileServices(f.options);
 try{
  const command=connection.services.zcodeAgentService.sendConversationCommandV4({commandId:'one'});await tick();
  const rejected=assert.rejects(command,error=>error.outcomeUnknown===true);
  f.records[0].socket.close();await rejected;await until(()=>f.views.length===2);
  assert.equal(f.commands,1);assert.equal((await f.views[1].modelSelectionService.getView()).revision,1);
  await assert.rejects(connection.services.modelSelectionService.getView(),{code:'CODEX_CONNECTION_CLOSED'});
  assert.deepEqual(f.states.slice(0,2),['connecting','paired']);
 }finally{connection.dispose();}
});
test('read timeout releases a stuck connection and a new read can succeed',async()=>{
 const f=fixture(),connection=await connectMobileServices(f.options);
 try{
  f.records[0].services.modelSelectionService.getView=()=>new Promise(()=>{});
  await assert.rejects(connection.services.modelSelectionService.getView(),{code:'CODEX_READ_TIMEOUT'});
  await until(()=>f.views.length===2);assert.equal((await f.views[1].modelSelectionService.getView()).revision,1);
 }finally{connection.dispose();}
});
test('resuming an apparently open but unresponsive socket performs a bounded read and reconnects',async()=>{
 const f=fixture(),connection=await connectMobileServices(f.options);
 try{f.records[0].services.modelSelectionService.getView=()=>new Promise(()=>{});await connection.resume();await until(()=>f.views.length===2);assert.equal(f.records[0].socket.readyState,3);assert.equal(f.commands,0);}
 finally{connection.dispose();}
});
test('disposal removes resume listeners and prevents any further reconnect',async()=>{
 const f=fixture(),connection=await connectMobileServices(f.options);connection.dispose();
 f.environment.dispatchEvent(new Event('online'));f.environment.document.dispatchEvent(new Event('visibilitychange'));await tick();assert.equal(f.records.length,1);assert.equal(f.records[0].socket.readyState,3);
});
test('expired handshakes close their socket and cannot later publish services',async()=>{
 let closed=0,release,view=0;
 await assert.rejects(connectMobileServices({connectTimeoutMs:8,environment:{},onServices:()=>view++,connect:(_url,options)=>{options.onCreateSocket({close(){closed++;}});return new Promise(r=>release=r);}}),/连接超时/);
 release({});await tick();assert(closed>=1);assert.equal(view,0);
});
test('replacing services preserves render/navigation identity and recreates model cache',async()=>{
 const mounts=[],info={authenticated:true,workspaces:[{path:'/work'}]};
 const first={modelSelectionService:{getView:async()=>({revision:1})}},second={modelSelectionService:{getView:async()=>({revision:2})}};
 const controller=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount:value=>mounts.push(value)},info,services:first,resolveNavigation:async()=>({workspacePath:'/work'})});
 try{const key=mounts[0].key;await controller.switcher.updateMobileViewState('/work','existing-task');controller.replaceServices(second);assert.equal(mounts.at(-1).key,key);assert.equal(controller.getContext().initialTaskId,'existing-task');assert.equal((await mounts.at(-1).services.modelSelectionService.getView()).revision,2);}
 finally{controller.dispose();}
});
test('overlapping navigation reads share RPC while commands remain independent',async()=>{
 let reads=0,commands=0,release;
 const cache=shareStartupReads({projectService:{readTree:()=>{reads++;return new Promise(r=>release=r);}},zcodeAgentService:{sendConversationCommandV4:async()=>++commands}});
 try{const first=cache.services.projectService.readTree({}),second=cache.services.projectService.readTree({});await tick();assert.equal(reads,1);release({tasks:[{id:1}]});const [a,b]=await Promise.all([first,second]);a.tasks[0].id=2;assert.equal(b.tasks[0].id,1);await Promise.all([cache.services.zcodeAgentService.sendConversationCommandV4({}),cache.services.zcodeAgentService.sendConversationCommandV4({})]);assert.equal(commands,2);}
 finally{cache.dispose();}
});
