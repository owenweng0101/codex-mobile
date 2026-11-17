import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,stat,utimes} from 'node:fs/promises';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import traversePackage from '@babel/traverse';
import generatePackage from '@babel/generator';
import {bn as We} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/validation-mobile-video-v1.js';
import {D as bo,k as Do} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-mobile-video-v1.js';
import {Emitter,SocketProtocol,ChannelClient,ChannelServer,ProxyChannel} from '../vendor/rpc.mjs';
import {RolloutConversationIndex} from '../../backend/conversation-index.mjs';
import {conversationFixture,fixtureId,fixtureThread} from '../../backend/test/conversation-fixture.mjs';
import {createConversationReadServices} from './conversation-read.mjs';
import {historyScopeEdits,historyScopePatches} from './build-history-scope.mjs';
const traverse=traversePackage.default||traversePackage,generate=generatePackage.default||generatePackage;
const emitted=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
// Before root rebuilds, test the candidate entirely in memory. After rebuild,
// prove the exact emitted implementation matches the same reviewed patches.
let original=emitted;
// A review build may contain the superseded post-notification epoch read. Strip
// that exact known candidate only in memory; normal tests still reject it below
// until root rebuilds. Candidate-only runs never claim emitted verification.
const candidateOnly=process.env.CODEX_HISTORY_SCOPE_CANDIDATE==='1';
const supersededEpochArgument=',baseLogEpoch:this.state.snapshot.logEpoch';
if(original.includes(supersededEpochArgument)){assert.equal(original.split(supersededEpochArgument).length-1,1);original=original.replace(supersededEpochArgument,'');}
for(const patch of historyScopePatches)if(original.includes(patch.after)){assert.equal(original.split(patch.after).length-1,1);original=original.replace(patch.after,patch.before);}
let patched=original;
for(const edit of historyScopeEdits(original).sort((a,b)=>b.start-a.start))patched=patched.slice(0,edit.start)+edit.text+patched.slice(edit.end);
const manifest=JSON.parse(await readFile(new URL('./bundle-patch-manifest.json',import.meta.url),'utf8'));
const declaresScopedBuild=manifest.mobileSplit?.stages?.some(stage=>stage.name==='mobile-history-subscription-scope');
if(!candidateOnly&&(declaresScopedBuild||historyScopePatches.some(patch=>emitted.includes(patch.after))))assert.equal(emitted,patched,'Emitted history scope stage must contain every reviewed patch, not a partial candidate');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function implementation(source,codexBridge=true){
 const ast=parse(source,{sourceType:'module'}),helpers=[];let store,pool,rowsRange;
 traverse(ast,{VariableDeclarator(p){if(p.node.id?.name==='xle')store=generate(p.node.init).code;if(p.node.id?.name==='sle')pool=generate(p.node.init).code;},FunctionDeclaration(p){if(['yu','bu','pu','ole','yle','gu','ble','_u'].includes(p.node.id?.name))helpers.push(generate(p.node).code);},ObjectMethod(p){if(p.node.key.name==='rowsRange'&&p.findParent(x=>x.isFunctionDeclaration()&&x.node.id?.name==='du'))rowsRange=generate(p.node).code;}});
 assert(store&&pool&&rowsRange,'actual emitted store, row pool and du transport must exist');
 const warnings=[],context=vm.createContext({We,bo,Do,performance,Date,WeakRef,FinalizationRegistry,Set,Map,clearTimeout,setTimeout,xu:new Set(),__CODEX_ORIGINAL_BRIDGE__:{codexBridge},J:{warn:(...args)=>warnings.push(String(args[0])),info(){},debug(){},lifecycle:{info(){},warn(){}}}});
 const classes=vm.runInContext(helpers.join('\n')+';({Store:('+store+'),Pool:('+pool+')})',context);
 return{...classes,warnings,transport(remote,workspace){return vm.runInNewContext('({'+rowsRange+'})',{e:remote,n:workspace,a:async()=>{},__CODEX_ORIGINAL_BRIDGE__:{codexBridge}});}};
}
// Only optimistic-command bookkeeping is omitted: actual range request,
// response guards, row sharing, frame acceptance and setState all run verbatim.
function makeStore(impl,transport){
 const store=Object.create(impl.Store.prototype);
 Object.assign(store,{closed:false,topic:'conversation/'+fixtureId,transport,state:{snapshot:null,loadingOlder:false,subscriptionId:null,planDirectoryRevision:0,turnNavigatorDirectoryRevision:0},listeners:new Set(),modelTransitionListeners:new Set(),liveDeltaListeners:new Set(),acceptedInputProjectionTimers:new Map(),generation:0,offAssemblyFault(){},runtimeRecycleRetryTimer:null,rowPool:new impl.Pool(),subscriptionHasAppliedBase:false,recovery:null,awaitingInitial:null,initialSubscribeAckAt:null,sessionOpenRendererTiming:{},reconcileOptimistic(){},reconcileAcceptedInputProjection(){},observeModelTransition(){},markRecoveryFrameSeen(){}});
 return store;
}
const implementationPatched=implementation(patched),implementationOld=implementation(original);
async function fixture(t){
 const f=await conversationFixture(t),index=new RolloutConversationIndex(),native=new Emitter(),frames=[],requests=[],results=[],stores=new Map();let hold=null;
 const params={sessionId:fixtureId,workspacePath:fixtureThread.cwd};
 const api={get:async path=>{
  const q=new URL(path,'http://fixture').searchParams;
  if(hold&&hold.matches(q)){const pending=hold;hold=null;pending.entered.resolve();await pending.gate.promise;}
  const value=await index.read(f.file,{threadId:fixtureId,thread:fixtureThread,limit:Number(q.get('limit')||60),beforeRowId:q.has('beforeRowId')?Number(q.get('beforeRowId')):undefined,fromRowId:q.has('fromRowId')?Number(q.get('fromRowId')):undefined,sourceEpoch:q.get('sourceEpoch')??undefined,ifRevision:q.get('ifRevision')??undefined,metadataOnly:q.get('metadataOnly')==='1'});
  return{thread:fixtureThread,turns:value.lastTurn?[value.lastTurn]:[],...value};
 }};
 const service=createConversationReadServices({indexedHistory:true,initialHistoryRows:20,api,baseServices:{project:{readTree:async()=>({tasks:[{taskId:fixtureId,workspacePath:fixtureThread.cwd}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}}}),agent=service.channels['zcode-agent'];
 const listener=agent.onDynamicConversationFrame(params)(wire=>{frames.push(wire);stores.get(wire.subscriptionId)?.handleFrame(wire.frame,{deliveryKind:wire.deliveryKind});});
 const left=new Emitter(),right=new Emitter(),p1=new SocketProtocol({onData:left.event,write:bytes=>queueMicrotask(()=>right.fire(bytes)),drain:async()=>{}}),p2=new SocketProtocol({onData:right.event,write:bytes=>queueMicrotask(()=>left.fire(bytes)),drain:async()=>{}}),client=new ChannelClient(p1),server=new ChannelServer(p2,{});
 const monitored=new Proxy(agent,{get(target,key){const value=Reflect.get(target,key);if(key!=='conversationRowsRangeV4')return typeof value==='function'?value.bind(target):value;return async(...args)=>{assert.equal(args.length,1);requests.push(args[0]);const result=await value(...args);results.push(result);return result;};}});
 server.registerChannel('zcode-agent',ProxyChannel.fromService(monitored));const remote=ProxyChannel.toService(client.getChannel('zcode-agent'));
 t.after(()=>{listener.dispose();service.dispose();native.dispose();client.dispose();server.dispose();p1.dispose();p2.dispose();left.dispose();right.dispose();});
 return{...f,service,agent,remote,params,requests,results,frames,
  hold(matches){const pending={matches,gate:deferred(),entered:deferred()};hold=pending;return pending;},
  async addStore(impl=implementationPatched){const store=makeStore(impl,impl.transport(remote,{workspacePath:fixtureThread.cwd})),{ack}=await remote.subscribeConversationV4(params);store.transport.unsubscribe=subscriptionId=>remote.unsubscribeConversationV4({workspacePath:fixtureThread.cwd,subscriptionId});store.state.subscriptionId=ack.subscriptionId;stores.set(ack.subscriptionId,store);const wire=frames.find(frame=>frame.subscriptionId===ack.subscriptionId);store.handleFrame(wire.frame,{deliveryKind:wire.deliveryKind});return{store,ack};},
 };
}

test('history scope patch is exact, refuses drift and keeps other hosts wire-compatible',async()=>{
 assert.equal(historyScopeEdits(original).length,3);assert.throws(()=>historyScopeEdits(patched));
 const other=implementation(patched,false);let observed;await other.transport({conversationRowsRangeV4:async p=>{observed=p;return{};}},{workspacePath:'/fixture'}).rowsRange({sessionId:fixtureId,beforeRowId:101,limit:60,baseLogEpoch:'private-epoch'});
 assert.equal(observed.baseLogEpoch,undefined);assert.equal(observed.beforeRowId,101);
});
test('actual patched store + du + binary RPC routes two simultaneous subscribers to their own epochs',async t=>{
 const f=await fixture(t),a=await f.addStore(),b=await f.addStore();assert.notEqual(a.ack.logEpoch,b.ack.logEpoch);
 await Promise.all([a.store.loadOlder(),b.store.loadOlder()]);
 assert.equal(a.store.state.snapshot.rows.window.length,80);assert.equal(b.store.state.snapshot.rows.window.length,80);
 assert.deepEqual(new Set(f.requests.map(p=>p.baseLogEpoch)),new Set([a.ack.logEpoch,b.ack.logEpoch]));
 assert(f.requests.every(p=>p.beforeRowId===101&&p.limit===60));assert.deepEqual(new Set(f.results.map(p=>p.atLogEpoch)),new Set([a.ack.logEpoch,b.ack.logEpoch]));
 assert.equal(a.store.state.snapshot.logEpoch,a.ack.logEpoch);assert.equal(b.store.state.snapshot.logEpoch,b.ack.logEpoch);
});
for(const change of ['epoch','session','subscription','null','close'])test('synchronous actual store listener '+change+' cancels the old gesture before RPC',async t=>{
 const f=await fixture(t),a=await f.addStore(),b=await f.addStore();let switched=false,closed;
 a.store.listeners.add(()=>{
  if(switched||!a.store.state.loadingOlder)return;switched=true;
  if(change==='close'){closed=a.store.close();return;}
  if(change==='subscription'){a.store.setState({subscriptionId:b.ack.subscriptionId});return;}
  const snapshot=change==='null'?null:change==='epoch'?b.store.state.snapshot:{...a.store.state.snapshot,sessionId:'different-session'};
  a.store.setState({snapshot});
 });
 await a.store.loadOlder();await closed;
 assert.equal(f.requests.length,0,'an invalidated gesture must not issue a mixed-scope or disposed request');assert.equal(f.results.length,0);
 if(change==='close'){assert.equal(a.store.closed,true);assert.equal(a.store.state.status,'closed');assert.equal(a.store.state.subscriptionId,null);}
 else assert.equal(a.store.state.loadingOlder,false,'the existing finally must settle loading after an early return');
 assert.equal(b.store.state.snapshot.rows.window.length,20);
});

test('the actual complete-directory range caller carries its captured epoch too',async t=>{
 const f=await fixture(t),a=await f.addStore(),b=await f.addStore();
 const results=await Promise.all([a.store.loadAllOlder(),b.store.loadAllOlder()]);
 assert(results.every(result=>result.status==='hydrated'));assert.equal(a.store.state.snapshot.rows.window.length,120);assert.equal(b.store.state.snapshot.rows.window.length,120);
 assert.deepEqual(new Set(f.requests.map(p=>p.baseLogEpoch)),new Set([a.ack.logEpoch,b.ack.logEpoch]));
});

test('unpatched clients work with one subscription but multiple subscriptions are explicitly rejected',async t=>{
 const f=await fixture(t),a=await f.addStore(implementationOld);await a.store.loadOlder();assert.equal(a.store.state.snapshot.rows.window.length,80);assert.equal(f.requests[0].baseLogEpoch,undefined);
 const b=await f.addStore(implementationOld);await assert.rejects(f.remote.conversationRowsRangeV4({...f.params,beforeRowId:101,limit:60}),{code:'CODEX_HISTORY_SCOPE_REQUIRED'});
 await b.store.loadOlder();assert.equal(b.store.state.snapshot.rows.window.length,20);assert.equal(b.store.state.loadingOlder,false);
});
test('stale epoch and unsubscribed owner never fall back to another subscriber',async t=>{
 const f=await fixture(t),a=await f.addStore(),b=await f.addStore();
 for(const baseLogEpoch of ['expired-epoch','',null])await assert.rejects(f.remote.conversationRowsRangeV4({...f.params,beforeRowId:101,limit:60,baseLogEpoch}),{code:'HISTORY_WINDOW_CHANGED'});
 await f.remote.unsubscribeConversationV4({...f.params,subscriptionId:a.ack.subscriptionId});
 await assert.rejects(f.remote.conversationRowsRangeV4({...f.params,beforeRowId:101,limit:60,baseLogEpoch:a.ack.logEpoch}),{code:'HISTORY_WINDOW_CHANGED'});
 await b.store.loadOlder();assert.equal(b.store.state.snapshot.rows.window.length,80);
});
test('an unsubscribed owner cannot commit a pending range into another store',async t=>{
 const f=await fixture(t),a=await f.addStore(),b=await f.addStore(),held=f.hold(q=>q.has('beforeRowId'));
 const pending=f.remote.conversationRowsRangeV4({...f.params,beforeRowId:101,limit:60,baseLogEpoch:a.ack.logEpoch});await held.entered.promise;
 await f.remote.unsubscribeConversationV4({...f.params,subscriptionId:a.ack.subscriptionId});held.gate.resolve();await assert.rejects(pending,{code:'HISTORY_WINDOW_CHANGED'});
 assert.equal(a.store.state.snapshot.rows.window.length,20);await b.store.loadOlder();assert.equal(b.store.state.snapshot.rows.window.length,80);
});
test('history rewrite during a scoped read rotates only its owner and rejects the old range',async t=>{
 const f=await fixture(t),a=await f.addStore(),b=await f.addStore(),held=f.hold(q=>q.has('beforeRowId'));
 const pending=f.remote.conversationRowsRangeV4({...f.params,beforeRowId:101,limit:60,baseLogEpoch:a.ack.logEpoch});await held.entered.promise;
 const before=await stat(f.file);await writeFile(f.file,f.content.replace('Answer 39','Change 39'));await utimes(f.file,before.atime,new Date(before.mtimeMs+2000));held.gate.resolve();await assert.rejects(pending,{code:'HISTORY_WINDOW_CHANGED'});
 assert.notEqual(a.store.state.snapshot.logEpoch,a.ack.logEpoch);assert.equal(b.store.state.snapshot.logEpoch,b.ack.logEpoch);
 await a.store.loadOlder();assert.equal(a.store.state.snapshot.rows.window.length,80);
});
test('a scoped request queued behind an epoch-changing resync is checked again before body IO',async t=>{
 const f=await fixture(t),a=await f.addStore(),held=f.hold(q=>q.has('fromRowId'));
 const resync=f.remote.resyncConversationV4({...f.params,subscriptionId:a.ack.subscriptionId});await held.entered.promise;
 const before=await stat(f.file);await writeFile(f.file,f.content.replace('Answer 39','Change 39'));await utimes(f.file,before.atime,new Date(before.mtimeMs+2000));
 const range=f.remote.conversationRowsRangeV4({...f.params,beforeRowId:101,limit:60,baseLogEpoch:a.ack.logEpoch});await flush();held.gate.resolve();await resync;await assert.rejects(range,{code:'HISTORY_WINDOW_CHANGED'});
 assert.equal(f.results.length,0);assert.equal(a.store.state.snapshot.rows.window.length,20);
});
