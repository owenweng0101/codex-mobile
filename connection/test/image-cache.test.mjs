import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createIngress} from '../ingress.mjs';
const origin='https://image-cache.invalid';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
test('only successful authenticated image responses keep bounded private browser caching',async()=>{
 const seen=[];
 const upstream=http.createServer((req,res)=>{
  seen.push(req.headers.cookie);
  const url=new URL(req.url,'http://test');
  if(req.headers.cookie!=='codex_native_pair=valid'){res.writeHead(401,{'content-type':'image/png','cache-control':'private, max-age=300'});res.end('denied');return;}
  const status=Number(url.searchParams.get('status')||200),type=url.searchParams.get('type')||'image/png',cache=url.searchParams.get('cache')||'private, max-age=300';
  res.writeHead(status,{'content-type':type,'cache-control':cache,vary:'Accept-Encoding'});res.end('fixture-image');
 });
 const port=await listen(upstream),gateway=createIngress({backend:'http://127.0.0.1:'+port});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const publicPort=await listen(gateway.server);
 const request=(path,cookie='codex_native_pair=valid')=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:publicPort,path,headers:{host:new URL(origin).host,origin,cookie}},res=>{res.resume();res.on('end',()=>resolve(res));});req.on('error',reject);});
 try{
  const image=await request('/mobile/api/image?threadId=fixture&preview=1');assert.equal(image.statusCode,200);assert.equal(image.headers['cache-control'],'private, max-age=300');assert.equal(image.headers.vary,'Accept-Encoding, Cookie');
  for(const path of ['/mobile/api/history','/mobile/api/image?status=401','/mobile/api/image?status=500','/mobile/api/image?type=application/json','/mobile/api/image?cache=public%2C%20max-age%3D300','/mobile/api/image?cache=private%2C%20max-age%3D3600'])assert.equal((await request(path)).headers['cache-control'],'no-store',path);
  const rejected=await request('/mobile/api/image','codex_native_pair=invalid');assert.equal(rejected.statusCode,401);assert.equal(rejected.headers['cache-control'],'no-store');assert.equal(seen.at(-1),'codex_native_pair=invalid');
 }finally{await gateway.close();await new Promise(resolve=>upstream.close(resolve));}
});
