import test from 'node:test';
import assert from 'node:assert/strict';
import {installImageRecovery} from '../image-recovery.mjs';
const observers=[];
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.IntersectionObserver=class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}unobserve(){}disconnect(){}};
function harness(request){
 const buttons=[];const doc=new EventTarget();doc.hidden=false;doc.documentElement={};doc.head={append(){}};
 doc.createElement=()=>{const b=new EventTarget();b.style={};b.setAttribute=()=>{};b.remove=()=>{const index=buttons.indexOf(b);if(index>=0)buttons.splice(index,1);};return b;};
 const win=new EventTarget();Object.assign(win,{innerWidth:393,innerHeight:852,location:{href:'http://localhost/',origin:'http://localhost'}});
 const stop=installImageRecovery({doc,win,request,retryDelay:5});
 const make=index=>({tagName:'IMG',isConnected:true,dataset:{},getAttribute:()=>'/mobile/api/image?threadId=t&turnId=u&itemId=i&index='+index,getBoundingClientRect:()=>({top:10,bottom:50,left:0,right:50}),parentElement:{insertAdjacentElement(_where,b){buttons.push(b);}}});
 const fail=image=>{const e=new Event('error');Object.defineProperty(e,'target',{value:image});doc.dispatchEvent(e);};
 return{doc,win,buttons,stop,make,fail,observer:observers.at(-1)};
}
async function until(predicate){const deadline=Date.now()+1000;while(!predicate()){if(Date.now()>deadline)throw Error('Recovery did not settle');await new Promise(r=>setTimeout(r,2));}}
const good=()=>new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}});
test('permanent failure stops automatic work; manual retry recovers without reopening the conversation',async()=>{
 let calls=0,allow=false;const f=harness(async()=>{calls++;return allow?good():new Response('',{status:404});});
 try{
  const image=f.make(0);f.fail(image);await until(()=>f.buttons[0]?.textContent.includes('不存在'));
  f.observer.callback([{target:image,isIntersecting:true}]);f.win.dispatchEvent(new Event('online'));await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);
  allow=true;f.buttons[0].dispatchEvent(new Event('click'));await until(()=>image.src?.startsWith('blob:'));assert.equal(calls,2);assert.equal(f.buttons.length,0);
 }finally{f.stop();}
});
test('visible-image recovery caps concurrency, deduplicates errors and stops retrying after three attempts',async()=>{
 let active=0,peak=0,calls=0;const f=harness(async()=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return new Response('',{status:503});});
 try{
  const images=Array.from({length:5},(_,i)=>f.make(i));for(const image of images){f.fail(image);f.fail(image);}
  await until(()=>calls===15&&active===0);await new Promise(r=>setTimeout(r,30));assert.equal(peak,3);assert.equal(calls,15);assert.equal(f.buttons.length,5);
 }finally{f.stop();}
});
