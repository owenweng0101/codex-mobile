import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const compat=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
test('mobile submission clears both the editor and the persisted composer draft',()=>{
 const start=compat.indexOf('ie(),(a===`startNow`||__codexIsMobile())&&'),end=compat.indexOf(';let u=await V(',start);
 assert.ok(start>0&&end>start);let draft={text:'message'},editor='message',changes=0;
 const context={a:'enqueue',ie(){},__codexIsMobile:()=>true,dt:{current:{clear(){editor='';}}},xt(value){editor=value;context.st.current++;},__codexRestoreDraft(value){draft={...draft,...value};changes++;},st:{current:0},A:0,H:false};
 vm.runInNewContext(compat.slice(start,end),context);assert.equal(editor,'');assert.equal(draft.text,'');assert.equal(changes,1);assert.equal(context.H,true);
});
test('failed mobile send restores draft through the outer setter, not the code-comments array',()=>{
 const start=compat.indexOf('function W3t('),end=compat.indexOf('function ',start+9),component=compat.slice(start,end);
 assert.match(component,/updateComposerContent:d/);
 assert.match(component,/let __codexRestoreDraft=d,Gn=/);
 assert.match(component,/d=jn\(\),f=d\.length/);
 assert.match(component,/__codexIsMobile\(\)&&__codexRestoreDraft\(o\)/);
 assert.doesNotMatch(component,/__codexIsMobile\(\)&&d\(o\)/);
});
function draftManager({failure=false}={}){
 const start=compat.indexOf('PHt=class{'),end=compat.indexOf(',sH=new Map;',start);
 assert(start>0&&end>start);
 const creations=[],scheduled=[],context={setTimeout:(fn,ms)=>{const id=setTimeout(fn,ms);scheduled.push(ms);return id;},clearTimeout,Symbol,Map,NHt:[500,1000,2000],MHt:options=>{
  creations.push(options);
  queueMicrotask(()=>{if(!failure)options.onReady('native-codex-id');options.onSettled();});
  return{markPromotionPending(){},markPromoted(){},markDiscarded(){},dispose(){}};
 }};
 const Constructor=vm.runInNewContext('('+compat.slice(start+'PHt='.length,end)+')',context);
 return{manager:new Constructor('/fixture',()=>{},()=>({}),()=>{}),creations,scheduled};
}

test('opening and changing a draft does not allocate any native conversation',async()=>{
 const {manager,creations}=draftManager();
 const first={},second={};
 const release=manager.acquire({generation:first,invalidationVersion:0,onBinding(){}});
 assert.equal(creations.length,0);
 release();
 const releaseSecond=manager.acquire({generation:second,invalidationVersion:1,onBinding(){}});
 assert.equal(creations.length,0);
 const result=await manager.waitForSession(1,second);
 assert.equal(result.sessionId,'native-codex-id');
 assert.equal(creations.length,1);
 assert.equal((await manager.waitForSession(1,second)).sessionId,'native-codex-id');
 assert.equal(creations.length,1);
 result.promote();releaseSecond();
});

test('an uncertain native create does not schedule automatic new-command retries',async()=>{
 const {manager,creations,scheduled}=draftManager({failure:true}),generation={};
 const release=manager.acquire({generation,invalidationVersion:0,onBinding(){}});
 await assert.rejects(manager.waitForSession(0,generation),/草稿会话创建失败/);
 assert.equal(creations.length,1);
 assert(!scheduled.includes(500)&&!scheduled.includes(1000)&&!scheduled.includes(2000));
 await assert.rejects(manager.waitForSession(0,generation),/草稿会话创建失败/);
 assert.equal(creations.length,1);
 release();
});

test('a promoted draft is not followed by an automatically created replacement',async()=>{
 const {manager,creations}=draftManager(),generation={};
 const release=manager.acquire({generation,invalidationVersion:0,onBinding(){}});
 const binding=await manager.waitForSession(0,generation);binding.promote();
 const next={};const releaseNext=manager.acquire({generation:next,invalidationVersion:1,onBinding(){}});
 assert.equal(creations.length,1);
 releaseNext();release();
});

test('model choices use each native model default instead of the highest effort',()=>{
 const start=compat.indexOf('function jE(e,t){'),end=compat.indexOf('var S8e=',start);
 const choose=vm.runInNewContext('('+compat.slice(start,end)+')');
 const view={providers:[{providerId:'codex-app',models:[{modelId:'native',defaultReasoningEffort:'low',config:{optionSpecs:{reasoningLevel:{values:['low','medium','high','max']}}}}]}]};
 const result=choose(view,{providerId:'codex-app',modelId:'native'});
 assert.equal(result.options.reasoningLevel,'low');
});

test('Codex localization changes UI copy without inventing a new ignore-file contract',async()=>{
 const manifest=JSON.parse(await readFile(new URL('./bundle-patch-manifest.json',import.meta.url),'utf8'));
 const brand=manifest.localePatch.replacement.split('export{')[0];
 const messages={'zh-CN':{'chat.placeholder.newTask':'向 ZCode 提问','settings.workspaceFileSearch.description':'ZCode 使用 .zcodeignore'},'en-US':{'chat.placeholder.newTask':'Ask ZCode'}};
 vm.runInNewContext(brand,{_:messages});
 assert.equal(messages['zh-CN']['chat.placeholder.newTask'],'向 Codex 发送消息');
 assert.equal(messages['en-US']['chat.placeholder.newTask'],'Send a message to Codex');
 assert.equal(messages['zh-CN']['settings.workspaceFileSearch.description'],'Codex 使用 .zcodeignore');
});


test('the home greeting decoration is removed independently of greeting text',()=>{
 assert(compat.includes('function $3t({className:e}){return null}'));
 assert(compat.includes('function Q3t('));
});


test('Codex history does not auto-fetch every prior page to find a synthetic turn header',()=>{
 const start=compat.indexOf('function ble(e,t){'),end=compat.indexOf('function bu(e,t){',start);
 const snapshot={rows:{window:[{turnId:'latest-native-turn',kind:'assistantText'}]}};
 const codex=vm.runInNewContext('('+compat.slice(start,end)+')',{yu:()=>true,__CODEX_ORIGINAL_BRIDGE__:{codexBridge:true}});
 const original=vm.runInNewContext('('+compat.slice(start,end)+')',{yu:()=>true});
 assert.equal(codex(snapshot,false),false);
 assert.equal(original(snapshot,false),true);
 assert(compat.includes('function bu(e,t){'));
});

function realDraftManager(){
 const mStart=compat.indexOf('function MHt(e){'),mEnd=compat.indexOf('var NHt=',mStart),pStart=compat.indexOf('PHt=class{'),pEnd=compat.indexOf(',sH=new Map;',pStart);
 const calls=[],resolvers=[];let emptied=0;
 const context={setTimeout,clearTimeout,Map,Symbol,Promise,Array,J:{warn(){},info(){}},NHt:[500,1000,2000]};
 const Constructor=vm.runInNewContext(compat.slice(mStart,mEnd)+';('+compat.slice(pStart+'PHt='.length,pEnd)+')',context);
 const manager=new Constructor('/fixture',async(type,payload,sessionId)=>{calls.push({type,sessionId});if(type==='createSession')return new Promise(resolve=>resolvers.push(resolve));return{status:'accepted'};},()=>({}),()=>{emptied++;});
 return{manager,calls,resolvers,get emptied(){return emptied;}};
}
const waitTick=()=>new Promise(resolve=>setTimeout(resolve,5));

test('first send survives catalogue subscriber replacement while real native creation is pending',async()=>{
 const f=realDraftManager(),first={},replacement={};
 const releaseFirst=f.manager.acquire({generation:first,invalidationVersion:0,onBinding(){}});
 const sent=(async()=>{const binding=await f.manager.waitForSession(0,first);await Promise.resolve();assert.equal(binding.beginPromotion(),true);f.calls.push({type:'sendText',sessionId:binding.sessionId});binding.promote();return binding.sessionId;})();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'createSession');
 releaseFirst();await waitTick(); // Native create publishes its catalogue item and React remounts this pane.
 const releaseReplacement=f.manager.acquire({generation:replacement,invalidationVersion:0,onBinding(){}});
 f.resolvers[0]({status:'accepted',result:{type:'createSession',sessionId:'real-native-id'}});
 assert.equal(await sent,'real-native-id');
 assert.deepEqual(f.calls.map(call=>call.type),['createSession','sendText']);
 releaseReplacement();await waitTick();assert.equal(f.manager.current,null);
 // Reacquiring the same pane/version after promotion must not auto-create.
 const releaseLater=f.manager.acquire({generation:{},invalidationVersion:0,onBinding(){}});
 assert.equal(f.calls.filter(call=>call.type==='createSession').length,1);releaseLater();await waitTick();
});

test('a real native ACK arriving in a subscriber gap is retained until the submitted send promotes',async()=>{
 const f=realDraftManager(),generation={};const release=f.manager.acquire({generation,invalidationVersion:0,onBinding(){}});
 const pending=f.manager.waitForSession(0,generation);release();await waitTick();
 f.resolvers[0]({status:'accepted',result:{type:'createSession',sessionId:'native-in-gap'}});
 const binding=await pending;assert.equal(binding.beginPromotion(),true);f.calls.push({type:'sendText',sessionId:binding.sessionId});binding.promote();
 assert.deepEqual(f.calls.map(call=>call.type),['createSession','sendText']);assert.equal(f.manager.current,null);
});

test('an explicitly invalidated pending draft never sends or deletes the allocated native conversation',async()=>{
 const f=realDraftManager(),first={};const releaseFirst=f.manager.acquire({generation:first,invalidationVersion:0,onBinding(){}});
 const pending=f.manager.waitForSession(0,first);const rejected=assert.rejects(pending,/草稿会话已切换/);
 const releaseNext=f.manager.acquire({generation:{},invalidationVersion:1,onBinding(){}});releaseFirst();
 f.resolvers[0]({status:'accepted',result:{type:'createSession',sessionId:'allocated-before-user-navigation'}});await rejected;
 assert.deepEqual(f.calls.map(call=>call.type),['createSession']);releaseNext();await waitTick();
});

test('running activity shows a spinner ahead of unread while errors keep their indicator',()=>{
 const start=compat.indexOf('function Nut(e,t){'),end=compat.indexOf('function uj(',start);
 const indicator=vm.runInNewContext('('+compat.slice(start,end)+')');
 assert.equal(indicator({unreadAt:123},{phase:'running'}),'loading');
 assert.equal(indicator({}, {phase:'running'}),'loading');
 assert.equal(indicator({unreadAt:123},{phase:'completedSuccess'}),'unread');
 assert.equal(indicator({},null),'none');
 assert.equal(indicator({unreadAt:123},{phase:'error'}),'error');
});
