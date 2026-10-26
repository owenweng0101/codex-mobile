import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createImagePreviewer} from '../mobile-image.mjs';
const tiny=Buffer.from([255,216,255,1]);
const image=value=>{const bytes=Buffer.alloc(2*1024*1024,value);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);return bytes;};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail('condition did not settle');};
const metadata={stdout:'pixelWidth: 800\npixelHeight: 480\nhasAlpha: no'};

test('three busy image previews queue within the same concurrency budget instead of forwarding the third original',async()=>{
 const gate=deferred();let active=0,peak=0,calls=0,thirdDone=false;
 const preview=createImagePreviewer({run:async(_binary,args)=>{
  if(args.includes('--out')){await writeFile(args.at(-1),tiny);return{stdout:''};}
  calls++;active++;peak=Math.max(peak,active);await gate.promise;active--;return metadata;
 }});
 const first=preview(image(1),'image/png'),second=preview(image(2),'image/png');await until(()=>calls===2);
 const third=preview(image(3),'image/png').then(value=>{thirdDone=true;return value;});await tick();
 assert.equal(thirdDone,false);assert.equal(preview.cacheInfo().queued,1);assert.equal(preview.cacheInfo().active,2);
 gate.resolve();const results=await Promise.all([first,second,third]);assert(results.every(value=>value.bytes.length===tiny.length));assert.equal(calls,3);assert.equal(peak,2);
 assert.equal(preview.cacheInfo().inflight,0);assert.equal(preview.cacheInfo().queued,0);
});

test('a transient conversion failure does not permanently cache an uncompressed original',async()=>{
 let calls=0;const preview=createImagePreviewer({run:async(_binary,args)=>{
  calls++;if(calls===1)throw Error('transient conversion failure');
  if(args.includes('--out')){await writeFile(args.at(-1),tiny);return{stdout:''};}return metadata;
 }}),original=image(1);
 assert.equal((await preview(original,'image/png')).bytes,original);assert.equal(preview.cacheInfo().entries,0);
 assert.equal((await preview(original,'image/png')).bytes.length,tiny.length);assert.equal(calls,3);
 await preview(original,'image/png');assert.equal(calls,3);
});

test('preview waiting has bounded queue length and releases all slots after completion',async()=>{
 const gate=deferred();const preview=createImagePreviewer({run:async(_binary,args)=>{
  if(args.includes('--out')){await writeFile(args.at(-1),tiny);return{stdout:''};}await gate.promise;return metadata;
 }});
 const pending=Array.from({length:6},(_,i)=>preview(image(i+1),'image/png'));await until(()=>preview.cacheInfo().active===2&&preview.cacheInfo().queued===4);
 const overflow=image(9);assert.equal((await preview(overflow,'image/png')).bytes,overflow);assert.equal(preview.cacheInfo().queued,4);
 gate.resolve();await Promise.all(pending);assert.equal(preview.cacheInfo().active,0);assert.equal(preview.cacheInfo().queued,0);
});

test('conversion deadline includes time spent waiting for a slot',async()=>{
 let calls=0,queuedBudget;
 const preview=createImagePreviewer({timeoutMs:80,maxConcurrent:1,run:async(_binary,args,options)=>{
  if(args.includes('--out'))throw Error('must time out before conversion');
  calls++;if(calls===2)queuedBudget=options.timeout;
  return new Promise((_,reject)=>{if(options.signal.aborted)return reject(options.signal.reason);options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
 }});
 const first=preview(image(1),'image/png');await until(()=>calls===1);
 await new Promise(r=>setTimeout(r,15));const second=preview(image(2),'image/png');await Promise.all([first,second]);
 if(calls===2)assert(queuedBudget<60,'the queued conversion must only receive its remaining budget');
 assert.equal(preview.cacheInfo().entries,0);assert.equal(preview.cacheInfo().active,0);assert.equal(preview.cacheInfo().queued,0);
});
