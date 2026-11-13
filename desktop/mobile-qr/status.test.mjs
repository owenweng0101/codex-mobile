import test from 'node:test';
import assert from 'node:assert/strict';
import {readMobileStatus, readDshStatus, readClaudeStatus, isLocalMobileRequest} from './status.mjs';

// All credentials below are generated fixtures, never captured runtime values.
const png = 'data:image/png;base64,' + Buffer.alloc(120).toString('base64');
const origin = 'https://relay.example.test';
const mobile = {status:'online', mode:'codex-read', phoneUrl:origin + '/#' + 'a'.repeat(43), qr:png};
const gateway = (path='/m/', service='claude-mobile') => ({service, status:'online', upstreamReady:true, phoneUrl:origin + path + '?t=' + 'b'.repeat(43), qr:png});
const response = value => ({ok:true, text:async()=>JSON.stringify(value)});

test('control status stays on the Unix control transport and retains only validated shared URLs', async () => {
  let call;
  const result = await readMobileStatus({fetchImpl:async(...args)=>{call=args;return response(mobile);}});
  assert.equal(result.status,'online');assert.equal(call[0],'http://localhost/local/status');assert.equal(call[1].redirect,'error');assert.ok(call[1].signal);
  for (const changed of [{phoneUrl:'http://relay.example.test/'},{phoneUrl:origin + '/m/'},{phoneUrl:'https://user:password@relay.example.test/#'+'a'.repeat(43)},{mode:'probe'},{qr:'not an image'}]) {
    assert.equal((await readMobileStatus({fetchImpl:async()=>response({...mobile,...changed})})).status,'offline');
  }
});

test('Sakura nonstandard HTTPS port survives without leaking the pairing fragment to gateway status APIs', async () => {
  const value = {...mobile, provider:'sakura', phoneUrl:'https://relay.nyat.app:12345/#'+'a'.repeat(43)};
  const result = await readMobileStatus({fetchImpl:async()=>response(value)});
  assert.equal(result.status,'online');
  let called;
  const unified = await readClaudeStatus({mobileStatus:result,fetchImpl:async url=>{
    called=new URL(url);return response({...gateway(),phoneUrl:'https://relay.nyat.app:12345/m/?t='+'b'.repeat(43)});
  }});
  assert.equal(unified.status,'online');assert.equal(called.hostname,'127.0.0.1');
  assert.equal(called.searchParams.get('publicOrigin'),'https://relay.nyat.app:12345');assert.ok(!called.href.includes('a'.repeat(43)));
});

test('both gateway readers require the correct service, exact route, token, protocol and matching origin', async () => {
  for (const [read,path,service] of [[readClaudeStatus,'/m/','claude-mobile'],[readDshStatus,'/dsh/','dsh-mobile']]) {
    const good=gateway(path,service);
    assert.equal((await read({mobileStatus:mobile,fetchImpl:async()=>response(good)})).status,'online');
    for (const changes of [
      {service:'wrong'}, {status:'unknown'}, {phoneUrl:origin+path+'other?t='+'b'.repeat(43)},
      {phoneUrl:'https://elsewhere.example.test'+path+'?t='+'b'.repeat(43)},
      {phoneUrl:'ftp://relay.example.test'+path+'?t='+'b'.repeat(43)},
      {phoneUrl:origin+path+'?t=short'}, {phoneUrl:origin+path+'?t='+'b'.repeat(43)+'&t='+'c'.repeat(43)},
      {phoneUrl:origin+path+'?t='+'b'.repeat(43)+'#extra'}, {qr:null}
    ]) assert.equal((await read({mobileStatus:mobile,fetchImpl:async()=>response({...good,...changes})})).status,'offline');
  }
});

test('offline shared tunnel can still expose a validated LAN-only unified QR', async () => {
  const value={...gateway(),status:'local',phoneUrl:'http://192.168.1.20:18903/m/?t='+'b'.repeat(43)};
  assert.equal((await readClaudeStatus({fetchImpl:async()=>response(value)})).status,'local');
  assert.equal((await readClaudeStatus({fetchImpl:async()=>response({...value,phoneUrl:'http://public.example.test/m/?t='+'b'.repeat(43)})})).status,'offline');
});

test('remote or credential-bearing status targets are rejected without making any request', async () => {
  let calls=0;
  for (const statusUrl of ['https://remote.example.test/status','http://192.168.1.2/status','http://user:pass@127.0.0.1/status']) {
    assert.equal((await readClaudeStatus({statusUrl,fetchImpl:async()=>{calls++;}})).status,'offline');
  }
  assert.equal(calls,0);
});

test('header and body stalls terminate even if an injected transport ignores abort', async () => {
  for (const read of [readMobileStatus,readDshStatus,readClaudeStatus]) for (const phase of ['headers','body']) {
    const fetchImpl=()=>phase==='headers'?new Promise(()=>{}):Promise.resolve({ok:true,text:()=>new Promise(()=>{})});
    const result=await read({timeoutMs:5,fetchImpl});
    assert.equal(result.status,'offline');assert.equal(result.phoneUrl,null);assert.equal(result.qr,null);
  }
});

test('oversized, non-JSON and HTTP errors never escape with response contents', async () => {
  for (const response of [{ok:false},{ok:true,text:async()=>'{invalid'},{ok:true,text:async()=>'x'.repeat(200001)}]) {
    const result=await readClaudeStatus({fetchImpl:async()=>response});assert.equal(result.status,'offline');assert.equal(result.phoneUrl,null);
  }
});

test('legacy local-request guard preserves the loopback and proxy-header boundary', () => {
  assert.equal(isLocalMobileRequest({headers:{host:'localhost:8796'}},8796),true);
  for (const extra of [{origin:'https://other.example.test'},{'sec-fetch-site':'cross-site'},{forwarded:'host=elsewhere'},{'x-forwarded-host':'localhost'}]) {
    assert.equal(isLocalMobileRequest({headers:{host:'localhost:8796',...extra}},8796),false);
  }
});
