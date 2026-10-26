import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMobileApi} from '../mobile-api.mjs';
import {createIngress} from '../../connection/ingress.mjs';
const id='00000000-0000-0000-0000-000000000001',attachmentId='a'.repeat(48),tiny=Buffer.from([255,216,255,1]);
const route='/mobile/api/image?threadId='+id+'&attachmentId='+attachmentId;
const page=()=>({thread:{id,cwd:'/workspace'},turns:[{id:'turn-1',items:[{id:'item-1',type:'userMessage',content:[{type:'image',url:'/api/attachment?id='+attachmentId}]}]}]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail('condition did not settle');};
async function fixture(t,{get=async()=>page(),fetch:read=async()=>new Response(tiny,{headers:{'content-type':'image/jpeg'}}),onRequest=()=>{},...options}={}){
 const directory=await mkdtemp(join(tmpdir(),'cm-image-http-'));
 const api={origin:'http://127.0.0.1:8787',bearer:'private-test-credential',get,fetch:read};
 const handler=createMobileApi({api,baseServices:{project:{readTree:async()=>({tasks:[]})}},ledgerDir:directory,...options});
 const server=http.createServer((req,res)=>{onRequest(req.url,res);handler(req,res,new URL(req.url,'http://test'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port,request=(path,options)=>fetch(origin+path,options);request.origin=origin;request.server=server;return request;
}

test('chunked native images without Content-Length still receive bounded compressed previews',async t=>{
 const original=Buffer.alloc(2*1024*1024,1);let previews=0;
 const request=await fixture(t,{fetch:async()=>new Response(original,{headers:{'content-type':'image/png'}}),imagePreview:async(bytes,type)=>{previews++;assert.equal(bytes.length,original.length);assert.equal(type,'image/png');return{bytes:tiny,contentType:'image/jpeg'};}});
 const response=await request(route+'&preview=1');assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(tiny.length));assert.equal(response.headers.get('cache-control'),'private, max-age=300');assert.deepEqual(Buffer.from(await response.arrayBuffer()),tiny);assert.equal(previews,1);
});

test('image scope is checked before bytes or preview work and failures are never cacheable',async t=>{
 let fetches=0,previews=0;const request=await fixture(t,{get:async()=>({thread:{id,cwd:'/workspace'},turns:[]}),fetch:async()=>{fetches++;throw Error('must not fetch');},imagePreview:async()=>{previews++;throw Error('must not preview');}});
 const response=await request(route+'&preview=1');assert.equal(response.status,403);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(fetches,0);assert.equal(previews,0);
});

test('the image total deadline covers history lookup and late results cannot start a native byte fetch',async t=>{
 const gate=deferred();let reads=0,signal,fetches=0;
 const request=await fixture(t,{imageTimeoutMs:20,get:async(_path,options)=>{signal=options.signal;if(++reads===1)return gate.promise;return page();},fetch:async()=>{fetches++;return new Response(tiny,{headers:{'content-type':'image/jpeg'}});}});
 const failed=await request(route+'&preview=1');assert.equal(failed.status,504);assert.equal((await failed.json()).code,'MOBILE_IMAGE_TIMEOUT');assert.equal(signal.aborted,true);
 gate.resolve(page());await new Promise(r=>setImmediate(r));assert.equal(fetches,0);
 const retry=await request(route+'&preview=1');assert.equal(retry.status,200);await retry.arrayBuffer();assert.equal(fetches,1);
});

test('the image total deadline includes a stalled response body and aborts upstream work',async t=>{
 let aborted=false;
 const request=await fixture(t,{imageTimeoutMs:25,fetch:async(_url,options)=>new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(100));options.signal.addEventListener('abort',()=>{aborted=true;controller.error(options.signal.reason);},{once:true});}}),{headers:{'content-type':'image/png'}})});
 const response=await request(route+'&preview=1');assert.equal(response.status,504);assert.equal((await response.json()).code,'MOBILE_IMAGE_TIMEOUT');assert.equal(aborted,true);
});

test('closing a raw image response aborts its native byte stream',async t=>{
 let aborted=false;
 const request=await fixture(t,{fetch:async(_url,options)=>new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(100));options.signal.addEventListener('abort',()=>{aborted=true;controller.error(options.signal.reason);},{once:true});}}),{headers:{'content-type':'image/png'}})});
 const response=await request(route),reader=response.body.getReader();await reader.read();await reader.cancel();await until(()=>aborted);assert.equal(aborted,true);
});

test('unknown-length preview buffering has a strict maximum instead of growing without limit',async t=>{
 let previews=0;const request=await fixture(t,{fetch:async()=>new Response(Buffer.alloc(20*1024*1024+1),{headers:{'content-type':'image/png'}}),imagePreview:async()=>{previews++;return{bytes:tiny,contentType:'image/jpeg'};}});
 const response=await request(route+'&preview=1');assert.equal(response.status,413);assert.equal((await response.json()).code,'MOBILE_IMAGE_TOO_LARGE');assert.equal(previews,0);
});

test('same-page image authorization reads share native work while one cancelled response cannot cancel the others',async t=>{
 const gate=deferred();let reads=0,requests=0,closed=0,sharedSignal,fetches=0;
 const request=await fixture(t,{onRequest:(_url,res)=>{requests++;res.once('close',()=>closed++);},get:async(_path,options)=>{reads++;sharedSignal=options.signal;return gate.promise;},fetch:async()=>{fetches++;return new Response(tiny,{headers:{'content-type':'image/jpeg'}});}});
 const controller=new AbortController(),first=request(route+'&preview=1',{signal:controller.signal}),second=request(route+'&preview=1'),third=request(route+'&preview=1');
 const rejected=assert.rejects(first,error=>error.name==='AbortError');await until(()=>requests===3);assert.equal(reads,1);
 controller.abort();await rejected;await until(()=>closed===1);assert.equal(sharedSignal.aborted,false);
 gate.resolve(page());const responses=await Promise.all([second,third]);for(const response of responses){assert.equal(response.status,200);await response.arrayBuffer();}assert.equal(fetches,2);assert.equal(reads,1);
});

test('when every image consumer leaves the native history read aborts and a later request starts fresh',async t=>{
 const gate=deferred();let reads=0,requests=0,sharedSignal,fetches=0;
 const request=await fixture(t,{onRequest:()=>requests++,get:async(_path,options)=>{if(++reads===1){sharedSignal=options.signal;return gate.promise;}return page();},fetch:async()=>{fetches++;return new Response(tiny,{headers:{'content-type':'image/jpeg'}});}});
 const a=new AbortController(),b=new AbortController(),first=request(route+'&preview=1',{signal:a.signal}),second=request(route+'&preview=1',{signal:b.signal});
 const rejected=Promise.all([assert.rejects(first,error=>error.name==='AbortError'),assert.rejects(second,error=>error.name==='AbortError')]);await until(()=>requests===2);a.abort();b.abort();await rejected;await until(()=>sharedSignal.aborted);
 const retry=await request(route+'&preview=1');assert.equal(retry.status,200);await retry.arrayBuffer();assert.equal(reads,2);assert.equal(fetches,1);
 gate.resolve(page());await new Promise(r=>setImmediate(r));assert.equal(fetches,1);
});

test('a slow original-image download through the real ingress outlives the header budget without truncation',async t=>{
 const total=8*1024*1024;let nativeAborted=false;
 const request=await fixture(t,{imageTimeoutMs:100,imageIdleTimeoutMs:100,fetch:async(_url,{signal})=>{
  signal.addEventListener('abort',()=>nativeAborted=true,{once:true});
  // Native write-queue progress must cover a single large buffered source.
  return new Response(Buffer.alloc(total),{headers:{'content-type':'image/png','content-length':String(total)}});
 }});
 const origin='https://slow-image.invalid',gateway=createIngress({backend:request.origin});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));t.after(()=>gateway.close());
 const started=Date.now();let received=0;
 await new Promise((resolve,reject)=>{
  const client=http.get({host:'127.0.0.1',port:gateway.server.address().port,path:route,headers:{host:new URL(origin).host,origin}},response=>{
   response.on('data',chunk=>{received+=chunk.length;response.pause();setTimeout(()=>response.resume(),2);});response.on('end',resolve);response.on('error',reject);
  });client.on('error',reject);
 });
 assert(Date.now()-started>100);assert.equal(received,total);assert.equal(nativeAborted,false);
});

test('an original-image stream with no further progress aborts on its idle budget',async t=>{
 let aborted=false;
 const request=await fixture(t,{imageTimeoutMs:100,imageIdleTimeoutMs:25,fetch:async(_url,{signal})=>new Response(new ReadableStream({start(controller){
  controller.enqueue(Buffer.alloc(100));signal.addEventListener('abort',()=>{aborted=true;controller.error(signal.reason);},{once:true});
 }}),{headers:{'content-type':'image/png'}})});
 const response=await request(route);await assert.rejects(response.arrayBuffer());assert.equal(aborted,true);
});

test('completed original-image delivery removes its timeout listener without overriding HTTP keepalive',async t=>{
 let response,socket;
 const request=await fixture(t,{imageIdleTimeoutMs:30,onRequest:(_url,res)=>{response=res;socket=res.socket;}});
 const result=await request(route);await result.arrayBuffer();await until(()=>response.writableFinished&&response.listenerCount('timeout')===0);
 assert.equal(socket.timeout,request.server.keepAliveTimeout+(request.server.keepAliveTimeoutBuffer||0));
});
