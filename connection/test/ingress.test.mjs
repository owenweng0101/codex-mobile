import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once,EventEmitter} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {createIngress} from '../ingress.mjs';
import {CpolarTunnel,extractCpolarOrigins,verifyPublic} from '../cpolar.mjs';
import {Pairing,sameOrigin} from '../../adapter/auth.mjs';
const origin='https://test.cn.cpolar.top';
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function request(port,path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path,method,headers:{host:new URL(origin).host,...headers}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body);});}
test('dedicated tunnel never exposes local pairing secrets or widens operation scope',{timeout:3000},async()=>{
 const calls=[],backend=http.createServer((req,res)=>{calls.push({path:req.url,origin:req.headers.origin,host:req.headers.host,forwarded:req.headers['x-forwarded-for']});res.setHeader('content-type','application/json');res.end('{"ok":true}');});
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);const port=await listen(gateway.server);
 try{
  assert.equal((await request(port,'/api/server-info')).status,404);gateway.setMode('codex-read');
  for(const path of ['/local/info','/__audit','/pair','/local/mode','/remote/v4/3.16.3/%2e%2e/local/info','http://elsewhere.test/local/info'])assert.equal((await request(port,path)).status,404,path);
  for(const path of ['/api/message','/api/thread','/api/interrupt'])assert.equal((await request(port,path,{method:'POST',body:'{}'})).status,404);
  assert.equal((await request(port,'/api/server-info',{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await request(port,'/api/server-info',{headers:{host:'127.0.0.1:'+port}})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await request(port,'/api/server-info',{headers:{origin,'x-forwarded-for':'attacker'}})).status,200);
  assert.deepEqual(calls,[{path:'/api/server-info',origin:'http://127.0.0.1:'+bp,host:'127.0.0.1:'+bp,forwarded:undefined}]);
 }finally{await gateway.close();await new Promise(r=>backend.close(r));}
});
test('pairing retains backend authentication, marks public cookie Secure, and compresses large original assets',{timeout:3000},async()=>{
 const backend=http.createServer((req,res)=>{res.setHeader('content-type','text/javascript');res.setHeader('set-cookie','codex_native_pair=fixture; HttpOnly; SameSite=Strict; Path=/');res.end('const originalUI=true;\n'.repeat(10000));});
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);
 try{const response=await request(port,'/codex-entry.mjs',{headers:{origin,'accept-encoding':'gzip'}});assert.equal(response.status,200);assert.equal(response.headers['content-encoding'],'gzip');assert.match(response.headers['set-cookie'][0],/; Secure$/);assert.ok(response.body.length<1000);const {gunzipSync}=await import('node:zlib');assert.equal(gunzipSync(response.body).toString(),'const originalUI=true;\n'.repeat(10000));}
 finally{await gateway.close();await new Promise(r=>backend.close(r));}
});
test('external QR navigation can load only the entry document without relaxing API or origin checks',async t=>{
 const calls=[],backend=http.createServer((req,res)=>{
  if(!sameOrigin(req.headers,'http://127.0.0.1:'+backend.address().port)){res.writeHead(403);res.end();return;}
  calls.push({path:req.url,site:req.headers['sec-fetch-site']});res.end('<html>entry</html>');
 });
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);
 t.after(async()=>{await gateway.close();await new Promise(r=>backend.close(r));});
 const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 for(const path of ['/','/legacy/','/mobile/','/mobile/index.html'])assert.equal((await request(port,path,{headers:navigation})).status,200,path);
 assert.equal(calls.length,4);assert.ok(calls.every(x=>x.site==='none'));
 for(const path of ['/api/server-info','/api/pair','/mobile/api/history','/codex-entry.mjs','/local/info','/ws'])assert.equal((await request(port,path,{headers:navigation})).status,403,path);
 for(const headers of [{...navigation,origin:'https://evil.example'},{...navigation,host:'attacker.example'},{...navigation,'sec-fetch-mode':'cors'},{...navigation,'sec-fetch-dest':'iframe'},{'sec-fetch-site':'cross-site'}])assert.equal((await request(port,'/',{headers})).status,403);
 assert.equal((await request(port,'/',{method:'POST',headers:navigation})).status,403);
 assert.equal(calls.length,4);
});
test('public binary RPC authenticates upstream first and retains its immediate first frame',{timeout:3000},async()=>{
 const backend=http.createServer(),wss=new WebSocketServer({noServer:true}),initial=Buffer.from([0,7,255]);
 backend.on('upgrade',(req,socket,head)=>{if(req.headers.cookie!=='codex_native_pair=fixture'||req.headers.origin!=='http://127.0.0.1:'+backend.address().port){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}wss.handleUpgrade(req,socket,head,ws=>{ws.send(initial);ws.on('message',v=>ws.send(v));});});
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);let ws;
 try{
  await assert.rejects(new Promise((resolve,reject)=>{const unauth=new WebSocket('ws://127.0.0.1:'+port+'/ws',{headers:{host:new URL(origin).host,origin}});unauth.on('open',()=>{unauth.terminate();resolve();});unauth.on('error',reject);}),/403|502/);
  ws=new WebSocket('ws://127.0.0.1:'+port+'/ws',{headers:{host:new URL(origin).host,origin,cookie:'codex_native_pair=fixture'}});
  const first=once(ws,'message');await once(ws,'open');assert.deepEqual((await first)[0],initial);
  const echo=once(ws,'message');ws.send(Buffer.from('原版协议'));assert.equal((await echo)[0].toString(),'原版协议');
 }finally{ws?.terminate();await gateway.close();for(const c of wss.clients)c.terminate();wss.close();await new Promise(r=>backend.close(r));}
});
test('probe echoes binary without any Codex data or backend request',{timeout:3000},async()=>{
 const gateway=createIngress();gateway.setPublicOrigin(origin);const port=await listen(gateway.server);let ws;
 try{assert.match((await request(port,'/')).body.toString(),/不包含你的项目/);ws=new WebSocket('ws://127.0.0.1:'+port+'/probe/ws',{headers:{host:new URL(origin).host,origin}});await once(ws,'open');const echo=once(ws,'message');ws.send(Buffer.from([0,255,7]));assert.deepEqual((await echo)[0],Buffer.from([0,255,7]));}
 finally{ws?.terminate();await gateway.close();}
});
test('only cpolar HTTPS endpoints are extracted, not dashboard/help or random external URLs',()=>{
 assert.deepEqual(extractCpolarOrigins('https://dashboard.cpolar.com https://cpolar.com/docs https://evil.example https://demo.cn.cpolar.top\nurl=https://new.cpolar.cn'),['https://demo.cn.cpolar.top','https://new.cpolar.cn']);
});
test('a live HTTPS page is insufficient: verification checks exact local instance and binary round-trip',{timeout:3000},async()=>{
 await assert.rejects(verifyPublic(origin,'ours',{fetchImpl:async()=>({ok:true,json:async()=>({service:'codex-cpolar-ingress',instance:'wrong'})})}),/Wrong/);
 let sends=0;assert.equal(await verifyPublic(origin,'ours',{fetchImpl:async()=>({ok:true,json:async()=>({service:'codex-cpolar-ingress',instance:'ours'})}),wsConnect:(_url,options)=>{assert.equal(options.perMessageDeflate,false);const ws=new EventEmitter();ws.terminate=()=>{};ws.send=bytes=>{sends++;queueMicrotask(()=>ws.emit('message',bytes));};queueMicrotask(()=>ws.emit('open'));return ws;}}),true);assert.equal(sends,1);
});
test('reconnect hides stale QR, scopes China region, disables inspection and restarts only owned child',{timeout:3000},async()=>{
 const children=[],seen=[],args=[];let healthy=true;
 const tunnel=new CpolarTunnel({binary:'/private/cpolar',configPath:'/private/account.yml',port:8797,instance:'ours',retryDelay:5,checkInterval:60000,startupTimeout:60000,onCandidate:v=>seen.push(v),verify:async()=>{if(!healthy)throw Error('offline');},spawnProcess:(bin,flags)=>{assert.equal(bin,'/private/cpolar');args.push(flags);const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{c.killed=true;c.emit('exit');};children.push(c);return c;}});
 try{tunnel.start();assert.equal(args[0][args[0].indexOf('-region')+1],'cn');assert.equal(args[0][args[0].indexOf('-inspect-addr')+1],'false');assert.equal(args[0].includes('-authtoken'),false);
  children[0].stdout.emit('data',Buffer.from('Forwarding https://old.cpolar.top'));await new Promise(setImmediate);assert.equal(tunnel.state.origin,'https://old.cpolar.top');
  healthy=false;await tunnel.check();assert.equal(tunnel.state.origin,null);await tunnel.check();assert.equal(children[0].killed,true);
  await new Promise(r=>setTimeout(r,15));assert.equal(children.length,2);healthy=true;children[1].stdout.emit('data',Buffer.from('Forwarding https://new.cpolar.top'));await new Promise(setImmediate);assert.equal(tunnel.state.origin,'https://new.cpolar.top');assert.equal(seen.includes(null),true);
 }finally{tunnel.stop();}
});

test('mobile production assets and legacy entry use an exact GET/HEAD allowlist',async t=>{
 const calls=[],backend=http.createServer((req,res)=>{calls.push(req.url);res.end('fixture');});
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);const port=await listen(gateway.server);
 t.after(async()=>{await gateway.close();await new Promise(r=>backend.close(r));});
 const paths=['/','/legacy/','/mobile/','/mobile/index.html','/mobile/app.css','/mobile/app.mjs','/mobile/attachments.mjs','/mobile/skills.mjs','/mobile/cache.mjs','/mobile/queue.mjs','/codex-entry.mjs','/codex-browser-adapter.mjs','/remote/v4/3.16.3/assets/index.js'];
 assert.equal((await request(port,'/mobile/skills.mjs?v=build')).status,404);assert.equal(calls.length,0);
 gateway.setMode('codex-read');
 for(const path of paths){
  for(const method of ['GET','HEAD']){assert.equal((await request(port,path+'?v=build',{method})).status,200,path);assert.equal(calls.at(-1),path+'?v=build');}
  assert.equal((await request(port,path,{method:'POST'})).status,404,path);
 }
 const before=calls.length;
 for(const path of ['/mobile/cache.test.mjs','/mobile/skills.spec.mjs','/mobile/test/queue.mjs','/mobile/unknown.mjs','/mobile/attachments.css','/mobile/app.mjs.map','/mobile/package.json','/mobile/.env','/mobile/%61pp.mjs','/mobile/../local/info','/mobile//app.mjs','/legacy/local/info','/legacy/index.html','/legacy'])assert.equal((await request(port,path)).status,404,path);
 assert.equal(calls.length,before);
});

test('new mobile API routes preserve upstream pairing, origin, bodies and existing body limits',async t=>{
 const pairing=new Pairing(),calls=[];
 const backend=http.createServer(async(req,res)=>{
  req.on('error',()=>{});
  if(!sameOrigin(req.headers,'http://127.0.0.1:'+backend.address().port)){res.writeHead(403);res.end();return;}
  if(!pairing.allows(req.headers)){res.writeHead(401);res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
  if(body.length>160*1024){res.writeHead(413);res.end();return;}
  calls.push({path:req.url,method:req.method,body:body.toString(),headers:req.headers});res.end('{"ok":true}');
 });
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);
 t.after(async()=>{await gateway.close();await new Promise(r=>backend.close(r));});
 const cookie='codex_native_pair='+pairing.pair(pairing.token),headers={origin,cookie,'content-type':'application/json'};
 const routes=[['/mobile/api/skills','GET'],['/mobile/api/queue','GET'],['/mobile/api/queue','POST'],['/mobile/api/upload','POST'],['/mobile/api/archive','POST'],['/mobile/api/bootstrap','GET'],['/mobile/api/threads','GET'],['/mobile/api/history','GET'],['/mobile/api/image','GET'],['/mobile/api/changes','GET'],['/mobile/api/create','POST'],['/mobile/api/message','POST'],['/api/server-info','GET'],['/api/navigation','POST']];
 for(const [path,method]of routes){
  const body=method==='POST'?'{"fixture":"原样转发"}':undefined;
  assert.equal((await request(port,path,{method,body})).status,401,path);
  assert.equal((await request(port,path,{method,body,headers:{...headers,cookie:'codex_native_pair=invalid'}})).status,401,path);
  assert.equal((await request(port,path,{method,body,headers:{...headers,origin:'https://evil.example'}})).status,403,path);
  assert.equal((await request(port,path,{method,body,headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403,path);
  assert.equal((await request(port,path+'?fixture=1',{method,body,headers})).status,200,path);
  const seen=calls.at(-1);assert.equal(seen.path,path+'?fixture=1');assert.equal(seen.method,method);assert.equal(seen.body,body||'');assert.equal(seen.headers.cookie,cookie);assert.equal(seen.headers.origin,'http://127.0.0.1:'+bp);assert.equal(seen.headers['content-type'],'application/json');
 }
 const before=calls.length;
 for(const [path,method]of [['skills','POST'],['queue','DELETE'],['upload','GET'],['archive','GET'],['queue','HEAD'],['unknown','POST'],['upload/extra','POST']])assert.equal((await request(port,'/mobile/api/'+path,{method,headers})).status,404);
 assert.equal((await request(port,'/api/upload',{method:'POST',headers})).status,404);
 assert.equal((await request(port,'/mobile/api/message',{method:'POST',headers,body:Buffer.alloc(160*1024+1)})).status,413);
 assert.equal(calls.length,before);
 gateway.setMode('probe');for(const [path,method]of routes)assert.equal((await request(port,path,{method,headers})).status,404);
});

test('upload enforces 800 KiB including chunked requests without changing accepted bytes',async t=>{
 const received=[],backend=http.createServer((req,res)=>{
  const chunks=[];req.on('error',()=>{});req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{received.push(Buffer.concat(chunks));res.end('ok');});
 });
 const bp=await listen(backend),gateway=createIngress({backend:'http://127.0.0.1:'+bp});gateway.setPublicOrigin(origin);gateway.setMode('codex-read');const port=await listen(gateway.server);
 t.after(async()=>{await gateway.close();backend.closeAllConnections();await new Promise(r=>backend.close(r));});
 for(const chunked of [false,true]){
  const body=Buffer.from('x'.repeat(800*1024)),headers=chunked?{'transfer-encoding':'chunked'}:{'content-length':body.length};
  assert.equal((await request(port,'/mobile/api/upload',{method:'POST',body,headers})).status,200);assert.deepEqual(received.at(-1),body);
  const before=received.length,large=Buffer.concat([body,Buffer.from('x')]);
  const over=await request(port,'/mobile/api/upload',{method:'POST',body:large,headers:chunked?headers:{'content-length':large.length}});
  assert.equal(over.status,413);assert.equal(received.length,before);
 }
});
