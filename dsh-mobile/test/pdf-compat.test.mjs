import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {installPdfCompatibility,patchPdfCompatibility} from '../backend/pdf-compat.mjs';

test('PDF APIs work in an iOS realm missing iterator helpers, Promise.try and base64',async()=>{
 const result=await runInNewContext(`(async()=>{
   delete globalThis.Iterator; delete Promise.try;
   const proto=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
   for(const name of ['some','find','filter','map','join','toArray']) delete proto[name];
   (${installPdfCompatibility.toString()})();
   let closed=false;
   function* values(){try{yield 1;yield 2;yield 3;}finally{closed=true;}}
   const found=values().some(n=>n===2);
   const rejected=await Promise.try(()=>{throw Error('pdf');}).then(()=>false,e=>e.message==='pdf');
   return JSON.stringify({found,closed,rejected,values:new Map([[1,'a'],[2,'b']]).values().filter(v=>v==='b').toArray(),bytes:Array.from(Uint8Array.fromBase64(new Uint8Array([0,128,255]).toBase64()))});
 })()`,{atob,btoa});
 assert.deepEqual(JSON.parse(result),{found:true,closed:true,rejected:true,values:['b'],bytes:[0,128,255]});
});

test('PDF compatibility is installed before both renderer and Worker code',()=>{
 const code=patchPdfCompatibility('factory: (require) => {\nnew Blob([_dsh_pdf_worker_default, "ready"])}');
 assert.equal(code.split('installPdfCompatibility').length,3);
 assert.ok(code.indexOf('installPdfCompatibility')<code.indexOf('new Blob'));
 assert.throws(()=>patchPdfCompatibility('unknown build'),/review iOS compatibility/);
});
test('older Safari Map caches reuse promises, including cached undefined; worker byte/font APIs work',async()=>{
 const result=await runInNewContext(`(async()=>{
  for(const p of [Map.prototype,WeakMap.prototype])for(const key of ['getOrInsert','getOrInsertComputed'])delete p[key];
  delete Math.sumPrecise;delete Uint8Array.prototype.toHex;delete RegExp.escape;delete Set.prototype.intersection;
  (${installPdfCompatibility.toString()})();
  const map=new Map([['empty',undefined]]);let calls=0;const load=()=>{calls++;return Promise.resolve('page');};
  const first=map.getOrInsertComputed('page',load),second=map.getOrInsertComputed('page',load);
  map.getOrInsertComputed('empty',load);const key={},weak=new WeakMap();weak.getOrInsertComputed(key,()=>42);
  const sums=[[1e16,1,-1e16],[1e308,1e308,-1e308],[Number.MIN_VALUE,Number.MIN_VALUE],[-0,-0],[]].map(v=>Math.sumPrecise(v));
  return {same:first===second,calls,undefinedPreserved:map.has('empty')&&map.get('empty')===undefined,weak:weak.get(key),hex:new Uint8Array([0,128,255]).toHex(),sums,negativeZero:Object.is(sums[3],-0),matches:new RegExp('^'+RegExp.escape('a-b.[x] /')+'$','u').test('a-b.[x] /'),intersection:[...new Set([1,2]).intersection(new Set([2,3]))]};
 })()`,{atob,btoa});
 assert.equal(result.same,true);assert.equal(result.calls,1);assert.equal(result.undefinedPreserved,true);assert.equal(result.weak,42);assert.equal(result.hex,'0080ff');
 assert.deepEqual(Array.from(result.sums),[1,1e308,Number.MIN_VALUE*2,-0,-0]);assert.ok(result.negativeZero);assert.ok(result.matches);assert.deepEqual(Array.from(result.intersection),[2]);
});
