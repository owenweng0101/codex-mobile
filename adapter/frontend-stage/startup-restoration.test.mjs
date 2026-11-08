import test from 'node:test';
import assert from 'node:assert/strict';
import {mountCodexOriginalH5} from './browser-adapter.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
function setup(savedView){
 let saved=savedView?JSON.stringify(savedView):null;
 const mounts=[];
 const storage={getItem:()=>saved,setItem:(key,value)=>{saved=value},removeItem:()=>{saved=null}};
 return {mounts,get saved(){return saved},options:{compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount:p=>mounts.push(p)},services:{},info:{authenticated:true,workspaces:[{path:'/project'}],initialWorkspaceAbsPath:'/project'},viewStorage:storage,resolveNavigation:async request=>({workspacePath:'/project',initialTaskId:request.options.taskId,navigationIntent:'chat'})}};
}
test('restoration never mounts home while navigation is pending, and waits for the matching visible task',async()=>{
 const f=setup({workspacePath:'/project',taskId:'saved-task'}),navigation=deferred();
 const pending=mountCodexOriginalH5({...f.options,resolveNavigation:()=>navigation.promise});
 await Promise.resolve();assert.equal(f.mounts.length,0);
 navigation.resolve({workspacePath:'/project',initialTaskId:'saved-task',navigationIntent:'chat'});
 const control=await pending;
 assert.equal(f.mounts[0].props.initialTaskId,'saved-task');
 let ready=false;control.initialViewReady.then(()=>{ready=true});await Promise.resolve();assert.equal(ready,false);
 const reporter=control.switcher;
 await reporter.updateMobileTaskView(null);assert.equal(JSON.parse(f.saved).taskId,'saved-task');assert.equal(ready,false);
 await reporter.updateMobileTaskView({workspacePath:'/project',taskId:'different-task'});assert.equal(ready,false);
 await reporter.updateMobileTaskView({workspacePath:'/project',taskId:'saved-task'});await control.initialViewReady;
 assert.equal(ready,true);assert.equal(control.getContext().localMobileView.taskId,'saved-task');
 await reporter.updateMobileTaskView(null);assert.equal(f.saved,null,'real return-to-list still clears saved selection after startup');
 control.dispose();
});
test('intentional home and unavailable saved tasks do not wait for a task reporter',async()=>{
 for(const missing of [false,true]){
  const f=setup(missing?{workspacePath:'/project',taskId:'removed'}:null);
  const control=await mountCodexOriginalH5({...f.options,...(missing?{resolveNavigation:async()=>{throw Error('removed')}}:{})});
  await control.initialViewReady;assert.equal(control.getContext().initialTaskId,undefined);assert.equal(f.saved,null);control.dispose();
 }
});
test('disposal releases a startup wait without preserving event listeners',async()=>{
 const f=setup({workspacePath:'/project',taskId:'saved-task'}),control=await mountCodexOriginalH5(f.options);
 control.dispose();await control.initialViewReady;
});

function mobileLifecycle(t){
 const names=['addEventListener','removeEventListener','document','history'];
 const original=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const events=new EventTarget(),document=new EventTarget();document.visibilityState='visible';
 const history={state:{zcodeMobilePage:'chat'},replaceState(value){this.state=value}};
 Object.assign(globalThis,{addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events),document,history});
 t.after(()=>{for(const name of names){if(original[name])Object.defineProperty(globalThis,name,original[name]);else delete globalThis[name]}});
 return {events,document,history};
}
test('mobile pagehide without beforeunload keeps the task instead of refreshing into a new draft',async t=>{
 const env=mobileLifecycle(t),f=setup({workspacePath:'/project',taskId:'saved-task'});
 const control=await mountCodexOriginalH5(f.options);t.after(()=>control.dispose());
 await control.switcher.updateMobileTaskView({workspacePath:'/project',taskId:'saved-task'});await control.initialViewReady;
 env.events.addEventListener('pagehide',()=>control.switcher.updateMobileTaskView(null));
 env.events.dispatchEvent(new Event('pagehide'));
 assert.equal(JSON.parse(f.saved).taskId,'saved-task');assert.equal(env.history.state.codexMobileView.taskId,'saved-task');
 control.dispose();const reloaded=await mountCodexOriginalH5(f.options);t.after(()=>reloaded.dispose());
 assert.equal(reloaded.getContext().initialTaskId,'saved-task');
});
test('hidden and freeze cleanup preserve the page; pageshow followed by real list navigation clears it',async t=>{
 const env=mobileLifecycle(t),f=setup({workspacePath:'/project',taskId:'saved-task'});
 const control=await mountCodexOriginalH5(f.options);t.after(()=>control.dispose());
 await control.switcher.updateMobileTaskView({workspacePath:'/project',taskId:'saved-task'});
 env.document.visibilityState='hidden';env.history.state.zcodeMobilePage='home';
 await control.switcher.updateMobileTaskView(null);assert.equal(JSON.parse(f.saved).taskId,'saved-task');
 env.document.visibilityState='visible';env.document.dispatchEvent(new Event('freeze'));
 await control.switcher.updateMobileTaskView(null);assert.equal(JSON.parse(f.saved).taskId,'saved-task');
 env.events.dispatchEvent(new Event('pageshow'));
 await control.switcher.updateMobileTaskView(null);assert.equal(f.saved,null);assert.equal(env.history.state.codexMobileView.kind,'home');
 control.dispose();const reloaded=await mountCodexOriginalH5(f.options);t.after(()=>reloaded.dispose());
 assert.equal(reloaded.getContext().initialTaskId,undefined,'refreshing the real list must stay at the list');
});
test('visible chat cleanup cannot erase its selection and history recovers a missing storage entry',async t=>{
 const env=mobileLifecycle(t),f=setup({workspacePath:'/project',taskId:'saved-task'});
 const control=await mountCodexOriginalH5(f.options);t.after(()=>control.dispose());
 await control.switcher.updateMobileTaskView({workspacePath:'/project',taskId:'saved-task'});
 await control.switcher.updateMobileTaskView(null);assert.equal(JSON.parse(f.saved).taskId,'saved-task');
 f.options.viewStorage.removeItem('codex-mobile-current-view-v1');assert.equal(f.saved,null);
 control.dispose();const reloaded=await mountCodexOriginalH5(f.options);t.after(()=>reloaded.dispose());
 assert.equal(reloaded.getContext().initialTaskId,'saved-task');
});
test('a temporary restore failure preserves selection and is retryable; a removed task returns to the list',async t=>{
 const env=mobileLifecycle(t),f=setup({workspacePath:'/project',taskId:'saved-task'});
 await assert.rejects(mountCodexOriginalH5({...f.options,resolveNavigation:async()=>{throw Object.assign(Error('offline'),{status:503})}}),/offline/);
 assert.equal(JSON.parse(f.saved).taskId,'saved-task');
 const control=await mountCodexOriginalH5({...f.options,resolveNavigation:async()=>{throw Object.assign(Error('removed'),{status:404})}});t.after(()=>control.dispose());
 assert.equal(control.getContext().initialTaskId,undefined);assert.equal(f.saved,null);assert.equal(env.history.state.zcodeMobilePage,'home');
});
