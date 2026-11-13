import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {Pairing,sameOrigin} from '../auth.mjs';
import {isHubFrameRequest,hubEntryGuard} from '../../connection/mobile-entry.mjs';
import {assertInstallFiles} from '../../scripts/runtime-dependencies.mjs';

const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
const paths=['/','/legacy/','/mobile/','/mobile/index.html','/remote/v4','/remote/v4/','/remote/v4/3.16.3/index.html'];
const target='https://unified.example/m/#';
const originalScript='<script type="module" crossorigin src="/remote/v4/3.16.3/assets/index-BsmXQHMM.js"></script>';
const html='<!doctype html><html><head><meta name="viewport" content="width=device-width">'+originalScript+'</head><body><main id="fixture-codex">Codex fixture</main></body></html>';

async function harness(t){
 const pairing=new Pairing({token:'a'.repeat(43)}),reads=[];
 // Run the actual HTTP handler without its live Codex API/bootstrap. No native
 // sessions, real tokens, source assets or installed services are accessed.
 const fragment=source.slice(source.indexOf('const types='),source.indexOf('const stopRpc='));
 const context={URL,Buffer,Set,join,resolve,extname,sep,createHash,origin:'http://adapter.test',root:'/fixture/adapter',web:'/fixture/vendor',
  pairing,sameOrigin,isHubFrameRequest,hubEntryGuard,unifiedEntryTarget:async()=>target,
  createServer:http.createServer,
  readFile:async(path,encoding)=>{reads.push(path);const value=path.endsWith('.html')?html:path.endsWith('.css')?'.fixture{}':'// fixture asset';return encoding?value:Buffer.from(value);},
  stat:async()=>({isFile:()=>true}),
 };
 const server=runInNewContext(fragment+'\nserver;',context);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const request=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port:server.address().port,path,method,agent:false,headers:{host:'adapter.test',...headers}},res=>{
   const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));res.on('error',reject);
  });req.on('error',reject);req.end(body);
 });
 return {request,reads,pairing};
}

test('all former HTML entries and raw index redirect top-level GET/HEAD without reading assets or carrying old credentials',async t=>{
 const f=await harness(t);
 for(const path of paths)for(const method of ['GET','HEAD'])for(const headers of [{},{'sec-fetch-dest':'document'},{'sec-fetch-site':'cross-site','sec-fetch-dest':'document'}]){
  const response=await f.request(path+'?token=old-fixture&t=old-fixture&next=https://other.example/#old-hash',{method,headers});
  assert.equal(response.status,302,path+' '+method);assert.equal(response.headers.location,target);
  assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.body,'');
 }
 assert.deepEqual(f.reads,[]);
});

test('iframe requests retain patched Codex HTML and HEAD semantics at every entry, including raw versioned index',async t=>{
 const f=await harness(t);
 for(const path of paths){
  const response=await f.request(path,{headers:{'sec-fetch-dest':'iframe'}});
  assert.equal(response.status,200,path);assert.match(response.headers['content-type'],/text\/html/);
  assert.match(response.body,/fixture-codex/);assert.match(response.body,/src="\/codex-entry\.mjs"/);
  assert.ok(!response.body.includes(originalScript));assert.ok(response.body.includes(target));
  const head=await f.request(path,{method:'HEAD',headers:{'sec-fetch-dest':'iframe'}});
  assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(head.headers['content-length'],response.headers['content-length']);
 }
});

test('missing fetch destination requires the exact marker; marker cannot override an explicit non-iframe destination',async t=>{
 const f=await harness(t);
 for(const path of paths){
  assert.equal((await f.request(path+'?hub_frame=1')).status,200,path);
  for(const marker of ['','?hub_frame=0','?hub_frame=true','?hub_frame=01','?hub_frame=1&hub_frame=1'])assert.equal((await f.request(path+marker)).status,302,path+marker);
  for(const destination of ['document','empty','frame','image','']){
   const response=await f.request(path+'?hub_frame=1',{headers:{'sec-fetch-dest':destination}});
   assert.equal(response.status,302,path+' '+destination);assert.equal(response.headers.location,target);
  }
 }
});

test('HTML guard appears before application startup for headerless frames and encoded raw index cannot bypass redirect',async t=>{
 const f=await harness(t);
 for(const path of paths){
  const response=await f.request(path+'?hub_frame=1');
  const firstInline=response.body.search(/<script\b(?![^>]*\bsrc=)[^>]*>/i);
  assert.ok(firstInline>=0&&firstInline<response.body.indexOf('src="/codex-entry.mjs"'),path);
  assert.ok(response.body.includes(target));
 }
 assert.equal((await f.request('/remote/v4/3.16.3/%69ndex.html?token=old-fixture')).status,302);
});

test('a headerless real top document hides and redirects before startup, while a true iframe remains usable',async t=>{
 const f=await harness(t),response=await f.request('/remote/v4/3.16.3/index.html?hub_frame=1');
 const inline=response.body.match(/<script data-hub-entry-guard>([\s\S]*?)<\/script>/)?.[1];assert.ok(inline);
 for(const framed of [false,true]){
  const events=[],document={documentElement:{style:{visibility:'visible'}}};
  const window={stop(){events.push(['stop',document.documentElement.style.visibility]);},location:{replace(url){events.push(['redirect',url]);}}};
  window.self=window;window.top=framed?{}:window;
  runInNewContext(inline,{window,document});
  assert.deepEqual(events,framed?[]:[['stop','hidden'],['redirect',target]]);
  assert.equal(document.documentElement.style.visibility,framed?'visible':'hidden');
 }
});

test('frame marker grants no API authentication, and old pairing can issue only a Codex cookie',async t=>{
 const f=await harness(t);
 for(const headers of [{},{'sec-fetch-dest':'iframe'}]){
  const response=await f.request('/api/server-info?hub_frame=1',{headers});assert.equal(response.status,401);
  assert.equal(response.headers['set-cookie'],undefined);
 }
 const response=await f.request('/api/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:f.pairing.token})});
 assert.equal(response.status,200);assert.ok(response.headers['set-cookie'].every(value=>value.startsWith('codex_native_pair=')));
 assert.ok(response.headers['set-cookie'].every(value=>!value.includes('desk-auth')));
 assert.equal((await f.request('/?hub_frame=1',{headers:{'sec-fetch-dest':'document',cookie:'codex_native_pair='+f.pairing.pair(f.pairing.token)}})).status,302);
 assert.equal((await f.request('/codex-entry.mjs')).status,200);
 assert.equal((await f.request('/healthz')).status,200);
 assert.equal((await f.request('/legacy/',{method:'POST'})).status,405);
});

test('installed adapter and ingress receive the shared helper, and a missing helper fails before any service operation',async t=>{
 const installer=await readFile(new URL('../../connection/install-local.mjs',import.meta.url),'utf8');
 const match=installer.match(/const connectionFiles=(\[[^;]+\]);/);assert.ok(match);
 const files=runInNewContext(match[1]);assert.ok(files.includes('mobile-entry.mjs'));
 assert.match(installer,/mkdir\(join\(services,'connection'\)/);
 assert.match(installer,/cp\(join\(source,'mobile-entry\.mjs'\),join\(services,'connection','mobile-entry\.mjs'\)\)/);
 assert.match(installer,/for\(const file of connectionFiles\).*join\(app,file\)/);
 assert.match(source,/from '\.\.\/connection\/mobile-entry\.mjs'/);
 const directory=await mkdtemp(join(tmpdir(),'codex-entry-install-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const connection=join(directory,'connection');await mkdir(connection);
 for(const file of files)if(file!=='mobile-entry.mjs')await writeFile(join(connection,file),'fixture');
 const calls=[];
 const body=installer.replace(/^import .*;\n/gm,'').replaceAll('import.meta.dirname','sourceDirectory');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const run=new AsyncFunction('join','resolve','homedir','sourceDirectory','process','assertInstallFiles','execFileSync',body);
 await assert.rejects(run(join,resolve,()=>directory,connection,process,assertInstallFiles,(...args)=>calls.push(args)),/Missing install source mobile-entry\.mjs/);
 assert.deepEqual(calls,[]);
});
