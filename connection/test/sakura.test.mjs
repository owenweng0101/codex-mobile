import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setImmediate} from 'node:timers/promises';
import {SakuraTunnel} from '../sakura.mjs';

const origin='https://www.example.nyat.app:18378';
function setup(t,verify){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 const calls=[],candidates=[];
 const tunnel=new SakuraTunnel({binary:'/private/frpc',configPath:'/private/Application Support/frpc.ini',origin,instance:'test',verify,checkInterval:60000,onCandidate:value=>candidates.push(value),spawnProcess:(...args)=>{calls.push(args);return child;}});
 t.after(()=>tunnel.stop());return{tunnel,child,calls,candidates};
}
test('Sakura publishes a pairing origin only after HTTPS and WebSocket verification, and clears it on failure',async t=>{
 let online=false;const {tunnel,calls}=setup(t,async()=>{if(!online)throw Error('offline');});
 tunnel.start();await setImmediate();assert.equal(tunnel.state.origin,null);
 assert.deepEqual(calls[0][1],['-c','/private/Application Support/frpc.ini']);
 assert.equal(calls[0][2].cwd,'/private/Application Support');
 online=true;await tunnel.check();assert.equal(tunnel.state.status,'online');assert.equal(tunnel.state.origin,origin);
 online=false;await tunnel.check();assert.equal(tunnel.state.origin,null);assert.equal(tunnel.state.verifiedAt,null);
});
test('a completed verification cannot revive a stopped tunnel',async t=>{
 let finish;const {tunnel}=setup(t,()=>new Promise(resolve=>{finish=resolve;}));
 tunnel.start();tunnel.stop();finish();await setImmediate();assert.equal(tunnel.state.status,'stopped');assert.equal(tunnel.state.origin,null);
});
test('exiting clients immediately withdraw the origin',async t=>{
 const {tunnel,child,candidates}=setup(t,async()=>true);tunnel.start();await setImmediate();assert.equal(tunnel.state.status,'online');
 child.emit('exit',1);assert.equal(tunnel.state.status,'reconnecting');assert.equal(tunnel.state.origin,null);assert.equal(candidates.at(-1),null);
});
test('invalid or unencrypted public origins are rejected before spawning a client',()=>{
 for(const value of ['http://www.example.nyat.app:18378','https://www.example.nyat.app','https://www.example.nyat.app:22','https://www.example.nyat.app:18378/path','https://www.example.nyat.app:18378/?token=x','https://attacker.example:18378']){
  assert.throws(()=>new SakuraTunnel({origin:value}));
 }
});
