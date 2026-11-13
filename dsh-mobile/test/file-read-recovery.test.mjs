import test from 'node:test';
import assert from 'node:assert/strict';
import {installFileReadRecovery} from '../backend/file-read-recovery.mjs';

const location=new URL('https://mobile.test/dsh/');
test('a transient file-read 502 replays the same RPC body and recovers; writes never replay',async()=>{
 const calls=[];const win={location,fetch:async(input,init)=>{
   const req=new Request(input,init);calls.push({url:req.url,body:await req.text()});
   return new Response('bytes',{status:calls.length===1?502:200});
 }};
 const release=installFileReadRecovery(win),body=JSON.stringify({rpcId:'read-1',method:'workspaceFiles/readBytes'});
 assert.equal((await win.fetch(new URL('api/workspaceFiles/readBytes',location),{method:'POST',body})).status,200);
 assert.equal(calls.length,2);assert.equal(calls[0].body,body);assert.equal(calls[1].body,body);
 calls.length=0;assert.equal((await win.fetch(new URL('api/workspaceFiles/write',location),{method:'POST',body:'write'})).status,502);assert.equal(calls.length,1);release();
});
test('permission and missing-file failures are not retried; cancellation stops recovery',async()=>{
 let calls=0;const controller=new AbortController();
 const win={location,fetch:async()=>{calls++;return new Response('',{status:403});}};
 const release=installFileReadRecovery(win),url=new URL('api/workspaceFiles/readBytes',location);
 assert.equal((await win.fetch(url,{method:'POST',body:'read'})).status,403);assert.equal(calls,1);
 release();win.fetch=async()=>{calls++;controller.abort();return new Response('',{status:502});};installFileReadRecovery(win);
 await assert.rejects(win.fetch(url,{method:'POST',body:'read',signal:controller.signal}),{name:'AbortError'});assert.equal(calls,2);
});
