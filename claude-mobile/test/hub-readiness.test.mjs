import test from 'node:test';
import assert from 'node:assert/strict';
import {installMobileHubReadiness} from '../backend/lib/hub-readiness.mjs';

function element(attrs={}){
  const children=new Map();
  return {attrs,children,querySelector:s=>children.get(s)||null,getAttribute:k=>attrs[k]??null,hasAttribute:k=>Object.hasOwn(attrs,k)};
}
function fixture(name='dsh'){
  const nodes=new Map(),timers=new Map();let id=0;
  const window={setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)};
  const api=installMobileHubReadiness(window);
  const doc={body:{},documentElement:{dataset:{dshmDrawer:'closed'}},querySelector:s=>nodes.get(s)||null,getElementById:s=>nodes.get('#'+s)||null};
  const frame={dataset:{frame:name},contentDocument:doc,contentWindow:{}};
  return {api,doc,frame,nodes,timers,advance(){const next=[...timers];timers.clear();for(const [,fn]of next)fn();}};
}
test('DSH has one pending phase across boot, restoration, history and scroll positioning',()=>{
  const f=fixture();assert.equal(f.api.inspect(f.frame),'loading');
  f.nodes.set('[data-dshm-menu]',element());
  const main=element({'data-dshm-conversation-state':'pending','data-phase':'settling'});f.nodes.set('[data-dshm-conversation-state]',main);
  assert.equal(f.api.inspect(f.frame),'loading');
  main.attrs['data-dshm-conversation-state']='ready';main.attrs['data-phase']='active';
  const history=element({'data-dshm-history-state':'loading'});main.children.set('[data-dshm-history-state]',history);
  assert.equal(f.api.inspect(f.frame),'loading');
  history.attrs['data-dshm-history-state']='open';assert.equal(f.api.inspect(f.frame),'loading');
  history.attrs['data-dshm-history-positioned']='';assert.equal(f.api.inspect(f.frame),'ready');
  history.attrs['data-loading-older']='true';assert.equal(f.api.inspect(f.frame),'ready','older paging does not reopen full-screen loading');
});
test('DSH empty workspace catalogue and genuine new draft can finish without history rows',()=>{
  const f=fixture();f.nodes.set('[data-dshm-menu]',element());f.doc.documentElement.dataset.dshmDrawer='open';
  const list=element({'data-dshm-workspace-state':'loading'});f.nodes.set('[data-dshm-workspace-state]',list);
  assert.equal(f.api.inspect(f.frame),'loading');list.attrs['data-dshm-workspace-state']='ready';assert.equal(f.api.inspect(f.frame),'ready');
  f.doc.documentElement.dataset.dshmDrawer='closed';f.nodes.set('[data-dshm-conversation-state]',element({'data-dshm-conversation-state':'ready','data-phase':'hero'}));
  assert.equal(f.api.inspect(f.frame),'ready');
});
test('native restoration/history errors are terminal visible states, not infinite loading',()=>{
  const f=fixture();f.nodes.set('[data-dshm-menu]',element());const main=element({'data-dshm-conversation-state':'error'});f.nodes.set('[data-dshm-conversation-state]',main);
  assert.equal(f.api.inspect(f.frame),'error');main.attrs['data-dshm-conversation-state']='ready';main.children.set('[data-dshm-history-state]',element({'data-dshm-history-state':'error'}));assert.equal(f.api.inspect(f.frame),'error');
});
test('child reports are authoritative; missing and unrecognized states never become ready',()=>{
  for(const name of ['codex','claude']){const f=fixture(name);assert.equal(f.api.inspect(f.frame),'loading');for(const value of ['loading','ready','error','unexpected']){f.frame.contentWindow.__mobileHubReadiness=()=>value;assert.equal(f.api.inspect(f.frame),value==='unexpected'?'loading':value);}}
});
test('watch ends once at content readiness and never follows streaming or a retired document',()=>{
  const f=fixture('claude');let state='loading',calls=0;f.frame.contentWindow.__mobileHubReadiness=()=>state;
  f.api.wait(f.frame,()=>calls++);f.advance();assert.equal(calls,0);state='ready';f.advance();assert.equal(calls,1);assert.equal(f.timers.size,0);
  state='loading';f.api.wait(f.frame,()=>calls++);f.frame.contentDocument={...f.doc};f.advance();assert.equal(calls,1);assert.equal(f.timers.size,0);
});
test('timeout/reload cancellation prevents late success and cleans pending work',()=>{
  const f=fixture('claude');let state='loading',calls=0;f.frame.contentWindow.__mobileHubReadiness=()=>state;
  const cancel=f.api.wait(f.frame,()=>calls++);cancel();state='ready';f.advance();assert.equal(calls,0);assert.equal(f.timers.size,0);
});
