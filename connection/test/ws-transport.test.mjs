import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {createIngress} from '../ingress.mjs';

const origin='https://transport.example';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
async function fixture(t,{heartbeatIntervalMs=15000,upstreamAutoPong=true}={}){
 const initial=Buffer.from([0,7,255]),backend=http.createServer(),upstream=new WebSocketServer({noServer:true,autoPong:upstreamAutoPong});
 const received=[];
 backend.on('upgrade',(req,socket,head)=>{
  if(req.headers.cookie!=='codex_native_pair=fixture'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  upstream.handleUpgrade(req,socket,head,ws=>{
   upstream.emit('connection',ws);ws.send(initial);
   ws.on('message',(bytes,binary)=>{received.push({bytes:Buffer.from(bytes),binary});ws.send(bytes,{binary});});
  });
 });
 const backendPort=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+backendPort,heartbeatIntervalMs});
 gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server),clients=new Set();
 t.after(async()=>{for(const ws of clients)ws.terminate();await gateway.close();for(const ws of upstream.clients)ws.terminate();await new Promise(resolve=>upstream.close(resolve));await new Promise(resolve=>backend.close(resolve));});
 const connect=async options=>{
  const ws=new WebSocket('ws://127.0.0.1:'+port+'/ws',{headers:{host:new URL(origin).host,origin,cookie:'codex_native_pair=fixture'},...options});clients.add(ws);
  let extensions;ws.on('upgrade',response=>{extensions=response.headers['sec-websocket-extensions'];});
  const first=once(ws,'message');await once(ws,'open');assert.deepEqual((await first)[0],initial);
  return{ws,extensions};
 };
 return{gateway,upstream,connect,received};
}

test('public binary RPC negotiates bounded no-context compression and reduces real downstream bytes',{timeout:5000},async t=>{
 const {connect,received}=await fixture(t),payload=Buffer.from('历史内容与模型列表 '.repeat(10000));
 let compressedBytes,plainBytes;
 for(const compress of [false,true]){
  const {ws,extensions}=await connect({perMessageDeflate:compress});
  if(compress){assert.match(ws.extensions,/permessage-deflate/);assert.match(extensions,/server_no_context_takeover/);assert.match(extensions,/client_no_context_takeover/);}else assert.equal(ws.extensions,'');
  const before=ws._socket.bytesRead,echo=once(ws,'message');ws.send(payload);const [bytes,binary]=await echo;
  assert.equal(binary,true);assert.deepEqual(bytes,payload);assert.deepEqual(received.at(-1),{bytes:payload,binary:true});
  if(compress)compressedBytes=ws._socket.bytesRead-before;else plainBytes=ws._socket.bytesRead-before;
  const closed=once(ws,'close');ws.close();await closed;
 }
 assert.ok(compressedBytes<plainBytes/10,{compressedBytes,plainBytes});
});

test('heartbeat keeps a healthy bridge and client close releases its upstream subscription socket',{timeout:3000},async t=>{
 const {connect,upstream}=await fixture(t,{heartbeatIntervalMs:40});
 const upstreamConnected=once(upstream,'connection'),{ws}=await connect(),[remote]=await upstreamConnected;
 await new Promise(resolve=>{let pings=0;ws.on('ping',()=>{if(++pings===3)resolve();});});
 assert.equal(ws.readyState,WebSocket.OPEN);assert.equal(remote.readyState,WebSocket.OPEN);
 const remoteClosed=once(remote,'close'),closed=once(ws,'close');ws.close();await Promise.all([remoteClosed,closed]);
 assert.equal(upstream.clients.size,0);
});

test('missing browser pong terminates both bridge legs instead of leaving native subscriptions alive',{timeout:3000},async t=>{
 const {connect,upstream}=await fixture(t,{heartbeatIntervalMs:40});
 const upstreamConnected=once(upstream,'connection'),{ws}=await connect({autoPong:false}),[remote]=await upstreamConnected;
 let pings=0;ws.on('ping',()=>pings++);
 const remoteClosed=once(remote,'close'),closed=once(ws,'close');await Promise.all([remoteClosed,closed]);
 assert.ok(pings>=1);assert.equal(ws.readyState,WebSocket.CLOSED);assert.equal(upstream.clients.size,0);
});

test('missing upstream pong closes the public connection even while the browser answers pings',{timeout:3000},async t=>{
 const {connect,upstream}=await fixture(t,{heartbeatIntervalMs:40,upstreamAutoPong:false});
 const upstreamConnected=once(upstream,'connection'),{ws}=await connect(),[remote]=await upstreamConnected;
 let pings=0;remote.on('ping',()=>pings++);
 await Promise.all([once(ws,'close'),once(remote,'close')]);
 assert.ok(pings>=1);assert.equal(ws.readyState,WebSocket.CLOSED);assert.equal(upstream.clients.size,0);
});

test('gateway shutdown terminates bridged sockets and stops heartbeat work',{timeout:3000},async t=>{
 const {connect,gateway}=await fixture(t,{heartbeatIntervalMs:40}),{ws}=await connect();
 const closed=once(ws,'close');await gateway.close();await closed;assert.equal(ws.readyState,WebSocket.CLOSED);
});

test('probe and loopback clients do not initialize ws global compression budget before the public bridge',{timeout:7000},async()=>{
 // A browser runs in a separate process. Use a raw upgrade here so a Node test
 // client cannot initialize ws's process-global limiter before the real server.
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const source=`
 import assert from 'node:assert/strict';
 import http from 'node:http';import net from 'node:net';import {once} from 'node:events';
 import {createRequire} from 'node:module';import {dirname,join} from 'node:path';
 const require=createRequire(import.meta.url),limiterPath=join(dirname(require.resolve('ws')),'lib/limiter.js'),Limiter=require(limiterPath),limits=[];
 require.cache[limiterPath].exports=class extends Limiter{constructor(limit){super(limit);limits.push(limit);}};
 const {createIngress}=await import('./ingress.mjs'),{verifyPublic}=await import('./cpolar.mjs'),{WebSocketServer}=require('ws');
 const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
 const backend=http.createServer(),wss=new WebSocketServer({noServer:true});
 backend.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>{ws.on('message',bytes=>ws.send(bytes));}));
 const backendPort=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+backendPort});
 gateway.setPublicOrigin('https://transport.example');gateway.setMode('codex-read');
 let socket;
 try{
  await verifyPublic('http://127.0.0.1:'+backendPort,'budget',{fetchImpl:async()=>({ok:true,json:async()=>({service:'codex-cpolar-ingress',instance:'budget'})})});
  assert.deepEqual(limits,[]);
  const port=await listen(gateway.server);socket=net.connect({host:'127.0.0.1',port});await once(socket,'connect');
  const response=new Promise((resolve,reject)=>{let text='';socket.on('data',chunk=>{text+=chunk.toString();if(text.includes('\\r\\n\\r\\n'))resolve(text);});socket.on('error',reject);});
  socket.write(['GET /ws HTTP/1.1','Host: transport.example','Origin: https://transport.example','Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Version: 13','Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Extensions: permessage-deflate','Cookie: codex_native_pair=fixture','',''].join('\\r\\n'));
  assert.match(await response,/101 Switching Protocols/);assert.deepEqual(limits,[4]);console.log(JSON.stringify({limits}));
 }finally{socket?.destroy();await gateway.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>backend.close(resolve));}
 `;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','--eval',source],{cwd:new URL('..',import.meta.url),timeout:5000,maxBuffer:16384});
 assert.deepEqual(JSON.parse(stdout),{limits:[4]});
});
