import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {WebSocket} from 'ws';import {attachOriginalRpc} from '../rpc-server.mjs';import {Pairing} from '../auth.mjs';
import {Emitter,VSBuffer,SocketProtocol,ChannelClient} from '../vendor/rpc.mjs';

test('paired original RPC reconnects with fresh per-connection identity and releases subscriptions on close',{timeout:3000},async()=>{
  const http=createServer((_req,res)=>res.end()),pairing=new Pairing();
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+http.address().port;
  const cookie='codex_native_pair='+pairing.pair(pairing.token);let created=0,disposed=0;const disposals=[];
  const stopped=attachOriginalRpc(http,{pairing,origin,createConnection(){let identity,resolveDisposed;disposals.push(new Promise(resolve=>{resolveDisposed=resolve;}));created++;return{services:{audit:{async hello(id){if(identity&&identity!==id)throw Error('client changed');identity=id;return id;}}},dispose(){disposed++;resolveDisposed();}};}});
  async function connect(id){
    const ws=new WebSocket(origin.replace('http','ws')+'/ws',{headers:{origin,cookie}});
    const data=new Emitter(),protocol=new SocketProtocol({onData:data.event,write:bytes=>ws.send(bytes.buffer),drain:async()=>{}}),client=new ChannelClient(protocol);
    ws.on('message',raw=>data.fire(VSBuffer.wrap(new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength))));
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    assert.equal(await client.getChannel('audit').call('hello',[id]),id);
    await assert.rejects(client.getChannel('not-adapted').call('read',[]),error=>error.code==='CODEX_ADAPTER_UNSUPPORTED');
    const unavailableEvent=client.getChannel('audit').listen('onNotAvailable')(()=>{});
    assert.equal(await client.getChannel('audit').call('hello',[id]),id,'an unavailable UI event must not break subsequent RPC calls');
    unavailableEvent.dispose();
    client.dispose();protocol.dispose();data.dispose();const closed=new Promise(resolve=>ws.once('close',resolve));ws.close();await closed;
  }
  try{await connect('first-browser');await connect('refreshed-browser');await Promise.all(disposals);assert.equal(created,2);assert.equal(disposed,2);}
  finally{stopped();await new Promise(resolve=>http.close(resolve));}
});
