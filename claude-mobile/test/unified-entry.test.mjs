import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {withHubFrame,isHubFrameRequest,hubEntryGuard} from '../../connection/mobile-entry.mjs';
const source=readFileSync(new URL('../backend/server.mjs',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function json('),source.indexOf('function lanAddresses('));
const handler=source.slice(source.indexOf('async function start('),source.indexOf('\nfunction readBody(')).replaceAll('import.meta.url','"file:///fixture/server.mjs"');
const target='https://mobile.example:10443/m/#';
function fixture(){
 const sandbox={URL,Buffer,withHubFrame,isHubFrameRequest,hubEntryGuard,unifiedEntryTarget:async()=>target,
  accessToken:'module-secret',COOKIE_CLAUDE:'clm-auth',COOKIE_DESK:'desk-auth',COOKIE_MAX_AGE_DAYS:30,log(){},
  publicOriginFrom:()=>null,claudeReadiness:async()=>({cli:'fixture',launch:{}}),hubHtml:()=>'<html><head></head><body>hub</body></html>',chatHtml:()=>'<html><head><script>MODULE_BOOT()</script></head><body>module</body></html>',
  readEntries:async()=>({codex:{ready:true,url:withHubFrame('https://mobile.example/#'+'a'.repeat(43))},dsh:{ready:true,url:withHubFrame('/dsh/?t=dsh-secret')}}),
 };
 const start=runInNewContext(functions+'\n'+handler+'\nstart;',sandbox);
 return async(url,headers={},method='GET')=>{
  const res={headers:{},setHeader(key,value){this.headers[key]=value;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(body=''){this.body=body;},on(){}};
  await start({url,method,headers},res);return res;
 };
}
for(const method of ['GET','HEAD'])for(const path of ['/claude','/claude/','/claude/index.html'])test(`${method} ${path} redirects legacy top navigation without promoting credentials`,async()=>{
 const invoke=fixture();
 for(const headers of [{},{'sec-fetch-dest':'document',cookie:'clm-auth=module-secret'},{'sec-fetch-dest':'empty'}]){
  const result=await invoke(path+'?t=module-secret&hub_frame=1#old',headers,method);
  // With no metadata, the marker permits only the guarded HTML/token exchange.
  if(!Object.hasOwn(headers,'sec-fetch-dest'))continue;
  assert.equal(result.status,302);assert.equal(result.headers.location,target);assert.equal(result.headers['set-cookie'],undefined);assert.equal(result.body,'');
 }
 const legacy=await invoke(path+'?t=module-secret',{},method);assert.equal(legacy.status,302);assert.equal(legacy.headers.location,target);assert.equal(legacy.headers['set-cookie'],undefined);
});
test('iframe auth exchange preserves marker and never sets desk-auth',async()=>{
 const invoke=fixture();
 assert.equal((await invoke('/claude/',{'sec-fetch-dest':'iframe'})).status,401);
 const invalid=await invoke('/claude/?t=wrong&hub_frame=1',{'sec-fetch-dest':'iframe'});assert.equal(invalid.status,401);
 const result=await invoke('/claude/?t=module-secret',{'sec-fetch-dest':'iframe'});assert.equal(result.status,302);assert.equal(result.headers.location,'/claude/?hub_frame=1');
 assert.equal(result.headers['set-cookie'].length,1);assert.match(result.headers['set-cookie'][0],/^clm-auth=/);assert.doesNotMatch(result.headers['set-cookie'][0],/desk-auth/);
 assert.equal((await invoke('/m/',{cookie:'clm-auth=module-secret'})).status,401);
});
test('headerless marker HTML receives the first-script top-level redirect guard',async()=>{
 const result=await fixture()('/claude/?hub_frame=1',{cookie:'clm-auth=module-secret'});assert.equal(result.status,200);
 const scripts=[...result.body.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];assert.match(scripts[0][0],/data-hub-entry-guard/);assert.match(scripts[1][1],/MODULE_BOOT/);
 let redirected;const window={self:{},stop(){},location:{replace:value=>{redirected=value;}}};window.top=window.self;const document={documentElement:{style:{}}};runInNewContext(scripts[0][1],{window,document});assert.equal(redirected,target);assert.equal(document.documentElement.style.visibility,'hidden');
 redirected=null;window.top={};runInNewContext(scripts[0][1],{window,document});assert.equal(redirected,null);
});
test('the unified entries API marks all three frames and still requires desk-auth',async()=>{
 const invoke=fixture();assert.equal((await invoke('/m/api/entries',{cookie:'clm-auth=module-secret'})).status,401);
 const result=await invoke('/m/api/entries',{cookie:'desk-auth=module-secret'});assert.equal(result.status,200);const entries=JSON.parse(result.body);
 for(const entry of Object.values(entries))assert.equal(new URL(entry.url,'https://mobile.example').searchParams.get('hub_frame'),'1');
 assert.equal(new URL(entries.codex.url).hash,'#'+'a'.repeat(43));assert.equal(new URL(entries.dsh.url,'https://mobile.example').searchParams.get('t'),'dsh-secret');
});
test('real Codex/DSH entry builders preserve credentials, query bytes and fragments while adding the marker',async()=>{
 const code=readFileSync(new URL('../backend/lib/entries.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export async function readEntries','async function readEntries');
 const readEntries=runInNewContext(code+'\nreadEntries;',{URL,AbortSignal,Date,withHubFrame,homedir:()=>'/fixture',join:(...parts)=>parts.join('/'),readFile:async()=>JSON.stringify({status:'online',mode:'codex-read',origin:'https://mobile.example:10443'}),fetch:async url=>({ok:true,json:async()=>String(url).includes('/local/info')?{url:'http://127.0.0.1/#'+'b'.repeat(43)}:{service:'dsh-mobile',status:'online',phoneUrl:'https://mobile.example:10443/dsh/?t=secret%2Bvalue&v=3#unchanged',upstreamReady:true}})});
 const entries=await readEntries('https://mobile.example:10443');assert.equal(entries.codex.url,'https://mobile.example:10443/?hub_frame=1#'+'b'.repeat(43));assert.equal(entries.dsh.url,'https://mobile.example:10443/dsh/?t=secret%2Bvalue&v=3&hub_frame=1#unchanged');
});
