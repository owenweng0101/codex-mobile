import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createDshProxy} from '../dsh-proxy.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
async function setup(t,handler,options={}){
  const errors=[],upstream=http.createServer(handler),port=await listen(upstream);
  const proxy=createDshProxy({target:`http://127.0.0.1:${port}`,prefix:'/claude',onError:error=>errors.push(error),...options});
  const gateway=http.createServer((req,res)=>proxy.forward(req,res)),gatewayPort=await listen(gateway);
  const agent=new http.Agent({keepAlive:true,maxSockets:1});
  t.after(async()=>{
    agent.destroy();proxy.dispose();
    await Promise.all([gateway,upstream].map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));
  });
  const request=({method='POST',body='{}',headers={},chunks}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:gatewayPort,path:'/claude/api/read?private=query',method,agent,
      headers:{host:'phone.example',origin:'https://phone.example',cookie:'private-cookie=secret','content-type':'application/json',...headers}},res=>{
      const parts=[];res.on('data',b=>parts.push(b));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));
    });
    req.on('error',reject);
    if(chunks){for(const chunk of chunks)req.write(chunk);req.end();}else req.end(body);
  });
  return {request,errors};
}

test('POST fixed/chunked framing and UTF8 bytes survive reused sockets without contaminating the next request',{timeout:4000},async t=>{
  const seen=[],sockets=[];
  const f=await setup(t,async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(chunk);
    seen.push({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(parts).toString()});sockets.push(req.socket);
    res.setHeader('content-type','application/json');res.end('{"ok":true}');
  });
  const body=JSON.stringify({fixture:'中文🙂',requestId:'invalid-fixture'});
  for(let i=0;i<12;i++){
    const fixed=i%2===0;
    assert.equal((await f.request(fixed?{body,headers:{'content-length':Buffer.byteLength(body)}}:
      {chunks:[Buffer.from(body).subarray(0,19),Buffer.from(body).subarray(19)]})).status,200);
    const last=seen.at(-1);assert.equal(last.body,body);assert.equal(last.url,'/claude/api/read?private=query');
    assert.equal(last.headers.host,'phone.example');assert.equal(last.headers.origin,'https://phone.example');
    assert.equal(last.headers.cookie,'private-cookie=secret');
    assert.equal(Boolean(last.headers['content-length']),fixed);assert.equal(last.headers['transfer-encoding'],fixed?undefined:'chunked');
  }
  assert.equal(new Set(sockets).size,1,'exercise actual upstream socket reuse');
  assert.deepEqual(f.errors,[]);
});

test('removes Connection-nominated headers on both legs and regenerates body framing',{timeout:4000},async t=>{
  let received;
  const f=await setup(t,async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);received={headers:req.headers,body:Buffer.concat(parts).toString()};
    res.writeHead(200,{'connection':'keep-alive, x-upstream-hop, content-length','x-upstream-hop':'private',
      'content-length':2,'x-frame-options':'DENY','set-cookie':['fixture=retained; HttpOnly']});res.end('ok');
  });
  const response=await f.request({body:'{}',headers:{'content-length':2,'connection':'keep-alive, x-request-hop, content-length','x-request-hop':'private'}});
  assert.equal(response.status,200);assert.equal(response.body,'ok');assert.equal(received.body,'{}');
  assert.equal(received.headers['x-request-hop'],undefined);assert.equal(received.headers['content-length'],undefined);
  assert.equal(received.headers['transfer-encoding'],'chunked');assert.equal(response.headers['x-upstream-hop'],undefined);
  assert.equal(response.headers['content-length'],undefined);assert.equal(response.headers['x-frame-options'],undefined);
  assert.deepEqual(response.headers['set-cookie'],['fixture=retained; HttpOnly']);
});

test('connection resets produce accurate Claude diagnostics without retrying a POST or exposing secrets',{timeout:4000},async t=>{
  let calls=0;
  const f=await setup(t,(req,res)=>{calls++;req.socket.destroy();});
  const response=await f.request();assert.equal(response.status,502);assert.equal(calls,1);
  const body=JSON.parse(response.body);assert.match(body.error,/Claude/);assert.doesNotMatch(body.error,/Harness|未启动/);
  assert.equal(body.code,'ECONNRESET');
  assert.deepEqual(f.errors,[{prefix:'/claude',method:'POST',code:'ECONNRESET',reusedSocket:false}]);
  assert.doesNotMatch(JSON.stringify(f.errors),/private|secret|query|requestId/);
});

test('idle timeout has its own code and does not replay a native-read mutation',{timeout:4000},async t=>{
  let calls=0;
  const f=await setup(t,req=>{calls++;req.resume();},{timeoutMs:30});
  const response=await f.request();assert.equal(response.status,502);
  assert.equal(JSON.parse(response.body).code,'ETIMEDOUT');assert.equal(calls,1);
  assert.equal(f.errors[0].code,'ETIMEDOUT');
});
