import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const bundle=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
function fixture(switchWorkspace){
 const events=[];
 const source=bundle.slice(bundle.indexOf('async function Yxt('),bundle.indexOf('function Xxt('));
 const open=runInNewContext(source+';Yxt',{__CODEX_ORIGINAL_BRIDGE__:{codexBridge:true},rr:e=>e.workspaceIdentity||e.workspacePath,qxt:e=>e.taskId,J:{info(){},error(){},warn(){}},Jxt:()=>false});
 const args={activeWorkspacePath:'/one',task:{workspacePath:'/two',taskId:'test'},switcher:{switchWorkspace},onSwitchingChange:v=>events.push(['loading',v]),setSwitchingTaskKey:v=>events.push(['target',v]),onTaskOpen:v=>events.push(['open',v.crossWorkspace]),setError:v=>events.push(['error',v]),onNavigateToChat:()=>events.push(['chat'])};
 return {events,run:()=>open(args)};
}
test('cross-workspace navigation keeps loading until resolved, then enters chat and clears overlay on every visit',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>{resolve=r}));
 for(let i=0;i<2;i++){
  const pending=f.run();assert.deepEqual(f.events.at(-3),['loading',true]);assert(!f.events.slice(-4).some(e=>e[0]==='chat'));
  resolve();await pending;
  assert.deepEqual(f.events.slice(-4),[['target',null],['loading',false],['open',false],['chat']]);
 }
});
test('failed navigation clears loading but does not pretend the chat opened',async()=>{
 const f=fixture(async()=>{throw Error('offline')});await f.run();
 assert(f.events.some(e=>e[0]==='loading'&&e[1]===false));assert(!f.events.some(e=>e[0]==='chat'));assert.deepEqual(f.events.at(-1),['error','offline']);
});
