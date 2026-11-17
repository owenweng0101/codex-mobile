import test from 'node:test';
import assert from 'node:assert/strict';
import {returnCodexHome} from '../codex-entry.mjs';
import {mountCodexOriginalH5} from '../frontend-stage/browser-adapter.mjs';
function storage(){const values=new Map([['codex-mobile-current-view-v1',JSON.stringify({workspacePath:'/work',taskId:'broken'})],['composer-draft','unsent'],['other-tab-state','untouched']]);return{values,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:()=>assert.fail('home must not remove stored data'),clear:()=>assert.fail('home must not clear storage')};}

test('return home changes only the navigation checkpoint and preserves draft/history data',()=>{
 const store=storage(),history={state:{codexMobileView:{kind:'task',taskId:'broken'},zcodeMobilePage:'chat',unrelated:{draft:'keep'}},replaceState(value){this.state=value;}};let reloads=0;
 assert.equal(returnCodexHome({storage:store,history,reload:()=>reloads++}),true);
 assert.deepEqual(JSON.parse(store.getItem('codex-mobile-current-view-v1')),{kind:'home'});
 assert.equal(store.getItem('composer-draft'),'unsent');assert.equal(store.getItem('other-tab-state'),'untouched');
 assert.deepEqual(history.state.codexMobileView,{kind:'home'});assert.equal(history.state.zcodeMobilePage,'home');assert.deepEqual(history.state.unrelated,{draft:'keep'});assert.equal(reloads,1);
});

test('return home can use history when storage is unavailable but does not reload into a loop if both writes fail',()=>{
 const blocked={setItem(){throw Error('blocked');}},history={state:{keep:1},replaceState(value){this.state=value;}};let reloads=0;
 assert.equal(returnCodexHome({storage:blocked,history,reload:()=>reloads++}),true);assert.equal(history.state.keep,1);assert.equal(reloads,1);
 assert.throws(()=>returnCodexHome({storage:blocked,history:{replaceState(){throw Error('blocked');}},reload:()=>reloads++}),/无法保存首页位置/);assert.equal(reloads,1);
});

test('explicit home checkpoint wins over a stale failed-task history entry without restoring/deleting the task',async t=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'history'),store=storage();store.setItem('codex-mobile-current-view-v1',JSON.stringify({kind:'home'}));
 Object.defineProperty(globalThis,'history',{configurable:true,writable:true,value:{state:{zcodeMobilePage:'chat',codexMobileView:{kind:'task',workspacePath:'/work',taskId:'broken'}},replaceState(value){this.state=value;}}});
 t.after(()=>{if(old)Object.defineProperty(globalThis,'history',old);else delete globalThis.history;});
 let mounts=0;const controller=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount:()=>mounts++},services:{},info:{authenticated:true,workspaces:[{path:'/work'}],initialWorkspaceAbsPath:'/work'},viewStorage:store,resolveNavigation:async()=>assert.fail('returning home must not re-read the failed task')});
 await controller.initialViewReady;assert.equal(controller.getContext().initialTaskId,undefined);assert.equal(mounts,1);assert.equal(store.getItem('composer-draft'),'unsent');controller.dispose();
});
