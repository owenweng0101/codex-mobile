import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {Pairing} from '../auth.mjs';

const token='a'.repeat(43),otherToken='b'.repeat(43),headers=value=>({cookie:'other=fixture; codex_native_pair='+value});
const changed=value=>(value[0]==='a'?'b':'a')+value.slice(1);

test('signed pairing cookie survives a process recreation with the same persistent token',()=>{
 const issuedAt=1_700_000_000_000,pairing=new Pairing({token,now:()=>issuedAt}),session=pairing.pair(token);
 assert.equal(pairing.allows(headers(session)),true);
 const restored=new Pairing({token,now:()=>issuedAt+60_000});
 assert.equal(restored.allows(headers(session)),true);
 assert.equal(session.includes(token),false);
 assert.equal(Number(session.split('.')[1])-issuedAt,12*60*60*1000);
 assert.notEqual(pairing.pair(token),session);
});

test('a cookie issued by one Node process verifies in a fresh process without a shared session map',()=>{
 const source=JSON.stringify(new URL('../auth.mjs',import.meta.url).href),options={encoding:'utf8',env:{PAIRING_TEST_TOKEN:token}};
 const session=execFileSync(process.execPath,['--input-type=module','-e',`import {Pairing} from ${source};const token=process.env.PAIRING_TEST_TOKEN;process.stdout.write(new Pairing({token}).pair(token));`],options);
 const verify=`import {readFileSync} from 'node:fs';import {Pairing} from ${source};const cookie=readFileSync(0,'utf8');process.stdout.write(String(new Pairing({token:process.env.PAIRING_TEST_TOKEN}).allows({cookie:'codex_native_pair='+cookie})));`;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',verify],{...options,input:session}),'true');
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',verify],{...options,input:session,env:{PAIRING_TEST_TOKEN:otherToken}}),'false');
});

test('persistent token rotation revokes every old cookie without granting access to the token itself',()=>{
 const pairing=new Pairing({token}),session=pairing.pair(token);
 assert.equal(new Pairing({token:otherToken}).allows(headers(session)),false);
 pairing.token=otherToken;
 assert.equal(pairing.allows(headers(session)),false);
 assert.equal(pairing.pair(token),null);
 assert.equal(pairing.allows(headers(pairing.pair(otherToken))),true);
 assert.equal(pairing.allows(headers(otherToken)),false);
 assert.equal(pairing.allows({authorization:'Bearer '+otherToken}),false);
});

test('expiry, nonce, MAC and version tampering fail signature verification',()=>{
 const pairing=new Pairing({token,now:()=>1_700_000_000_000}),session=pairing.pair(token),parts=session.split('.');
 for(const[index,value]of [[0,'v2'],[1,String(Number(parts[1])+60_000)],[2,changed(parts[2])],[3,changed(parts[3])]]){
  const mutated=[...parts];mutated[index]=value;assert.equal(pairing.allows(headers(mutated.join('.'))),false);
 }
 for(const malformed of [session+'.extra',session.slice(0,-1),'v1.9999999999999999.'+parts[2]+'.'+parts[3],token,''])assert.equal(pairing.allows(headers(malformed)),false);
 assert.equal(pairing.allows({cookie:'codex_native_pair='+session+'; codex_native_pair='+session}),false);
});

test('signed cookie expires at its original 12-hour deadline even after repeated restarts',()=>{
 let time=1_700_000_000_000;const session=new Pairing({token,now:()=>time}).pair(token);
 time+=12*60*60*1000-1;assert.equal(new Pairing({token,now:()=>time}).allows(headers(session)),true);
 time++;assert.equal(new Pairing({token,now:()=>time}).allows(headers(session)),false);
 time+=100;assert.equal(new Pairing({token,now:()=>time}).allows(headers(session)),false);
});
