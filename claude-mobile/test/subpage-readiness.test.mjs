import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {chatHtml} from '../backend/lib/ui.mjs';
const html=chatHtml();
const hook=name=>html.match(new RegExp('window\\.'+name+'=[\\s\\S]*?\\n  \\};'))[0];
const slice=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('Claude readiness follows committed current view, not document load or older pagination',()=>{
  const state={},window={},context={state,window,listController:null,listView:{classList:{contains:()=>false}}};
  vm.runInNewContext(hook('__mobileHubReadiness'),context);const ready=window.__mobileHubReadiness;
  assert.equal(ready(),'loading');state.listLoaded=true;assert.equal(ready(),'ready');
  context.listController={};assert.equal(ready(),'loading');context.listController=null;state.listLoadError=true;assert.equal(ready(),'error');
  context.listView.classList.contains=()=>true;state.sessionId='task';assert.equal(ready(),'loading');
  state.chatLoadedSessionId='task';state.loadingOlder=true;assert.equal(ready(),'ready');
  state.loading=true;assert.equal(ready(),'loading');state.loading=false;state.chatLoadError=true;assert.equal(ready(),'error');
  state.sessionId=null;state.modelsLoaded=true;assert.equal(ready(),'ready');
});

test('initial parent loading cover suppresses native read acknowledgement until content is revealed',()=>{
  let covered=true;const marker={},window={},parent={document:{getElementById:()=>({classList:{contains:()=>!covered}})}};
  const context={window,parent,state:{sessionId:'task',viewVersion:1,nativeReadMarker:marker},hubActive:true,document:{hidden:false},chatView:{inert:false,classList:{contains:()=>false},getClientRects:()=>[{}]},composer:{inert:false},$:()=>({classList:{contains:()=>true}})};
  const visible=vm.runInNewContext(slice('  function nativeReadVisible(', '  function acknowledgeRead(')+';nativeReadVisible',context);
  assert.equal(visible('task',1,marker),false);covered=false;assert.equal(visible('task',1,marker),true);
});

for(const resetKind of ['reset','sinceTruncated'])test('Claude '+resetKind+' refresh waits through actual replacement session content',async()=>{
  const gate=deferred(),state={sessionId:'task',viewVersion:1,since:12},window={};let opens=0,finished=false;
  const context={window,state,hubActive:true,document:{hidden:false},AbortController,setTimeout:()=>1,clearTimeout(){},listView:{classList:{contains:()=>true}},saveDraft(){},title:{textContent:'Session'},applyControl(){},fetch:async()=>({ok:true,json:async()=>({[resetKind]:true})}),openSession:()=>{opens++;state.loading=true;state.sessionCompletion=gate.promise;return gate.promise.then(()=>{state.loading=false;state.chatLoadedSessionId='task';});}};
  const code='let pollController=null,reloadTarget=null;'+slice('  async function poll(){','  let reloadTarget=null;')+slice('  async function finallyReloadSession(', '  async function openSession(')+hook('__claudeMobileRefresh');
  vm.runInNewContext(code,context);const pending=window.__claudeMobileRefresh().then(()=>{finished=true;});
  await tick();assert.equal(opens,1);assert.equal(finished,false);assert.equal(state.hubRefreshing,true);
  gate.resolve();await pending;assert.equal(finished,true);assert.equal(state.hubRefreshing,false);assert.equal(state.chatLoadedSessionId,'task');
});

test('Claude capsule refresh joins an already loading session instead of resolving early',async()=>{
  const gate=deferred(),state={sessionId:'task',loading:true,sessionCompletion:gate.promise},window={};let finished=false;
  const context={window,state,hubActive:true,document:{hidden:false},listView:{classList:{contains:()=>true}},saveDraft(){}};
  vm.runInNewContext(slice('  async function poll(){','  let reloadTarget=null;')+hook('__claudeMobileRefresh'),context);
  const pending=window.__claudeMobileRefresh().then(()=>{finished=true;});await tick();assert.equal(finished,false);
  gate.resolve();await pending;assert.equal(finished,true);
});
