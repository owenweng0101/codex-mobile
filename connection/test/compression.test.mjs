import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {brotliDecompressSync,gunzipSync} from 'node:zlib';
import {createIngress,createCompressionCache,preferredEncoding} from '../ingress.mjs';
const origin='https://compression.cn.cpolar.top',asset='/remote/v4/3.16.3/assets/index-BsmXQHMM.js';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const request=(port,path,headers={},method='GET')=>new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{host:new URL(origin).host,...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end();
});

test('compression negotiation respects disabled encodings and q preference',()=>{
 assert.equal(preferredEncoding('gzip, br'),'br');
 assert.equal(preferredEncoding('gzip;q=1, br;q=0.5'),'gzip');
 assert.equal(preferredEncoding('gzip;q=0, br;q=0'),null);
 assert.equal(preferredEncoding('*;q=1, br;q=0'),'gzip');
 assert.equal(preferredEncoding(),null);
});

test('public static code uses Brotli/cache but mutable same-URL updates and conditional ETags revalidate',async t=>{
 let revision=1,calls=0;const seen=[],cache=createCompressionCache();
 const source=()=>('export const revision='+revision+';\n').repeat(10000);
 const backend=http.createServer((req,res)=>{
  calls++;seen.push(req.headers);res.setHeader('etag','"revision-'+revision+'"');res.setHeader('cache-control','public, no-cache');res.setHeader('content-type','text/javascript');
  if(req.headers['if-none-match']==='"revision-'+revision+'"'){res.writeHead(304);res.end();return;}
  res.end(source());
 });
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp,compressionCache:cache});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);
 t.after(async()=>{await gateway.close();await new Promise(resolve=>backend.close(resolve));});
 const first=await request(port,asset,{'accept-encoding':'gzip, br'});
 assert.equal(first.headers['content-encoding'],'br');assert.equal(brotliDecompressSync(first.body).toString(),source());assert.match(first.headers.vary,/Accept-Encoding/);assert.equal(first.headers.etag,'W/"revision-1"');assert.equal(first.headers['cache-control'],'public, no-cache');assert.equal(cache.size,1);
 const repeat=await request(port,asset,{'accept-encoding':'br'});assert.deepEqual(repeat.body,first.body);assert.equal(cache.size,1);assert.equal(calls,2);
 const conditional=await request(port,asset,{'accept-encoding':'br','if-none-match':first.headers.etag});assert.equal(conditional.status,304);assert.equal(conditional.body.length,0);assert.equal(conditional.headers.etag,first.headers.etag);assert.match(conditional.headers.vary,/Accept-Encoding/);assert.equal(seen.at(-1)['if-none-match'],'"revision-1"');
 revision=2;const changed=await request(port,asset,{'accept-encoding':'br','if-none-match':first.headers.etag});assert.equal(changed.status,200);assert.equal(brotliDecompressSync(changed.body).toString(),source());assert.equal(changed.headers.etag,'W/"revision-2"');assert.notDeepEqual(changed.body,first.body);
 const gzip=await request(port,asset,{'accept-encoding':'gzip, br;q=0'});assert.equal(gzip.headers['content-encoding'],'gzip');assert.equal(gunzipSync(gzip.body).toString(),source());
 assert.ok(seen.every(headers=>headers['accept-encoding']==='identity'));
});

test('pairing/API data and cookie-bearing static responses never enter the compression cache',async t=>{
 const cache=createCompressionCache();let counter=0;
 const backend=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.setHeader('cache-control','public, max-age=31536000, immutable');res.setHeader('etag','"fixture"');if(req.url===asset)res.setHeader('set-cookie','codex_native_pair=fixture; HttpOnly');res.end(JSON.stringify({counter:++counter}));});
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp,compressionCache:cache});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);
 t.after(async()=>{await gateway.close();await new Promise(resolve=>backend.close(resolve));});
 for(const [path,method]of [['/api/server-info','GET'],['/api/pair','POST'],['/mobile/api/skills','GET'],['/mobile/api/queue','GET'],['/mobile/api/queue','POST'],['/mobile/api/upload','POST'],['/mobile/api/archive','POST'],[asset,'GET']]){
  const first=await request(port,path,{'accept-encoding':'br'},method),second=await request(port,path,{'accept-encoding':'br'},method);
  assert.equal(first.status,200);assert.equal(second.status,200);if(path!==asset)assert.equal(first.headers['cache-control'],'no-store');
  assert.notEqual(brotliDecompressSync(first.body).toString(),brotliDecompressSync(second.body).toString());assert.equal(cache.size,0);
 }
});

test('compressed cache deduplicates work and bounds pending plus stored bytes',async()=>{
 const cache=createCompressionCache({maxBytes:10,maxEntries:2});let complete,runs=0;
 const first=cache.encode('one',8,()=>{runs++;return new Promise(resolve=>{complete=resolve;});});
 assert.equal(cache.encode('one',8,()=>{throw Error('duplicate compression');}),first);assert.equal(cache.encode('two',8,()=>Buffer.alloc(1)),null);
 complete(Buffer.alloc(2));await first;assert.equal(runs,1);assert.equal(cache.bytes,2);
 await cache.encode('two',8,async()=>Buffer.alloc(4));assert.ok(cache.bytes<=10);assert.equal(cache.size,2);
 await cache.encode('three',8,async()=>Buffer.alloc(3));assert.ok(cache.bytes<=10);assert.equal(cache.size,1);
 let pending;const value=cache.encode('four',3,()=>new Promise(resolve=>{pending=resolve;}));cache.clear();pending(Buffer.alloc(1));await value;assert.equal(cache.bytes,0);assert.equal(cache.size,0);
});
