import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHistoryOverlayReader} from '../desktop-bridge.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}){
 t.mock.timers.enable({apis:['setTimeout']});
 let now=0;const reads=[],cache=new Map(),stale=new Set(),changes=[],gates=new Map();
 const reader=createHistoryOverlayReader({read:id=>{reads.push(id);const gate=deferred();gates.set(id,gate);return gate.promise;},cached:id=>cache.get(id)||null,accept:(id,value)=>{cache.set(id,value);stale.delete(id);},failed:id=>{if(cache.has(id))stale.add(id);},changed:id=>changes.push(id),now:()=>now,...options});
 t.after(()=>reader.dispose());
 return{reader,reads,cache,stale,changes,gates,tick(ms){now+=ms;t.mock.timers.tick(ms);}};
}
test('display soft deadline returns unconfirmed raw fallback while one native read continues',async t=>{
 const f=fixture(t);f.cache.set('a',{activeTurn:'old-running'});
 const a=f.reader.get('a'),b=f.reader.get('a');await flush();assert.deepEqual(f.reads,['a']);
 f.tick(80);const first=await a;assert.deepEqual(first,{history:{activeTurn:'old-running'},confirmed:false});assert.deepEqual(await b,first);
 assert.equal(f.reader.size,1);assert.deepEqual(f.changes,[]);
 f.gates.get('a').resolve({activeTurn:'current-running'});await flush();
 assert.deepEqual(f.changes,['a']);assert.equal(f.stale.has('a'),false);assert.equal(f.cache.get('a').activeTurn,'current-running');
 assert.equal(first.confirmed,false,'late success never elevates the earlier result');assert.equal(first.history.activeTurn,'old-running');
});
test('fast native success returns current confirmed state without redundant changed notification',async t=>{
 const f=fixture(t),p=f.reader.get('a');await flush();f.gates.get('a').resolve({activeTurn:'running'});
 assert.deepEqual(await p,{history:{activeTurn:'running'},confirmed:true});assert.deepEqual(f.changes,[]);
});
test('late failure is handled and cooldown suppresses reads until recovery is allowed',async t=>{
 const f=fixture(t),p=f.reader.get('a');await flush();f.tick(80);assert.equal((await p).history,null);
 f.gates.get('a').reject(Error('native timeout'));await flush();
 assert.deepEqual(await f.reader.get('a'),{history:null,confirmed:false});assert.deepEqual(f.reads,['a']);
 f.tick(1999);assert.equal((await f.reader.get('a')).history,null);assert.equal(f.reads.length,1);
 f.tick(1);const retry=f.reader.get('a');await flush();assert.equal(f.reads.length,2);f.gates.get('a').resolve({activeTurn:null});
 assert.deepEqual(await retry,{history:{activeTurn:null},confirmed:true});
});
test('thread isolation prevents one delayed native result from satisfying another request',async t=>{
 const f=fixture(t),a=f.reader.get('a'),b=f.reader.get('b');await flush();f.gates.get('a').resolve({activeTurn:'a-turn'});
 assert.equal((await a).history.activeTurn,'a-turn');f.tick(80);assert.deepEqual(await b,{history:null,confirmed:false});
 f.gates.get('b').resolve({activeTurn:'b-turn'});await flush();assert.equal(f.cache.get('a').activeTurn,'a-turn');assert.equal(f.cache.get('b').activeTurn,'b-turn');assert.deepEqual(f.changes,['b']);
});
test('no-owner result also cools down, pending entries are bounded and disposal ignores late state',async t=>{
 const f=fixture(t,{maxEntries:1}),a=f.reader.get('a');await flush();assert.equal((await f.reader.get('b')).history,null);assert.deepEqual(f.reads,['a']);assert.equal(f.reader.size,1);
 f.gates.get('a').resolve(null);assert.equal((await a).history,null);assert.equal((await f.reader.get('a')).history,null);assert.equal(f.reads.length,1);
 const b=f.reader.get('b');await flush();assert.deepEqual(f.reads,['a','b']);assert.equal(f.reader.size,1);
 f.reader.dispose();f.gates.get('b').resolve({activeTurn:'late'});assert.deepEqual(await b,{history:null,confirmed:false});assert.equal(f.reader.size,0);assert.equal(f.cache.has('b'),false);assert.deepEqual(f.changes,[]);
});
test('server soft reader is scoped only to history-window, preserving native write verification',async()=>{
 const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
 const window=source.slice(source.indexOf('async function historyWindow('),source.indexOf('async function history(id, cursor)'));
 assert.match(window,/historyOverlay\.get\(id\)/);assert.equal(source.split('historyOverlay.get(id)').length-1,1);
 assert.match(source,/read:id=>desktop\.history\(id,\{timeout:1200\}\)/);
 assert.match(source,/async function nativeForOperation\(id\)[\s\S]*?ensureDesktopOwner[\s\S]*?desktopSnapshotForOperation\(\(\)=>desktop\.snapshot\(id,\{fresh:true,timeout:15000\}\)\)/);
});
