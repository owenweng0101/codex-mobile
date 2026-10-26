import test from 'node:test';
import assert from 'node:assert/strict';
import {shareReadApi,INVALIDATE_READS} from '../shared-reads.mjs';
import {createReadServices} from '../index.mjs';
import {wrapReadEvents} from '../events.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const id='11111111-1111-4111-8111-111111111111';

test('slow catalog shares pending work across TTL and starts its TTL after success',async t=>{
 let clock=100,reads=0;const gate=deferred();t.mock.method(Date,'now',()=>clock);
 const services=createReadServices({cacheMs:10,api:{get:async path=>{reads++;await gate.promise;return path==='/api/projects'?{projects:[]}:path==='/api/organize'?{}:{data:[{id,cwd:'/fixture'}]};}}});
 const first=services.project.readTree();await tick();clock=1000;const second=services.project.readTree();await tick();assert.equal(reads,2);
 gate.resolve();assert.deepEqual(await first,await second);assert.equal(reads,3);
 clock=1009;await services.project.readTree();assert.equal(reads,3);
 clock=1011;await services.project.readTree();assert.equal(reads,6);
});

test('refresh fences pending catalog results and a rejected catalog can retry',async()=>{
 const old=deferred();let projects=0,fail=false;
 const api=shareReadApi({get:async path=>{if(path==='/api/projects'){projects++;if(projects===1)return old.promise;if(fail)throw Error('offline');return{projects:[{id:'fresh',roots:[]}]};}return path==='/api/organize'?{}:{data:[]};}});
 const services=createReadServices({api,cacheMs:10000}),first=services.project.readTree();await tick();
 assert.equal((await services.project.readTree({refresh:true})).projects[0].id,'fresh');assert.equal(projects,2);
 old.resolve({projects:[{id:'stale',roots:[]}]});await first;assert.equal((await services.project.readTree()).projects[0].id,'fresh');
 fail=true;await assert.rejects(services.project.readTree({refresh:true}),/offline/);fail=false;await services.project.readTree();assert.equal(projects,4);
});

test('identical pending GETs share once, return isolated objects, and never cache settled responses',async()=>{
 let reads=0;const gate=deferred();const api=shareReadApi({get:async path=>{reads++;await gate.promise;return{path,data:[{value:1}]};}});
 const first=api.get('/api/models'),second=api.get('/api/models'),different=api.get('/api/status');await tick();assert.equal(reads,2);
 gate.resolve();const [a,b,c]=await Promise.all([first,second,different]);assert.deepEqual(a,b);a.data[0].value=7;assert.equal(b.data[0].value,1);assert.notEqual(b.path,c.path);
 await api.get('/api/models');assert.equal(reads,3);
});

test('failed shared GET releases pending identity for a later retry',async()=>{
 let reads=0;const gate=deferred();const api=shareReadApi({get:async()=>{if(++reads===1)return gate.promise;return{ok:true};}});
 const first=api.get('/api/models'),second=api.get('/api/models');const failures=Promise.allSettled([first,second]);await tick();gate.reject(Error('offline'));
 assert((await failures).every(result=>result.status==='rejected'));assert.deepEqual(await api.get('/api/models'),{ok:true});assert.equal(reads,2);
});

test('different cursors, events, custom options and writes remain independent',async()=>{
 let reads=0,writes=0;const gate=deferred();const api=shareReadApi({get:async()=>{reads++;await gate.promise;return{};},post:async()=>{writes++;await gate.promise;return{};}});
 const signal=new AbortController().signal;
 const work=[api.get('/api/events?since=1'),api.get('/api/events?since=1'),api.get('/api/history?threadId=a&cursor=x'),api.get('/api/history?threadId=a&cursor=y'),api.get('/api/models',{signal}),api.get('/api/models',{signal}),api.get('/api/models',{shareRead:false}),api.get('/api/models',{shareRead:false}),api.post('/api/message',{}),api.post('/api/message',{})];
 await tick();assert.equal(reads,8);assert.equal(writes,2);gate.resolve();await Promise.all(work);
});

test('bypass removes only shareRead and preserves caller options and signal ownership',async()=>{
 const gate=deferred(),controller=new AbortController();let reads=0;
 const api=shareReadApi({get:async(path,options)=>{reads++;if(options?.signal){assert.deepEqual(Reflect.ownKeys(options),['signal']);return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}return gate.promise;}});
 const shared=api.get('/api/models'),abortable=api.get('/api/models',{shareRead:false,signal:controller.signal});await tick();controller.abort();await assert.rejects(abortable,/aborted/);
 gate.resolve({ok:true});assert.deepEqual(await shared,{ok:true});assert.equal(reads,2);
});

test('late cleanup cannot erase a newer pending read after invalidation',async()=>{
 const gates=[deferred(),deferred()];let reads=0;const api=shareReadApi({get:()=>gates[reads++].promise});
 const old=api.get('/api/models');await tick();api[INVALIDATE_READS]();const fresh=api.get('/api/models');await tick();
 gates[0].resolve({revision:1});await old;const joined=api.get('/api/models');await tick();assert.equal(reads,2);
 gates[1].resolve({revision:2});assert.deepEqual(await fresh,await joined);
});

test('write start and settlement each fence reads without merging or retrying writes',async()=>{
 const gates=Array.from({length:3},deferred),write=deferred();let reads=0,writes=0;
 const api=shareReadApi({get:()=>gates[reads++].promise,post:()=>{writes++;return write.promise;}});
 const before=api.get('/api/models');await tick();const mutation=api.post('/api/message',{}),during=api.get('/api/models');await tick();assert.equal(reads,2);
 write.resolve({ok:true});await mutation;const after=api.get('/api/models');await tick();assert.equal(reads,3);assert.equal(writes,1);
 gates.forEach((gate,index)=>gate.resolve({index}));await Promise.all([before,during,after]);
});

test('native changes fence GET reads; baseline replay and repeated event pages do not',async t=>{
 let revision=0,invalidations=0;const gates=[deferred(),deferred()];let models=0;
 const source=shareReadApi({get:async path=>path.startsWith('/api/events')?{sequence:revision,epoch:'fixture',events:revision?[{id:revision,method:'item/completed',params:{threadId:id}}]:[]}:path.startsWith('/api/threads')?{data:[{id,cwd:'/fixture'}]}:gates[models++].promise});
 const api=new Proxy(source,{get(target,key){if(key===INVALIDATE_READS)return options=>{invalidations++;target[key](options);};return target[key];}});
 const wrapped=wrapReadEvents({'zcode-task':{},project:{}},{api,autoStart:false});t.after(()=>wrapped.dispose());
 const subscription=wrapped.channels['zcode-task'].onDynamicTaskEvent({taskId:id})(()=>{});t.after(()=>subscription.dispose());
 await wrapped.pollNow();assert.equal(invalidations,0);const before=api.get('/api/models');await tick();revision=1;await wrapped.pollNow();assert.equal(invalidations,1);
 const after=api.get('/api/models');await tick();assert.equal(models,2);await wrapped.pollNow();assert.equal(invalidations,1);
 gates.forEach((gate,index)=>gate.resolve({index}));await Promise.all([before,after]);
});

test('catalog events invalidate a slow catalog before listeners run while stream events preserve its TTL',async t=>{
 let sequence=0,method='item/completed',projects=0;const old=deferred(),observed=[];
 const api=shareReadApi({get:async path=>{
  if(path.startsWith('/api/events'))return{sequence,epoch:'fixture',events:sequence?[{id:sequence,method,params:{threadId:id}}]:[]};
  if(path==='/api/projects'){if(++projects===1)return old.promise;return{projects:[{id:'fresh',roots:[]}]};}
  return path==='/api/organize'?{}:{data:[{id,cwd:'/fixture'}]};
 }});
 const services=createReadServices({api,cacheMs:10000});const wrapped=wrapReadEvents(services,{api,autoStart:false});t.after(()=>wrapped.dispose());
 const subscription=wrapped.channels['zcode-task'].onDynamicTaskEvent({taskId:id})(()=>{if(method==='thread/name/updated')observed.push(services.project.readTree());});t.after(()=>subscription.dispose());
 await wrapped.pollNow();const before=services.project.readTree();await tick();sequence=1;await wrapped.pollNow();
 const during=services.project.readTree();await tick();assert.equal(projects,1,'stream events do not reload the catalog');
 method='thread/name/updated';sequence=2;await wrapped.pollNow();assert.equal((await observed[0]).projects[0].id,'fresh');assert.equal((await services.project.readTree()).projects[0].id,'fresh');assert.equal(projects,2);
 old.resolve({projects:[{id:'old',roots:[]}]});await Promise.all([before,during]);assert.equal((await services.project.readTree()).projects[0].id,'fresh');
});
