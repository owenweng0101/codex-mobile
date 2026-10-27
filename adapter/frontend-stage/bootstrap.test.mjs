import test from 'node:test';
import assert from 'node:assert/strict';
import {loadCodexMobile,criticalPreloads,nativeAttachmentUrl} from '../codex-entry.mjs';
const main='/remote/v4/3.16.3/assets/index-BsmXQHMM.js';
const wrapper='/codex-browser-adapter.mjs';
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};};
const fixture=()=>{
 const stages=[],calls=[],controller={own:true};
 const compat={__codexBrandIcon:'data:image/png;base64,fixture',async __codexOriginalConnect(url){calls.push(['connect',url]);return{nativeServices:true};}};
 const adapter={async mountCodexOriginalH5(params){calls.push(['mount',params]);return controller;}};
 return{stages,calls,controller,compat,adapter,options:{origin:'https://phone.example',onStage:s=>stages.push(s),loadModule:async path=>{calls.push(['import',path]);return path===main?compat:adapter;},request:async(path,options)=>{calls.push(['http',path]);return new Response(JSON.stringify(path==='/api/server-info'?{authenticated:true,workspaces:[]}:{}),{status:200});}}};
};

test('interface imports start before pairing finishes, while catalogue waits for authentication',async()=>{
 const f=fixture(),pair=defer(),modules=defer();
 const pending=loadCodexMobile({...f.options,token:'private-token',loadModule:path=>{f.calls.push(['import',path]);return modules.promise.then(()=>path===main?f.compat:f.adapter);},request:async(path)=>{f.calls.push(['http',path]);if(path==='/api/pair')return pair.promise;return new Response(JSON.stringify({authenticated:true,workspaces:[]}));}});
 assert.deepEqual(f.calls.slice(0,3),[['import',main],['import',wrapper],['http','/api/pair']]);
 assert(!f.calls.some(x=>x[1]==='/api/server-info'));
 pair.resolve(new Response('{}'));await new Promise(resolve=>setImmediate(resolve));
 assert(f.calls.some(x=>x[1]==='/api/server-info'));
 assert(!f.calls.some(x=>x[0]==='connect'));
 modules.resolve();const result=await pending;
 assert.equal(result.controller,f.controller);
 assert.equal(f.calls.find(x=>x[0]==='connect')[1],'wss://phone.example/ws');
 assert(f.stages.includes('metadata')&&f.stages.includes('resources')&&f.stages.includes('mounted'));
});

test('invalid pairing never mounts the application or starts a command connection',async()=>{
 const f=fixture();await assert.rejects(loadCodexMobile({...f.options,token:'invalid',request:async()=>new Response('{}',{status:401})}),/重新扫描/);
 assert(!f.calls.some(x=>x[0]==='connect'||x[0]==='mount'));
});

test('module download errors are surfaced for the visible retry screen',async()=>{
 const f=fixture();await assert.rejects(loadCodexMobile({...f.options,loadModule:async()=>{throw Error('network unavailable');}}),/network unavailable/);
 assert(!f.calls.some(x=>x[0]==='mount'));
});

test('a stuck module download has a bounded failure instead of an indefinite white screen',async()=>{
 const f=fixture();await assert.rejects(loadCodexMobile({...f.options,resourceTimeoutMs:15,loadModule:()=>new Promise(()=>{})}),/界面资源加载超时/);
 assert(!f.calls.some(x=>x[0]==='mount'));
});

test('a stuck websocket handshake has a visible bounded failure',async()=>{
 const f=fixture();f.compat.__codexOriginalConnect=()=>new Promise(()=>{});
 await assert.rejects(loadCodexMobile({...f.options,connectTimeoutMs:15}),/与电脑的连接超时/);
 assert(!f.calls.some(x=>x[0]==='mount'));
});

test('only two direct critical dependencies are preloaded',()=>{
 assert.equal(criticalPreloads.length,2);
 assert(criticalPreloads.every(p=>p.startsWith('/remote/v4/3.16.3/assets/')));
 assert(criticalPreloads.some(p=>p.includes('IntlProvider'))&&criticalPreloads.some(p=>p.includes('validation')));
});

test('original attachment viewer only bypasses base64 RPC for an exact same-origin native session image',()=>{
 const origin='https://phone.example',session='native-session';
 assert.equal(nativeAttachmentUrl('/mobile/api/image?threadId=native-session&ref=one',session,origin),'https://phone.example/mobile/api/image?threadId=native-session&ref=one&preview=1');
 for(const value of ['/mobile/api/image?threadId=other','/mobile/api/other?threadId=native-session','https://external.example/mobile/api/image?threadId=native-session','data:image/png;base64,AA==','file:///tmp/test.png','javascript:alert(1)','https://user:password@phone.example/mobile/api/image?threadId=native-session'])assert.equal(nativeAttachmentUrl(value,session,origin),null);
});

test('loading stages follow real pending resources, authentication, catalogue and mount promises',async()=>{
 const f=fixture(),pair=defer(),modules=defer(),catalogue=defer(),connection=defer(),mount=defer(),states=new Map();
 f.compat.__codexOriginalConnect=()=>connection.promise;
 f.adapter.mountCodexOriginalH5=()=>mount.promise;
 const pending=loadCodexMobile({...f.options,token:'fixture',onStage:(name,state='done')=>states.set(name,state),loadModule:path=>modules.promise.then(()=>path===main?f.compat:f.adapter),request:path=>path==='/api/pair'?pair.promise:catalogue.promise});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual([...states],[['resources','active'],['paired','active']]);
 modules.resolve();await tick();
 assert.equal(states.get('resources'),'done');assert.equal(states.get('paired'),'active');assert(!states.has('metadata'));
 pair.resolve(new Response('{}'));await tick();
 assert.equal(states.get('paired'),'done');assert.equal(states.get('metadata'),'active');assert(!states.has('connecting'));
 catalogue.resolve(new Response(JSON.stringify({authenticated:true,workspaces:[]})));await tick();
 assert.equal(states.get('metadata'),'done');assert(states.has('connecting'));assert(!states.has('mounted'));
 connection.resolve({});await tick();assert(!states.has('mounted'));
 mount.resolve(f.controller);await pending;assert.equal(states.get('mounted'),'done');
});

test('cookie authentication never reports a successful connection before server validation',async()=>{
 const f=fixture(),states=[];
 await assert.rejects(loadCodexMobile({...f.options,onStage:(name,state='done')=>states.push([name,state]),request:async()=>new Response('{}',{status:401})}),/重新扫描/);
 assert(!states.some(([name,state])=>name==='paired'&&state==='done'));
 assert(!states.some(([name])=>name==='mounted'));
});

test('mounted navigation refresh uses authenticated no-store server info and preserves auth failures',async()=>{
 const f=fixture(),seen=[];await loadCodexMobile({...f.options,onInfo:value=>seen.push(value),request:async(path,options)=>{
  if(path==='/api/server-info'){assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');return seen.length<2?new Response(JSON.stringify({authenticated:true,workspaces:[{path:seen.length?'/new':'/original'}]})):new Response('{}',{status:401});}
  return new Response('{}');
 }});
 const params=f.calls.find(call=>call[0]==='mount')[1];assert.equal((await params.refreshWorkspaceInfo()).workspaces[0].path,'/new');assert.equal(seen.length,2);
 await assert.rejects(params.refreshWorkspaceInfo(),/重新扫描/);
});
