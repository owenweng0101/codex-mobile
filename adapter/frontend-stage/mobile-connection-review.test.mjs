import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {connectMobileServices} from '../mobile-connection.mjs';
import {mountCodexOriginalH5} from './browser-adapter.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition did not settle');};
const raw=revision=>({modelSelectionService:{getView:async()=>({revision})}});
function socket(options){return{readyState:1,closes:0,close(){this.closes++;if(this.readyState===3)return;this.readyState=3;queueMicrotask(()=>options.onClose({code:1006}));}};}

test('simultaneous reconnect and resume signals share one handshake',async()=>{
 const records=[],views=[],gate=deferred(),environment=new EventTarget();environment.document={visibilityState:'visible'};
 const connection=await connectMobileServices({environment,url:'wss://fixture.invalid/ws',retryDelayMs:1,connectTimeoutMs:1000,onServices:services=>views.push(services),connect:(_url,options)=>{const value={options,socket:socket(options)};records.push(value);options.onCreateSocket(value.socket);return records.length===1?raw(1):gate.promise;}});
 try{
  connection.reconnect();const signals=Array.from({length:10},()=>connection.resume());environment.dispatchEvent(new Event('online'));await Promise.all(signals);await tick();assert.equal(records.length,2);
  gate.resolve(raw(2));await until(()=>views.length===2);assert.equal((await views[1].modelSelectionService.getView()).revision,2);
 }finally{connection.dispose();}
});

test('dispose fences a reconnect whose socket is created and resolves later',async()=>{
 const records=[],views=[],gate=deferred();
 const connection=await connectMobileServices({environment:{},url:'wss://fixture.invalid/ws',retryDelayMs:1,connectTimeoutMs:1000,onServices:services=>views.push(services),connect:(_url,options)=>{records.push(options);if(records.length===1){options.onCreateSocket(socket(options));return raw(1);}return gate.promise;}});
 connection.reconnect();await until(()=>records.length===2);connection.dispose();const late=socket(records[1]);records[1].onCreateSocket(late);gate.resolve(raw(2));await tick();await tick();
 assert.equal(views.length,1);assert.equal(late.readyState,3);assert(late.closes>=1);assert.equal(records.length,2);
});

test('timed-out reconnect cannot replace a later healthy connection',async()=>{
 const records=[],views=[],gate=deferred();
 const connection=await connectMobileServices({environment:{},url:'wss://fixture.invalid/ws',retryDelayMs:1,maxRetryDelayMs:1,connectTimeoutMs:10,onServices:services=>views.push(services),connect:(_url,options)=>{const value={options,socket:socket(options)};records.push(value);options.onCreateSocket(value.socket);return records.length===2?gate.promise:raw(records.length);}});
 try{
  connection.reconnect();await until(()=>records.length===3&&views.length===2);assert.equal(records[1].socket.readyState,3);
  gate.resolve(raw(2));await tick();await tick();assert.equal(views.length,2);assert.equal((await views[1].modelSelectionService.getView()).revision,3);
 }finally{connection.dispose();}
});

test('service replacement keeps the navigation owner and obtains fresh service reads',async()=>{
 const mounts=[];const controller=await mountCodexOriginalH5({compat:{__codexOriginalPlatform:()=>({}),__codexOriginalMount:mount=>mounts.push(mount)},services:raw(1),info:{authenticated:true,initialTaskId:'selected',workspaces:[{path:'/fixture'}]},resolveNavigation:async()=>({workspacePath:'/fixture'})});
 try{
  const owner=mounts.at(-1).props.webRemoteControlWorkspaceSwitcher,key=mounts.at(-1).key;
  controller.setTransportState('connecting');controller.replaceServices(raw(2));controller.setTransportState('paired');
  assert.equal(mounts.at(-1).props.webRemoteControlWorkspaceSwitcher,owner);assert.equal(mounts.at(-1).key,key);
  await owner.updateMobileViewState('/fixture',undefined);assert.equal(controller.getContext().initialTaskId,'selected');
  assert.equal((await mounts.at(-1).services.modelSelectionService.getView()).revision,2);
 }finally{controller.dispose();}
});

test('canonical mount updates the original transport store before rendering without resetting it on equal state',async()=>{
 const bundle=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
 const stateStart=bundle.indexOf('var J6=`idle`,Y6=new Set;'),stateEnd=bundle.indexOf('function zNn(',stateStart);
 assert(stateStart>=0&&stateEnd>stateStart);
 const state=vm.runInNewContext(bundle.slice(stateStart,stateEnd)+';({INn,LNn,RNn})');let notifications=0;const unsubscribe=state.INn(()=>notifications++),states=[];
 const start=bundle.indexOf('function __codexOriginalMount('),end=bundle.indexOf('export{',start);assert(start>=0&&end>start);
 const mount=vm.runInNewContext('('+bundle.slice(start,end)+')',{document:{},RNn:state.RNn,K9:{render(){states.push(state.LNn());}},$:{jsx:(_type,props)=>props},C2:'root',_o:'settings',U5n:'shell'});
 for(const value of ['connecting','paired','paired'])mount({services:{},props:{webRemoteControlTerminalTransportState:value}});
 assert.deepEqual(states,['connecting','paired','paired']);assert.equal(notifications,2);unsubscribe();
});
