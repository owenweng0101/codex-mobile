import test from 'node:test';
import assert from 'node:assert/strict';
import {installDshLoadingGate} from '../backend/loading-gate.mjs';
import {injectMobileShell} from '../backend/mobile.mjs';
function fixture(){
  let phase='loading',observe,timeout,errorText,reloads=0,homes=0,removed=0,disconnected=0;
  const events={};
  const nodes=[];const node=()=>{const n={dataset:{},children:[],appendChild(child){this.children.push(child);}};nodes.push(n);return n;};
  const gate={...node(),textContent:'正在加载…',remove(){removed++;},setAttribute(){}};
  const document={documentElement:{},getElementById:()=>gate,createElement:node,querySelector:()=>errorText?{textContent:errorText}:null};
  const view={clearTimeout(){},setTimeout(fn){timeout=fn;return 1;},addEventListener(name,fn){events[name]=fn;},location:{reload(){reloads++;}},MutationObserver:class{constructor(fn){observe=fn;}observe(){}disconnect(){disconnected++;}}};
  const stop=installDshLoadingGate({document,view,inspect:()=>phase,returnHome:()=>{homes++;}});
  return {gate,stop,nodes,set:(value,notify=true)=>{phase=value;if(notify)observe();},error:value=>{errorText=value;},event:(name,value)=>events[name]?.(value),timeout:()=>timeout(),get removed(){return removed;},get disconnected(){return disconnected;},get reloads(){return reloads;},get homes(){return homes;}};
}
test('local full-screen gate remains across restoration and initial history and removes only once',()=>{
  const f=fixture();f.set('loading');assert.equal(f.removed,0);f.set('loading');assert.equal(f.removed,0);f.set('ready');assert.equal(f.removed,1);f.set('loading');assert.equal(f.removed,1);assert.equal(f.disconnected,1);
});
test('native errors and timeouts provide both retry and a home escape',()=>{
  for(const kind of ['error','timeout']){const f=fixture();if(kind==='error')f.set('error');else f.timeout();assert.equal(f.removed,0);f.nodes.find(n=>n.textContent==='重试').onclick();assert.equal(f.reloads,1);f.nodes.find(n=>n.textContent==='返回首页').onclick();assert.equal(f.homes,1);}
});
test('late native readiness recovers a timeout or transient error without requiring a reload',()=>{
  for(const kind of ['error','timeout']){
    const f=fixture();if(kind==='error')f.set('error');else f.timeout();
    assert.equal(f.disconnected,0,'the error UI must not cancel native readiness observation');
    const rendered=f.nodes.length;f.set('loading');f.set('error');assert.equal(f.nodes.length,rendered,'no repeated recovery controls');
    f.set('ready');assert.equal(f.removed,1);assert.equal(f.disconnected,1);assert.equal(f.reloads,0);
    f.set('ready');assert.equal(f.removed,1);
  }
});
test('a late native error replaces a timeout message without duplicating the recovery actions',()=>{
  const f=fixture();f.timeout();const rendered=f.nodes.length;
  f.error('真实错误：工作区无访问权限');f.set('error');
  assert.equal(f.gate.children[0].textContent,'真实错误：工作区无访问权限');assert.equal(f.nodes.length,rendered);
  f.set('ready');assert.equal(f.removed,1);
});
test('BFCache return rechecks readiness, while a real unload disposes the gate',()=>{
  const f=fixture();f.event('pagehide',{persisted:true});assert.equal(f.disconnected,0);
  f.set('ready',false);f.event('pageshow',{persisted:true});assert.equal(f.removed,1);assert.equal(f.disconnected,1);
  f.event('pagehide',{persisted:false});assert.equal(f.disconnected,1,'cleanup is idempotent');
  const gone=fixture();gone.event('pagehide',{persisted:false});gone.set('ready');assert.equal(gone.removed,0);assert.equal(gone.disconnected,1);
});
test('parser inserts a single gate before the application root even on reinjection',()=>{
  const html=injectMobileShell('<html><head></head><body><div id="root"></div></body></html>');
  assert.ok(html.indexOf('<div id="dshm-loading"')<html.indexOf('<div id="root"'));
  assert.equal((injectMobileShell(html).match(/<div id="dshm-loading"/g)||[]).length,1);
  assert.match(html,/#dshm-loading \{ position: fixed; inset: 0;/);
});
