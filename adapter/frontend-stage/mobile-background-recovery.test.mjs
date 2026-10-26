import test from 'node:test';
import assert from 'node:assert/strict';
import {connectMobileServices} from '../mobile-connection.mjs';
test('a disconnected hidden or offline page waits for visibility and network instead of rebuilding services in the background',async()=>{
 const environment=new EventTarget();environment.document=new EventTarget();environment.document.visibilityState='visible';environment.navigator={onLine:true};const sockets=[],views=[];
 const connection=await connectMobileServices({environment,retryDelayMs:1,onServices:services=>views.push(services),connect:async(_url,options)=>{
  const socket={readyState:1,close(){if(this.readyState===3)return;this.readyState=3;options.onClose();}};sockets.push(socket);options.onCreateSocket(socket);return{modelSelectionService:{getView:async()=>({revision:sockets.length})}};
 }});
 try{
  environment.document.visibilityState='hidden';sockets[0].close();await new Promise(r=>setTimeout(r,15));assert.equal(sockets.length,1);
  environment.navigator.onLine=false;environment.document.visibilityState='visible';environment.document.dispatchEvent(new Event('visibilitychange'));await new Promise(r=>setTimeout(r,15));assert.equal(sockets.length,1);
  environment.navigator.onLine=true;environment.dispatchEvent(new Event('online'));await new Promise(r=>setImmediate(r));assert.equal(sockets.length,2);assert.equal(views.length,2);assert.equal((await views.at(-1).modelSelectionService.getView()).revision,2);
 }finally{connection.dispose();}
});
for(const mode of ['hidden','offline'])test('a queued reconnect rechecks '+mode+' state before opening a socket',async()=>{
 const environment=new EventTarget();environment.document=new EventTarget();environment.document.visibilityState='visible';environment.navigator={onLine:true};const sockets=[];
 const connection=await connectMobileServices({environment,retryDelayMs:20,maxRetryDelayMs:20,connect:async(_url,options)=>{
  const socket={readyState:1,close(){if(this.readyState===3)return;this.readyState=3;options.onClose();}};sockets.push(socket);options.onCreateSocket(socket);return{};
 }});
 try{
  sockets[0].close();if(mode==='hidden')environment.document.visibilityState='hidden';else environment.navigator.onLine=false;
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(sockets.length,1);
  environment.document.visibilityState='visible';environment.navigator.onLine=true;environment.dispatchEvent(new Event('online'));await new Promise(resolve=>setImmediate(resolve));assert.equal(sockets.length,2);
 }finally{connection.dispose();}
});
