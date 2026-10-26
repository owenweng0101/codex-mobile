import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheNavigationModels} from './browser-adapter.mjs';

test('model views survive workspace remounts and simultaneous readers share one RPC',async()=>{
 let reads=0,notify,disposed=0,release;const source={getView:async input=>{reads++;await new Promise(r=>release=r);return{selection:input.selection};},onDidChange:fn=>{notify=fn;return{dispose(){disposed++;}};}};
 const cached=cacheNavigationModels({modelSelectionService:source}),s=cached.services.modelSelectionService;
 const a=s.getView({selection:null}),b=s.getView({selection:null});await Promise.resolve();assert.equal(reads,1);release();assert.deepEqual(await a,await b);
 assert.deepEqual(await s.getView({selection:null}),await a);assert.equal(reads,1);
 notify();const c=s.getView({selection:null});await Promise.resolve();assert.equal(reads,2);release();await c;
 cached.dispose();assert.equal(disposed,1);
});
test('selection identity, expiration and reconnect invalidation cannot reuse a different model view',async()=>{
 let time=0,reads=0;const c=cacheNavigationModels({modelSelectionService:{getView:async input=>{reads++;return input;}}},{now:()=>time,maxAgeMs:10}),s=c.services.modelSelectionService;
 await s.getView({selection:'A'});assert.deepEqual(await s.getView({selection:'B'}),{selection:'B'});assert.equal(reads,2);
 time=11;await s.getView({selection:'A'});assert.equal(reads,3);c.clear();await s.getView({selection:'A'});assert.equal(reads,4);
 c.dispose();
});
test('failed model reads are not cached and late invalidated reads cannot replace current data',async()=>{
 let count=0,resolve;const c=cacheNavigationModels({modelSelectionService:{getView:async()=>{count++;if(count===1)throw Error('offline');if(count===2)return new Promise(r=>resolve=r);return{revision:3};}}}),s=c.services.modelSelectionService;
 await assert.rejects(s.getView(),/offline/);const old=s.getView();await Promise.resolve();c.clear();assert.deepEqual(await s.getView(),{revision:3});resolve({revision:2});await old;assert.deepEqual(await s.getView(),{revision:3});assert.equal(count,3);c.dispose();
});

test('settings mutations invalidate cached reads',async()=>{
 let value=1;const c=cacheNavigationModels({settingService:{get:async()=>value,update:async v=>{value=v;}}});
 assert.equal(await c.services.settingService.get(),1);await c.services.settingService.update(2);assert.equal(await c.services.settingService.get(),2);c.dispose();
});

test('new navigation keys reapply workspace selection without rerunning an unchanged draft',async()=>{
 const {readFile}=await import('node:fs/promises'),{default:vm}=await import('node:vm');const bundle=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
 const start=bundle.indexOf('function K8n('),end=bundle.indexOf(',(0,Q.useEffect)(()=>{let e=l.onFocusTab',start);assert(start>0&&end>start);
 const refs=[],effects=[],calls=[];let cursor=0;
 const context={Q:{useRef:v=>refs[cursor++]??(refs[cursor-1]={current:v}),useState:()=>[0,()=>{}],useEffect:f=>effects.push(f)},mE:()=>({}),ws:()=>({}),bM:()=>null,AM:()=>null,SM:'draft',W4:()=>false,MO:{getState:()=>({setActiveTaskId:(...args)=>calls.push(['task',...args])})}};
 const boot=vm.runInNewContext('('+bundle.slice(start,end)+'})',context);
 const render=key=>{cursor=0;effects.length=0;boot({codexNavigationKey:key,initialWorkspaceAbsPath:'/conversations',initialTaskDraft:{projectId:null},addTab:path=>calls.push(['tab',path]),setIsBootstrappingInitialWorkspace:()=>{},startDraftInWorkspace:(path,identity,draft)=>calls.push(['draft',path,draft.projectId])});effects[0]();};
 render('one');render('one');assert.equal(calls.filter(c=>c[0]==='draft').length,1);render('two');assert.equal(calls.filter(c=>c[0]==='draft').length,2);assert.deepEqual(calls.at(-1),['draft','/conversations',null]);
});
