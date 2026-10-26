import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { nativeImageRoots, serveNativeMedia } from '../native-media.mjs';

const reference={threadId:'fixture-thread',turnId:'fixture-turn',itemId:'fixture-item',index:1};
async function server(t,read){const app=http.createServer((req,res)=>serveNativeMedia({read},new URL(req.url,'http://localhost').searchParams,res));app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>new Promise(resolve=>app.close(resolve)));return'http://127.0.0.1:'+app.address().port;}

test('native image roots require the exact selected native field, never prose or query paths',()=>{
  const sourcePath='/outside-workspace/selected.png',item={id:reference.itemId,type:'userMessage',content:[{type:'text',text:'Files mentioned: '+sourcePath},{type:'localImage',path:sourcePath}]};
  assert.deepEqual(nativeImageRoots(reference,{item,sourcePath}),['/outside-workspace']);
  assert.deepEqual(nativeImageRoots(reference,{item,sourcePath:'/outside-workspace/other.png'}),[]);
  assert.deepEqual(nativeImageRoots({...reference,index:0},{item,sourcePath}),[]);
  assert.deepEqual(nativeImageRoots({...reference,path:sourcePath},{item,sourcePath}),[]);
  assert.deepEqual(nativeImageRoots(reference,{item:{...item,id:'other'},sourcePath}),[]);
  const generated={id:reference.itemId,type:'imageGeneration',status:'inProgress',savedPath:sourcePath};
  assert.deepEqual(nativeImageRoots({...reference,index:0},{item:generated,sourcePath}),[]);
  assert.deepEqual(nativeImageRoots({...reference,index:0},{item:{...generated,status:'completed'},sourcePath}),['/outside-workspace']);
});

test('native media HTTP rejects missing, duplicate or widened references before reading history',async t=>{
  let calls=0;const base=await server(t,async()=>{calls++;throw Error('unexpected read');});
  for(const suffix of ['threadId=t&turnId=u&itemId=i','threadId=t&turnId=u&itemId=i&index=','threadId=t&turnId=u&itemId=i&index=01','threadId=t&turnId=u&itemId=i&index=0&path=/private/image.png','threadId=t&turnId=u&itemId=i&index=0&index=1']){
    const response=await fetch(base+'/?'+suffix);assert.equal(response.status,400);const body=await response.json();assert.equal(body.reason,'INVALID_REFERENCE');assert.equal(body.reference,null);
  }
  assert.equal(calls,0);
});

test('native media HTTP streams original bytes and returns only fixed failure reasons',async t=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);let mode='ready';
  const base=await server(t,async ref=>{assert.deepEqual(ref,reference);if(mode==='throw')throw Error('/home/demo/hidden.png');if(mode==='permission')return{status:'unresolved',reason:'PERMISSION_REQUIRED',message:'/home/demo/hidden.png'};return{status:'ready',body:bytes,headers:{'Content-Type':'image/png','Content-Length':bytes.length,'Cache-Control':'private, no-store'}};});
  const url=base+'/?'+new URLSearchParams(reference);let response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  mode='permission';response=await fetch(url);assert.equal(response.status,423);let body=await response.json();assert.equal(body.permissionRequired,true);assert.doesNotMatch(JSON.stringify(body),/\/Users\//);assert.equal(response.headers.get('cache-control'),'no-store');
  mode='throw';response=await fetch(url);assert.equal(response.status,503);body=await response.json();assert.equal(body.reason,'MEDIA_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(body),/\/Users\//);
});
