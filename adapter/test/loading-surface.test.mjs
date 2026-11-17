import test from 'node:test';
import assert from 'node:assert/strict';
import {loadingSurface} from '../codex-entry.mjs';

function fixture(t){
  const keys=['document','setTimeout','clearTimeout','location','requestAnimationFrame'];
  const originals=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const timers=new Map();let next=0,reloads=0;
  function element(tag){
    const children=new Map(),attributes=new Map();
    return{tag,dataset:{},attributes,hidden:false,removed:false,setAttribute:(name,value)=>attributes.set(name,value),remove(){this.removed=true;},querySelector(selector){return children.get(selector);},set innerHTML(value){this.markup=value;for(const [,id] of value.matchAll(/id="([^"]+)"/g)){const child=element('child');child.hidden=value.includes('id="'+id+'" hidden');children.set('#'+id,child);}}};
  }
  const heads=[],bodies=[],document={documentElement:{dataset:{}},head:{appendChild:node=>heads.push(node)},body:{appendChild:node=>bodies.push(node)},createElement:element};
  Object.assign(globalThis,{document,setTimeout(fn,ms){const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),location:{reload:()=>reloads++},requestAnimationFrame:()=>assert.fail('completion must not wait extra animation frames')});
  t.after(()=>{for(const [key,value]of originals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const surface=loadingSurface();return{surface,root:bodies[0],style:heads[0],timers,get reloads(){return reloads;}};
}

test('Codex readiness boundary has no brand image, title or launch checklist',t=>{
  const f=fixture(t);assert.doesNotMatch(f.root.markup,/<img|<h1|<ol|<li\b|class="brand"|Codex/);
  assert.match(f.root.markup,/正在加载/);assert.equal(f.root.attributes.get('aria-busy'),'true');assert.equal(f.root.removed,false);
  f.surface.stage('resources','active');assert.equal(f.root.dataset.stage,'resources');assert.equal(f.root.removed,false);
  f.surface.stage('mounted');assert.equal(f.root.removed,false,'only verified bootstrap completion can expose the underlying task');
  f.surface.complete();assert.equal(f.root.removed,true);assert.equal(f.style.removed,true);assert.equal(f.timers.size,0);
});

test('auth and transport errors retain an actionable neutral error state rather than hiding the boundary',t=>{
  const f=fixture(t),message='请重新扫描桌面统一二维码';f.surface.error(Error(message));
  assert.equal(f.root.removed,false);assert.equal(f.root.attributes.get('aria-busy'),'false');
  assert.equal(f.root.querySelector('#codex-loading-note').textContent,message);assert.equal(f.root.querySelector('#codex-loading-note').hidden,false);
  const retry=f.root.querySelector('#codex-loading-retry');assert.equal(retry.hidden,false);assert.equal(retry.textContent,'重试');retry.onclick();assert.equal(f.reloads,1);assert.equal(f.timers.size,0);
  assert.equal(f.root.querySelector('#codex-loading-home').hidden,false);
  assert.match(f.root.markup,/>返回首页</);assert.match(f.style.textContent,/min-height:44px/);assert.match(f.style.textContent,/border-radius:12px/);assert.doesNotMatch(f.style.textContent,/999px/);
  assert.match(f.style.textContent,/--cm-ink/);assert.match(f.style.textContent,/--cm-canvas/);
});

test('a slow load exposes retry but never removes an unverified view boundary',t=>{
  const f=fixture(t);assert.equal(f.root.querySelector('#codex-loading-retry').hidden,true);
  const timer=[...f.timers.values()].find(value=>value.ms===30000);timer.fn();
  assert.equal(f.root.querySelector('#codex-loading-retry').hidden,false);assert.equal(f.root.querySelector('#codex-loading-home').hidden,false);assert.equal(f.root.removed,false);f.surface.complete();
});
