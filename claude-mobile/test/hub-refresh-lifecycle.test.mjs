import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {hubHtml,chatHtml} from '../backend/lib/ui.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function node(dataset={}){
  const listeners=new Map(),classes=new Set(),attributes=new Map();
  return{dataset,attributes,listeners,style:{setProperty(){}},classList:{add:key=>classes.add(key),remove:key=>classes.delete(key),contains:key=>classes.has(key),toggle(key,on){if(on)classes.add(key);else classes.delete(key);}},setAttribute:(key,value)=>attributes.set(key,value),getAttribute:key=>attributes.get(key),addEventListener(type,listener){listeners.set(type,listener);},emit(type,event={}){listeners.get(type)?.(event);}};
}
async function fixture({tab='codex',entriesGate,entriesStatus=200}={}){
  const names=['codex','dsh','claude'],buttons=names.map(tab=>node({tab}));
  const timers=new Map(),requests=[],calls=[],ids=new Map(['stage','loading','error','errorText','retry','returnHome','refreshNotice'].map(id=>[id,node()]));
  let timerId=0;
  const frames=names.map(name=>{
    const frame=node({frame:name});let src='';frame.srcWrites=0;frame.reloads=0;
    Object.defineProperty(frame,'src',{get:()=>src,set:value=>{src=value;frame.srcWrites++;}});
    frame.contentDocument={documentElement:{dataset:{dshmDrawer:'closed'}},getElementById:()=>null,querySelector:()=>null};
    frame.contentWindow={location:{reload(){frame.reloads++;calls.push(name+':reload');}},postMessage(){}};
    return frame;
  });
  const window=node();window.installMobileHubChrome=()=>name=>calls.push('chrome:'+name);
  window.waitMobileHubReady=(frame,done)=>{let canceled=false;frame.settleReadiness=()=>{if(!canceled)done('ready');};if(!frame.holdReadiness)frame.settleReadiness();return()=>{canceled=true;};};
  const document=node();document.documentElement=node();document.querySelectorAll=selector=>selector==='.capsule button'?buttons:frames;document.getElementById=id=>ids.get(id);
  document.createElement=()=>assert.fail('hub must not create a replacement iframe or copy conversation DOM');
  const context={window,document,AbortController,location:{origin:'https://phone.example',reload(){}},localStorage:{getItem:()=>tab,setItem(){}},innerHeight:800,requestAnimationFrame:()=>1,cancelAnimationFrame(){},setInterval:()=>1,setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),fetch:async(url,options)=>{
    requests.push({url,options});
    if(url==='/m/api/build')return{ok:true,json:async()=>({build:'fixture'})};
    if(entriesGate)await entriesGate.promise;
    return{ok:entriesStatus===200,status:entriesStatus,json:async()=>Object.fromEntries(names.map(name=>[name,{ready:true,url:'/'+name+'/'}]))};
  }};
  const scripts=[...hubHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts.at(-1)[1],context);await tick();
  return{buttons,frames,requests,calls,timers,ids,frame:name=>frames.find(frame=>frame.dataset.frame===name),click:name=>buttons.find(button=>button.dataset.tab===name).emit('click'),loaded:name=>frames.find(frame=>frame.dataset.frame===name).emit('load')};
}

test('hub and Claude startup states use plain loading text without removing resident titles or errors',()=>{
  const hub=hubHtml(),chat=chatHtml();
  assert.match(hub,/<div class="notice" id="loading" role="status" aria-live="polite">正在加载…<\/div>/);
  assert.doesNotMatch(hub,/正在读取三个入口|class="spinner"/);
  assert.match(hub,/#loading\{z-index:2;background:var\(--surface\)\}/);
  assert.match(chat,/listStatus\(state\.sessions\.length\?'':'正在加载…'\)/);
  assert.match(chat,/loading\.textContent='正在加载…'/);
  assert.doesNotMatch(chat,/正在加载会话…|正在加载对话…/);
  assert.match(chat,/<div class="title" id="title">Claude<\/div>/);
  assert.match(chat,/刷新失败，保留上次列表/);
  assert.match(chat,/\.err:not\(\.recovery-error\) button/,'generic error pills must not override recovery buttons');
  assert.match(chat,/\.recovery-error>button\{[^}]*min-height:44px[^}]*border-radius:12px/);
});

test('active capsule reloads exactly its current iframe once until load completes',async()=>{
  const f=await fixture(),frame=f.frame('codex');f.loaded('codex');
  f.click('codex');f.click('codex');
  assert.equal(frame.reloads,1);assert.equal(frame.srcWrites,1);
  assert.equal(frame.dataset.refreshing,'1');assert.equal(f.buttons[0].getAttribute('aria-busy'),'true');
  assert.equal(f.frames.filter(frame=>frame.classList.contains('active')).length,1);
  assert.equal(f.requests.filter(request=>request.url==='/m/api/entries').length,1);
  assert.equal(f.frame('claude').reloads,0);assert.equal(f.frame('dsh').reloads,0);
  f.loaded('codex');assert.equal(frame.dataset.refreshing,'');
  f.click('codex');assert.equal(frame.reloads,2);
  assert.equal((hubHtml().match(/<iframe data-frame=/g)||[]).length,3);
});

test('document load never reveals restore/history phases before current view readiness',async()=>{
  for(const tab of ['codex','dsh','claude']){
    const f=await fixture({tab}),frame=f.frame(tab);frame.holdReadiness=true;f.loaded(tab);
    assert.equal(f.ids.get('loading').classList.contains('hidden'),false);
    assert.equal(frame.dataset.ready,'');f.click(tab);assert.equal(frame.reloads,0);
    frame.settleReadiness();assert.equal(frame.dataset.ready,'1');
    assert.equal(f.ids.get('loading').classList.contains('hidden'),true);
  }
});

test('readiness belongs to one document and cannot finish a later load generation',async()=>{
  const f=await fixture({tab:'dsh'}),frame=f.frame('dsh');frame.holdReadiness=true;f.loaded('dsh');
  const obsolete=frame.settleReadiness;
  frame.contentDocument={...frame.contentDocument};f.loaded('dsh');obsolete();
  assert.equal(frame.dataset.ready,'');assert.equal(f.ids.get('loading').classList.contains('hidden'),false);
  frame.settleReadiness();assert.equal(frame.dataset.ready,'1');
});

test('failed conversations can return home without deleting drafts or other browser state',async()=>{
  for(const tab of ['codex','dsh','claude']){
    const f=await fixture({tab}),frame=f.frame(tab),saved=new Map([['draft-kept','unsent text']]);
    frame.contentWindow.sessionStorage={setItem:(key,value)=>saved.set(key,value)};
    frame.contentWindow.history={state:{other:'kept'},replaceState(value){this.state=value;}};
    f.loaded(tab);f.ids.get('returnHome').emit('click');await tick();
    assert.equal(frame.reloads,1);assert.equal(saved.get('draft-kept'),'unsent text');assert.equal(frame.contentWindow.history.state.other,'kept');
    if(tab==='codex')assert.equal(JSON.parse(saved.get('codex-mobile-current-view-v1')).kind,'home');
    if(tab==='dsh')assert.equal(saved.get('dsh-mobile-current-page-v1'),'list');
    if(tab==='claude')assert.equal(JSON.parse(saved.get('clm-current-view-v1')).kind,'list');
  }
});

test('initial entry discovery coalesces repeated taps and in-flight documents do not reload',async()=>{
  const gate=deferred(),f=await fixture({entriesGate:gate});
  f.click('codex');f.click('codex');
  assert.equal(f.requests.filter(request=>request.url==='/m/api/entries').length,1);
  gate.resolve();await tick();f.click('codex');assert.equal(f.frame('codex').reloads,0);
});

test('entry discovery has a deadline and retry is not locked by a hung old response',async()=>{
  const gate=deferred(),f=await fixture({entriesGate:gate});
  const deadline=[...f.timers.values()].find(timer=>timer.ms===15000);assert.ok(deadline);
  deadline.fn();await tick();assert.match(f.ids.get('errorText').textContent,/读取入口超时/);
  f.ids.get('retry').emit('click');await tick();assert.equal(f.requests.filter(r=>r.url==='/m/api/entries').length,2);
  gate.resolve();await tick();assert.equal(f.frame('codex').srcWrites,1,'expired response must not apply stale entries');
});

test('entry authentication failure explains re-pairing instead of blaming desktop services',async()=>{
  const f=await fixture({entriesStatus:401});assert.match(f.ids.get('errorText').textContent,/重新扫描/);
  assert.equal(f.ids.get('loading').classList.contains('hidden'),true);
});

test('Codex and DSH refresh preserves in-memory attachments and sends without blocking ordinary refresh',async()=>{
  for(const tab of ['codex','dsh']){
    const f=await fixture({tab}),frame=f.frame(tab);f.loaded(tab);
    let safe=false;frame.contentWindow[tab==='dsh'?'__dshMobileReloadSafe':'__codexMobileReloadSafe']=()=>safe;
    f.click(tab);assert.equal(frame.reloads,0);assert.equal(f.ids.get('refreshNotice').hidden,false);
    f.ids.get('returnHome').emit('click');await tick();assert.equal(frame.reloads,0,'home recovery must not discard attachments either');
    assert.equal(f.ids.get('error').classList.contains('hidden'),true,'refresh protection must not cover the composer');
    safe=true;f.click(tab);assert.equal(frame.reloads,1);
    f.click('claude');assert.equal(f.ids.get('refreshNotice').hidden,true,'notice must not follow the user to Claude');
  }
});

test('changed entry URLs never replace a Codex or DSH document holding unsaved memory state',async()=>{
  for(const tab of ['codex','dsh']){
    const f=await fixture({tab}),frame=f.frame(tab);f.loaded(tab);
    let safe=false;frame.contentWindow[tab==='dsh'?'__dshMobileReloadSafe':'__codexMobileReloadSafe']=()=>safe;
    frame.dataset.currentUrl='/previous-entry/';f.click('claude');f.loaded('claude');f.click(tab);
    assert.equal(frame.srcWrites,1);assert.equal(frame.dataset.currentUrl,'/previous-entry/');
    safe=true;f.click('claude');f.click(tab);assert.equal(frame.srcWrites,2);
    assert.equal(frame.dataset.currentUrl,'/'+tab+'/');
  }
});

test('DSH preparation occurs before reload and bypasses delayed legacy drawer toggles',async()=>{
  const f=await fixture({tab:'dsh'}),frame=f.frame('dsh');f.loaded('dsh');
  frame.contentWindow.__dshMobilePrepareRefresh=()=>{f.calls.push('prepare:chat');return{page:'chat'};};
  f.click('dsh');assert.deepEqual(f.calls.slice(-2),['prepare:chat','dsh:reload']);
  f.loaded('dsh');assert.equal(frame.dataset.refreshPrepared,undefined);assert.equal(frame.dataset.refreshDrawer,undefined);
  assert.equal([...f.timers.values()].filter(timer=>timer.ms===300).length,0);
});

test('old DSH without a preparation hook retains the closed-drawer compatibility fallback',async()=>{
  const f=await fixture({tab:'dsh'}),frame=f.frame('dsh');f.loaded('dsh');f.click('dsh');f.loaded('dsh');
  let closed=0;frame.contentDocument.documentElement.dataset.dshmDrawer='open';
  frame.contentDocument.querySelector=selector=>selector==='[data-dshm-menu]'?{click:()=>closed++}:null;
  const delayed=[...f.timers.values()].find(timer=>timer.ms===300);assert.ok(delayed);delayed.fn();assert.equal(closed,1);
});

test('Claude soft refresh keeps the same document and coalesces taps until its read settles',async()=>{
  const f=await fixture({tab:'claude'}),frame=f.frame('claude'),read=deferred();let reads=0;f.loaded('claude');
  frame.contentWindow.__claudeMobileRefresh=()=>{reads++;return read.promise;};
  f.click('claude');f.click('claude');await tick();
  assert.equal(reads,1);assert.equal(frame.reloads,0);assert.equal(frame.srcWrites,1);assert.equal(frame.dataset.refreshing,'1');
  assert.equal(f.ids.get('loading').classList.contains('hidden'),false,'soft reads use the same neutral loading feedback');
  read.resolve();await tick();assert.equal(frame.dataset.refreshing,'');assert.equal(f.ids.get('error').classList.contains('hidden'),true);
  assert.equal(f.ids.get('loading').classList.contains('hidden'),true);
});

test('switching apps syncs neutral refresh feedback and an old completion cannot hide the current refresh',async()=>{
  const f=await fixture({tab:'claude'}),read=deferred(),loading=f.ids.get('loading');f.loaded('claude');
  f.frame('claude').contentWindow.__claudeMobileRefresh=()=>read.promise;
  f.click('claude');await tick();assert.equal(loading.classList.contains('hidden'),false);
  f.click('codex');f.loaded('codex');assert.equal(loading.classList.contains('hidden'),true);
  f.click('codex');assert.equal(loading.classList.contains('hidden'),false);
  read.resolve();await tick();assert.equal(loading.classList.contains('hidden'),false,'inactive Claude completion must not hide Codex loading');
  f.click('claude');assert.equal(loading.classList.contains('hidden'),true);
  f.click('codex');assert.equal(loading.classList.contains('hidden'),false,'returning to an in-flight refresh restores its loading feedback');
  f.loaded('codex');assert.equal(loading.classList.contains('hidden'),true);
});

test('soft refresh errors stay visible and clear the busy state without destroying the frame',async()=>{
  const f=await fixture({tab:'claude'}),frame=f.frame('claude');f.loaded('claude');
  let reads=0;frame.contentWindow.__claudeMobileRefresh=async()=>{reads++;throw Error('读取失败，保留当前内容');};
  f.click('claude');await tick();assert.equal(frame.reloads,0);assert.equal(frame.dataset.refreshing,'');
  assert.equal(f.ids.get('error').classList.contains('hidden'),false);assert.equal(f.ids.get('errorText').textContent,'读取失败，保留当前内容');
  f.ids.get('retry').emit('click');await tick();assert.equal(reads,2,'retry must repeat the failed read, not merely hide its error');
});

test('an inactive iframe timeout cannot cover the newly selected app or mislabel its error',async()=>{
  const f=await fixture(),frame=f.frame('codex');f.loaded('codex');f.click('codex');
  const timer=f.timers.get(frame._watchdog);f.click('claude');f.loaded('claude');timer.fn();
  assert.equal(f.ids.get('error').classList.contains('hidden'),true);assert.match(frame.dataset.loadError,/^Codex/);
  assert.equal(f.frame('claude').classList.contains('active'),true);
});

test('slow Codex and DSH readiness recovers after the bounded shell deadline',async()=>{
  for(const tab of ['codex','dsh']){
    const f=await fixture({tab}),frame=f.frame(tab);frame.holdReadiness=true;f.loaded(tab);
    const watchdog=f.timers.get(frame._watchdog);assert.equal(watchdog.ms,90000);
    watchdog.fn();assert.equal(f.ids.get('error').classList.contains('hidden'),false);
    assert.equal(frame.dataset.loaded,'1','deadline must not discard the still-loading document');
    frame.settleReadiness();assert.equal(frame.dataset.ready,'1');
    assert.equal(f.ids.get('error').classList.contains('hidden'),true);assert.equal(frame.dataset.loadError,undefined);
    assert.equal(frame.reloads,0);
  }
});

test('late inactive Codex readiness cannot dismiss the active DSH error',async()=>{
  const f=await fixture(),codex=f.frame('codex'),dsh=f.frame('dsh');
  codex.holdReadiness=true;f.loaded('codex');f.timers.get(codex._watchdog).fn();
  f.click('dsh');dsh.holdReadiness=true;f.loaded('dsh');f.timers.get(dsh._watchdog).fn();
  codex.settleReadiness();assert.equal(codex.dataset.ready,'1');
  assert.equal(f.ids.get('error').classList.contains('hidden'),false);assert.match(f.ids.get('errorText').textContent,/^DSH/);
  dsh.settleReadiness();assert.equal(f.ids.get('error').classList.contains('hidden'),true);
});

test('timed out Codex and DSH can explicitly retry without an obsolete ready callback winning',async()=>{
  for(const tab of ['codex','dsh']){
    const f=await fixture({tab}),frame=f.frame(tab);frame.holdReadiness=true;f.loaded(tab);
    const obsolete=frame.settleReadiness;f.timers.get(frame._watchdog).fn();
    f.ids.get('retry').emit('click');await tick();assert.equal(frame.srcWrites,2);
    obsolete();assert.equal(frame.dataset.ready,'');
    f.loaded(tab);frame.settleReadiness();assert.equal(frame.dataset.ready,'1');
  }
});

test('Codex native restoration after document load is not interrupted by another tap',async()=>{
  const f=await fixture(),frame=f.frame('codex');f.loaded('codex');
  frame.contentDocument.getElementById=id=>id==='codex-loading'?{getAttribute:()=> 'true'}:null;
  f.click('codex');assert.equal(frame.reloads,0);
  frame.contentDocument.getElementById=()=>null;f.click('codex');assert.equal(frame.reloads,1);
});

test('Claude concurrent refresh joins the same conversation read and retains its visible errors',async()=>{
  const html=chatHtml(),start=html.indexOf('  async function poll(){'),end=html.indexOf('  let reloadTarget=null;',start);
  for(const succeeds of [true,false]){
    const gate=deferred(),calls=[],errors=[],state={sessionId:'task',viewVersion:1,since:1,navigation:{capture(){}},readStatus:(...args)=>errors.push(args)};
    const context={state,hubActive:true,document:{hidden:false},AbortController,setTimeout:()=>1,clearTimeout(){},fetch:()=>{calls.push('fetch');return gate.promise;},applyControl(){},invalidateRuntime(){},updateTranscriptCursor:value=>{state.since=value.cursor;},messages:{scrollHeight:100,scrollTop:0,clientHeight:100}};
    const api=vm.runInNewContext('let pollController=null;'+html.slice(start,end)+';({poll})',context);
    const first=api.poll();let secondSettled=false;const second=api.poll().then(()=>{secondSettled=true;});
    await tick();assert.equal(calls.length,1);assert.equal(secondSettled,false);
    gate.resolve({ok:succeeds,status:503,json:async()=>({messages:[],cursor:2})});await Promise.all([first,second]);
    assert.equal(state.polling,false);assert.equal(state.pollCompletion,null);
    if(succeeds)assert.equal(state.since,2);else assert.match(errors.at(-1)[1],/保留当前内容/);
  }
});

test('Claude replies covered by the neutral refresh overlay do not qualify for native read acknowledgements',async()=>{
  const html=chatHtml(),hook=html.match(/window\.__claudeMobileRefresh=async\(\)=>\{[\s\S]*?\n  \};/)[0];
  const start=html.indexOf('  function nativeReadVisible('),end=html.indexOf('  function acknowledgeRead(',start);
  const gate=deferred(),marker={},state={sessionId:'task',viewVersion:1,nativeReadMarker:marker},window={};
  const context={window,state,hubActive:true,document:{hidden:false},chatView:{inert:false,classList:{contains:()=>false},getClientRects:()=>[{}]},composer:{inert:false},$:()=>({classList:{contains:()=>true}}),listView:{classList:{contains:()=>true}},saveDraft(){},poll:()=>gate.promise};
  const visible=vm.runInNewContext(hook+html.slice(start,end)+';nativeReadVisible',context);
  assert.equal(visible('task',1,marker),true);const pending=window.__claudeMobileRefresh();
  assert.equal(visible('task',1,marker),false);gate.resolve();await pending;
  assert.equal(visible('task',1,marker),true);assert.equal(state.hubRefreshing,false);
});

test('Claude current-view refresh reads only that view and keeps draft/attachment objects',async()=>{
  const source=chatHtml().match(/window\.__claudeMobileRefresh=async\(\)=>\{[\s\S]*?\n  \};/)[0];
  for(const kind of ['list','chat','draft']){
    const calls=[],attachment={file:new Blob(['unsent'])},state={sessionId:kind==='chat'?'session':null,attachments:[attachment],navigation:{capture:()=>calls.push('capture')}};
    const window={},context={window,state,listView:{classList:{contains:()=>kind!=='list'}},saveDraft:()=>calls.push('draft'),refreshSessions:async()=>calls.push('list'),poll:async()=>calls.push('chat'),loadModels:async()=>calls.push('models')};
    vm.runInNewContext(source,context);await window.__claudeMobileRefresh();
    assert.deepEqual(calls,['capture','draft',kind==='draft'?'models':kind]);assert.equal(state.attachments[0],attachment);
  }
});
