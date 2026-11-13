import test from 'node:test';
import assert from 'node:assert/strict';
import {createMobilePageState} from '../backend/page-state.mjs';
import {injectMobileShell} from '../backend/mobile.mjs';
function environment(){
 let value=null;const storage={getItem:()=>value,setItem:(key,next)=>{value=next}};
 const history={state:{hostRoute:'preserve'},replaceState(next){this.state=next}};
 return {storage,history};
}
test('refresh preserves explicit list and chat navigation without replacing host history fields',()=>{
 const env=environment(),first=createMobilePageState(env);
 first.setPage('list');assert.equal(createMobilePageState(env).page,'list');assert.equal(env.history.state.hostRoute,'preserve');
 first.setPage('chat');assert.equal(createMobilePageState(env).page,'chat');
});
test('startup and background-like reconstruction do not overwrite a saved list',()=>{
 const env=environment();createMobilePageState(env).setPage('list');
 for(let i=0;i<3;i++)assert.equal(createMobilePageState(env).page,'list');
 const second=environment();assert.equal(createMobilePageState(second).page,'chat','tabs do not share an in-memory selection');
});
test('history recovers a lost storage entry and storage survives unavailable history',()=>{
 const env=environment();createMobilePageState(env).setPage('list');
 assert.equal(createMobilePageState({storage:{getItem:()=>null},history:env.history}).page,'list');
 assert.equal(createMobilePageState({storage:env.storage,history:null}).page,'list');
});
test('blocked browser storage does not prevent navigation or corrupt stored host state',()=>{
 const broken={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}};
 const env=environment(),state=createMobilePageState({storage:broken,history:env.history});
 state.setPage('list');assert.equal(createMobilePageState({storage:broken,history:env.history}).page,'list');
 assert.equal(createMobilePageState({storage:broken,history:null}).page,'chat');
 assert.throws(()=>state.setPage('unsupported'),/Invalid mobile page/);assert.equal(state.page,'list');
});
test('the delivered shell restores its drawer before DOM ready and only explicit navigation persists',()=>{
 const html=injectMobileShell('<html><head></head><body></body></html>');
 const script=html.match(/<script id="dshm-mobile-shell">([\s\S]*?)<\/script>/)[1];
 assert.doesNotThrow(()=>new Function(script));
 assert.match(script,/let listOpen = pageState.page === 'list'/);
 assert.ok(script.lastIndexOf('applyListState();')<script.indexOf("if (document.readyState === 'loading')"));
 assert.equal((script.match(/pageState\.setPage\(/g)||[]).length,2);
 const layout=script.slice(script.indexOf('function layout()'),script.indexOf('function tagChrome()'));
 assert.doesNotMatch(layout,/setPage/);
});
