import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {Script,runInNewContext} from 'node:vm';
import {chatHtml,hubHtml} from '../backend/lib/ui.mjs';

const client=[...chatHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const deliveryCommands'));
const manager=client.slice(client.indexOf('  state.navigation=(() => {'),client.indexOf('  function rememberView('));

// Execute the production reading-state controller. Metrics deliberately become
// zero while hidden, and frames can run after navigation, as in hidden iframes.
function readingHarness(){
  const listeners=new Map(),frames=new Map(),storage=new Map();let sequence=0;
  const events=()=>({addEventListener(name,fn){const handlers=listeners.get(this)||{};(handlers[name]??=[]).push(fn);listeners.set(this,handlers);},emit(name,event={}){for(const fn of listeners.get(this)?.[name]||[])fn(event);}});
  const element=()=>Object.assign(events(),{hidden:false,inert:false,scrollTop:0,scrollHeight:5000,clientHeight:500,anchors:[],dataset:{},classList:{contains(){return false;}},getClientRects(){return this.hidden?[]:[{}];},getBoundingClientRect(){return {top:0};},querySelectorAll(){return this.anchors;},contains(){return true;}});
  const listView=element(),messages=element(),chatView=element(),composer=element(),rows=element();rows.dataset.listView='project';
  let chat=false;listView.classList.contains=()=>chat;
  const state={viewVersion:0,listView:'project',loading:false};
  const document=Object.assign(events(),{hidden:false,body:{}}),window=events();
  const sandbox={state,listView,messages,chatView,composer,rows,document,window,hubActive:true,draftKey:'a',followOutput:false,userScrolling:false,scrollIntentTimer:0,
    sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    requestAnimationFrame:fn=>{frames.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>frames.delete(id),clearTimeout(){},poll(){},startPoll(){},stopPoll(){},closeMenu(){},
    MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}}
  };
  runInNewContext(manager,sandbox);
  return {state,listView,messages,chatView,composer,rows,document,window,sandbox,nav:state.navigation,
    chat(value){chat=value;},flush(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();},
    anchor(key,y){const a={dataset:{scrollKey:key},getClientRects:()=>[{}],getBoundingClientRect:()=>({top:y()-messages.scrollTop,bottom:y()-messages.scrollTop+100})};messages.anchors.push(a);return a;}};
}

test('hidden iframe zero metrics cannot overwrite either list or chat reading state across repeated returns',()=>{
  const h=readingHarness();h.listView.scrollTop=930;h.nav.capture();
  for(let round=0;round<8;round++){
    h.chat(true);h.listView.hidden=true;h.listView.scrollTop=0;h.messages.scrollTop=420;h.nav.capture();
    h.sandbox.hubActive=false;h.messages.hidden=true;h.messages.scrollTop=0;h.nav.capture();
    h.sandbox.hubActive=true;h.messages.hidden=false;h.nav.restore();h.flush();assert.equal(h.messages.scrollTop,420);
    h.chat(false);h.listView.hidden=false;h.nav.restore();h.flush();assert.equal(h.listView.scrollTop,930);
  }
});

test('stable message anchor survives height changes and preview focus return without resuming follow',()=>{
  const h=readingHarness();h.chat(true);let y=900;h.anchor('message-9',()=>y);h.messages.scrollTop=930;h.nav.capture();
  h.chatView.inert=true;h.messages.scrollTop=1800;h.nav.capture();y+=240;
  h.chatView.inert=false;h.nav.restore();h.flush();assert.equal(h.messages.scrollTop,1170);assert.equal(h.sandbox.followOutput,false);
  h.messages.scrollHeight+=600;h.nav.restore();assert.equal(h.messages.scrollTop,1170);
});

test('a queued restore cannot affect a later view, and a real gesture cancels it',()=>{
  const h=readingHarness();h.listView.scrollTop=930;h.nav.capture();h.nav.restore();h.chat(true);h.state.viewVersion++;h.messages.scrollTop=130;h.flush();assert.equal(h.messages.scrollTop,130);
  h.nav.capture();h.nav.restore();h.messages.emit('wheel');h.messages.scrollTop=180;h.flush();assert.equal(h.messages.scrollTop,180);
});

test('project and recent positions are independent; hidden mode changes cannot sample the old list',()=>{
  const h=readingHarness();h.listView.scrollTop=930;h.nav.capture();h.state.listView='recent';h.nav.capture();assert.equal(h.nav.has(),false);
  h.rows.dataset.listView='recent';h.listView.scrollTop=320;h.nav.capture();h.state.listView='project';h.nav.restore();assert.equal(h.listView.scrollTop,930);
});

test('generated client compiles, including the navigation and lifecycle handlers',()=>{new Script(client);});

function actualFunction(name){
  const asyncStart=client.indexOf('  async function '+name+'('),start=asyncStart>=0?asyncStart:client.indexOf('  function '+name+'(');
  assert.ok(start>=0);const lineEnd=client.indexOf('\n',start);
  if(client.slice(start,lineEnd).trimEnd().endsWith('}'))return client.slice(start,lineEnd);
  const end=client.indexOf('\n  }',lineEnd);
  assert.ok(end>start);return client.slice(start,end+4);
}
function readHarness(){
  const timers=new Map(),errors=new Map(),calls=[],responses=[],deliveries=[];let sequence=0;
  const state={sessionId:'fixture-session',viewVersion:1,since:8,models:[],model:'',modelsLoaded:false,sessions:[{id:'retained'}]};
  const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{attributes:{},textContent:'',classList:{contains:()=>false,add(){},remove(){},toggle(){}},append(){},setAttribute(k,v){this.attributes[k]=v;}});return nodes.get(id);};
  state.readStatus=(key,text,retry)=>text?errors.set(key,{text,retry}):errors.delete(key);state.readStatus.render=()=>{};
  const sandbox={state,$,hubActive:true,document:{hidden:false,createElement:()=>({setAttribute(){},remove(){}})},listView:$('list'),chatView:$('chat'),composer:$('composer'),messages:$('messages'),title:$('title'),
    rememberView(){},closeMenu(){},saveDraft(){},restoreDraft(){},stopPoll(){},startPoll(){},restorePendingMessages(){},seenMessages:new Set(),nativeUserRows:new Map(),queuedUserRows:new Map(),errorLine(text,retry){state.openError={text,retry};},
    AbortController,encodeURIComponent,assistantOwners:new Set(),listRequest:0,listController:null,runtimeSnapshots:new WeakMap(),performance:{now:()=>0},
    setTimeout(fn,ms){assert.ok(ms<=20000);timers.set(++sequence,fn);return sequence;},clearTimeout:id=>timers.delete(id),
    fetch(url,options){assert.equal(options.method,undefined,'all recovery is read-only');calls.push({url,options});return responses.shift()(options);},
    applyControl(){},renderPlan(){},appendMessage(){},scrollDown(){},updateChips(){},updateSendState(){},renderSessions(){},updateHistoryTop(){},setWaitingStatus(){},updatePlanActivity(){},
    listStatus(text,retry){state.listError=text;state.listRetry=retry;},
    requestInView:()=>true,receiveDelivery(request,value){assert.equal(value.requestId,request.requestId);deliveries.push(value);request.state=value.state;return true;}
  };
  const api=runInNewContext('let pollController=null,historyAssistant=null;'+['stopPoll','poll','checkDelivery','loadModels','refreshSessions','openSession','resetHistoryPaging','updateTranscriptCursor','observeRuntime','invalidateRuntime'].map(actualFunction).join('\n')+'\n({stopPoll,poll,checkDelivery,loadModels,refreshSessions,openSession})',sandbox);
  return {state,api,timers,errors,calls,responses,deliveries,$,
    expire(){for(const fn of [...timers.values()])fn();},
    response(value){responses.push(()=>Promise.resolve({ok:true,status:200,json:async()=>value}));},
    hang(phase){let resolve;const pending=new Promise(r=>{resolve=r;});responses.push(()=>phase==='headers'?pending:Promise.resolve({ok:true,status:200,json:()=>pending}));return resolve;}
  };
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
for(const phase of ['headers','body']){
  test('poll '+phase+' stall releases polling, shows retry, and cannot apply a late result',async()=>{
    const h=readHarness(),late=h.hang(phase),pending=h.api.poll();await turn();assert.equal(h.state.polling,true);
    h.expire();await pending;assert.equal(h.state.polling,false);assert.equal(h.timers.size,0);
    assert.match(h.errors.get('poll').text,/超时/);
    h.response({messages:[],cursor:12});await h.errors.get('poll').retry();assert.equal(h.state.since,12);assert.equal(h.errors.size,0);
    late(phase==='headers'?{ok:true,json:async()=>({messages:[],cursor:99})}:{messages:[],cursor:99});await turn();assert.equal(h.state.since,12);
  });
  test('delivery '+phase+' stall releases checking, retries only GET, and keeps the command uncertain',async()=>{
    const h=readHarness(),late=h.hang(phase),request={requestId:'fixture-command',state:'unknown'},pending=h.api.checkDelivery(request);await turn();assert.equal(request.checking,true);
    h.expire();await pending;assert.equal(request.checking,false);assert.equal(request.state,'unknown');assert.equal(h.timers.size,0);
    assert.match(h.errors.get('delivery:fixture-command').text,/尚未确认/);
    h.response({requestId:request.requestId,sessionId:'fixture-session',nativeMessageId:'fixture-native-user',transport:'native-user-v1',state:'accepted'});
    await h.errors.get('delivery:fixture-command').retry();assert.equal(request.state,'accepted');assert.equal(h.errors.size,0);
    const rejected={requestId:request.requestId,sessionId:'fixture-session',state:'rejected',notDispatched:true};
    late(phase==='headers'?{ok:true,json:async()=>rejected}:rejected);await turn();assert.equal(request.state,'accepted');assert.equal(h.deliveries.length,1);
  });
  test('models '+phase+' stall releases loading; visible retry restores capability without a late overwrite',async()=>{
    const h=readHarness(),late=h.hang(phase),pending=h.api.loadModels().catch(error=>error);await turn();assert.equal(h.state.modelsLoading,true);
    h.expire();await pending;assert.equal(h.state.modelsLoading,false);assert.equal(h.state.modelsLoaded,false);assert.equal(h.timers.size,0);
    assert.match(h.errors.get('models').text,/超时/);
    h.response({models:[{model:'recovered'}],capabilities:{attachments:true}});await h.errors.get('models').retry();assert.equal(h.state.modelsLoaded,true);assert.equal(h.state.model,'recovered');assert.equal(h.errors.size,0);
    late(phase==='headers'?{ok:true,json:async()=>({models:[{model:'old'}]})}:{models:[{model:'old'}]});await turn();assert.equal(h.state.model,'recovered');
  });
  test('open session '+phase+' stall clears loading and its own retry can load the same session',async()=>{
    const h=readHarness();h.hang(phase);const pending=h.api.openSession({id:'fixture-session',cwd:'/fixture',title:'Fixture'});await turn();assert.equal(h.state.loading,true);
    h.expire();await pending;assert.equal(h.state.loading,false);assert.equal(h.state.sessionController,null);assert.match(h.state.openError.text,/超时/);assert.equal(h.timers.size,0);
    h.response({messages:[],cursor:20});await h.state.openError.retry();assert.equal(h.state.loading,false);assert.equal(h.state.since,20);assert.equal(h.timers.size,0);
  });
  test('list '+phase+' stall clears busy, retains rows and permits explicit refresh',async()=>{
    const h=readHarness();h.hang(phase);const pending=h.api.refreshSessions();await turn();h.expire();await pending;
    assert.equal(h.$('list').attributes['aria-busy'],'false');assert.equal(h.state.sessions[0].id,'retained');assert.match(h.state.listError,/超时/);assert.equal(h.state.listRetry,true);
    h.response({sessions:[{id:'recovered'}]});await h.api.refreshSessions();assert.equal(h.state.sessions[0].id,'recovered');assert.equal(h.state.listError,'');assert.equal(h.timers.size,0);
  });
}
test('an abandoned poll timeout cannot overwrite a newer successful refresh',async()=>{
  const h=readHarness();h.hang('headers');const abandoned=h.api.poll(),oldTimeout=[...h.timers.values()][0];
  h.api.stopPoll();h.response({messages:[],cursor:18});await h.api.poll();oldTimeout();await abandoned;
  assert.equal(h.state.since,18);assert.equal(h.state.polling,false);assert.equal(h.errors.size,0);assert.equal(h.timers.size,0);
});
test('an in-flight status read cannot downgrade a terminal acknowledgement arriving meanwhile',async()=>{
  const h=readHarness(),resolve=h.hang('headers'),request={requestId:'fixture-command',state:'unknown'};
  const pending=h.api.checkDelivery(request);request.state='accepted';
  resolve({ok:true,json:async()=>({requestId:request.requestId,sessionId:'fixture-session',state:'unknown'})});await pending;
  assert.equal(request.state,'accepted');assert.equal(request.checking,false);assert.equal(h.deliveries.length,0);assert.equal(h.timers.size,0);
});
test('a newer capability read wins over a slow older failure',async()=>{
  const h=readHarness(),late=h.hang('headers'),old=h.api.loadModels().catch(error=>error);
  h.response({models:[{model:'newest'}]});await h.api.loadModels();late({ok:false,status:503});await old;
  assert.equal(h.state.modelsLoaded,true);assert.equal(h.state.modelsLoading,false);assert.equal(h.state.model,'newest');assert.equal(h.errors.size,0);
});

// Entirely synthetic, read-only API. No production service, model, business
// conversation, real upload, or actual send can be reached by this fixture.
export async function startNavigationFixture(){
  const sessions=Array.from({length:100},(_,i)=>({id:'fixture-'+i,cwd:'/fixture/workspace-'+Math.floor(i/10),title:'Navigation fixture '+i,messageCount:80,updatedAt:Date.now()-i*60000}));
  const messages=Array.from({length:80},(_,i)=>({id:'message-'+i,role:i%2?'assistant':'user',text:i%2?Array.from({length:5},(_,j)=>'Paragraph '+i+'.'+j+' '+('Reading anchor content. '.repeat(8))).join('\n\n')+'\n\n[Navigation fixture file](fixture.md)':'User fixture '+i+' '+('content '.repeat(20))}));
  let listReads=0,sessionReads=0,modelReads=0;const writes=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');
    const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    if(req.method!=='GET'){writes.push(req.url);return json({error:'fixture forbids all writes'},405);}
    if(url.pathname==='/m/api/entries')return json(Object.fromEntries(['codex','dsh','claude'].map(name=>[name,{ready:true,url:name==='claude'?'/claude/':'/stub/'+name}])));
    if(url.pathname==='/claude/api/sessions'){
      listReads++;await new Promise(r=>setTimeout(r,40));
      return json({sessions:listReads>2?[{...sessions[0],id:'inserted',title:'Inserted above reader'},...sessions]:sessions});
    }
    if(url.pathname==='/claude/api/models'){
      modelReads++;if(modelReads===1)return json({error:'synthetic failure'},503);
      return json({models:[{model:'fixture-model',label:'Fixture model'}],defaultModel:'fixture-model',attachments:false});
    }
    if(url.pathname.startsWith('/claude/api/session/')){
      sessionReads++;const id=url.pathname.split('/').pop();
      if(id==='fixture-22'&&sessionReads===1){await new Promise(r=>setTimeout(r,250));return json({error:'synthetic session failure'},503);}
      await new Promise(r=>setTimeout(r,id==='fixture-21'?180:20));
      return json({messages:url.searchParams.has('since')?[]:messages,cursor:80,control:{running:false,model:'fixture-model',permissionMode:'default'}});
    }
    if(url.pathname==='/claude/api/file'){res.writeHead(200,{'content-type':'text/markdown'});return res.end('# Navigation fixture\n\nRead only file preview.');}
    if(url.pathname.startsWith('/claude/api/command/'))return json({requestId:url.pathname.split('/').pop(),sessionId:'fixture-22',nativeMessageId:'22222222-2222-4222-8222-222222222222',transport:'native-user-v1',state:'accepted'});
    if(url.pathname==='/stats')return json({listReads,sessionReads,modelReads,writes});
    res.writeHead(200,{'content-type':'text/html'});
    const prelude='<script>(()=>{if(!sessionStorage.getItem("fixture-read-stalls"))return;sessionStorage.removeItem("fixture-read-stalls");const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===15000?120:ms,...args);const fetchOriginal=window.fetch,stalled=new Set();window.fetch=(url,options)=>{const key=String(url).includes("/models")?"models":String(url).includes("/command/")?"delivery":String(url).includes("?since=")?"poll":null;if(key&&!stalled.has(key)){stalled.add(key);return Promise.resolve({ok:true,json:()=>new Promise(()=>{})});}return fetchOriginal(url,options);};})();</script>';
    res.end(url.pathname==='/m/'?hubHtml():url.pathname.startsWith('/stub/')?'<p>Isolated '+url.pathname+'</p>':chatHtml().replace('<head>','<head>'+prelude));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r);}),writes};
}

// Set CLAUDE_NAVIGATION_EGO=1 to run the continuous real-layout regression.
// One agent-owned Ego Space is always finished, even when an assertion fails.
test('393px Ego: repeated list/chat/hub/preview/menu/reload and racing requests', {skip:process.env.CLAUDE_NAVIGATION_EGO!=='1',timeout:90000},async()=>{
  const fixture=await startNavigationFixture();
  const script=`
const task=await taskSpace('Claude navigation isolated regression');
try{
  const page=task.page('p1');
  await page.cdp('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:1,mobile:true});
  await page.goto(${JSON.stringify(fixture.url+'/m/')});
  if(await page.evaluate(()=>innerWidth)!==393)throw Error('Expected 393px viewport');
  console.log(await page.snapshot());
  await page.click('loc=css:[data-tab="claude"]');
  await page.waitForFunction(()=>document.querySelector('[data-frame="claude"]').contentDocument?.querySelectorAll('.row').length===100);
  const scenario=${browserScenarios.toString()};
  console.log(JSON.stringify(await page.evaluate(scenario,{phase:'init'})));
  for(let round=0;round<4;round++)console.log(JSON.stringify(await page.evaluate(scenario,{phase:'round',round})));
  console.log(JSON.stringify(await page.evaluate(scenario,{phase:'final'})));
  console.log(JSON.stringify(await page.evaluate(scenario,{phase:'faults'})));
}finally{await task.finish({keep:[]});}
`;
  try{
    const output=await new Promise((resolve,reject)=>{
      const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});let output='';
      child.stdout.on('data',d=>{output+=d;process.stdout.write(d);});child.stderr.on('data',d=>{output+=d;process.stderr.write(d);});child.on('error',reject);
      child.on('close',code=>code===0?resolve(output):reject(Error(output)));child.stdin.end(script);
    });
    assert.match(output,/"completed":true/);assert.match(output,/"faultRecovery":true/);assert.deepEqual(fixture.writes,[]);
  }finally{await fixture.close();}
});

async function browserScenarios({phase,round=0}){
  const frame=document.querySelector('[data-frame="claude"]'),doc=frame.contentDocument,win=frame.contentWindow;
  const $=id=>doc.getElementById(id),sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await sleep(20);}throw Error('Fixture condition timeout');};
  const settle=async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await sleep(40);};
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const near=(a,b,label)=>check(Math.abs(a-b)<3,label+': '+a+' vs '+b);
  const position=()=>{const top=$('messages').getBoundingClientRect().top;const item=[...$('messages').querySelectorAll('[data-scroll-key]')].find(n=>{const r=n.getBoundingClientRect();return r.top>=top&&r.bottom<=top+$('messages').clientHeight;});return item?{key:item.dataset.scrollKey,offset:item.getBoundingClientRect().top-top}:null;};
  const verify=p=>{const n=[...$('messages').querySelectorAll('[data-scroll-key]')].find(n=>n.dataset.scrollKey===p.key);near(n.getBoundingClientRect().top-$('messages').getBoundingClientRect().top,p.offset,'reading anchor');};
  const enter=async id=>{doc.querySelector('[data-scroll-key="session:'+id+'"]').click();await wait(()=>$('messages').querySelector('.msg')&&!$('messages').querySelector('.waiting-status'));await settle();};
  const hub=async name=>{document.querySelector('[data-tab="'+name+'"]').click();await settle();};
  if(phase==='faults'){
    win.sessionStorage.setItem('fixture-read-stalls','1');
    win.localStorage.setItem('clm-pending-desktop-commands-v1',JSON.stringify([{requestId:'11111111-1111-4111-8111-111111111111',sessionId:'fixture-22',scope:'fixture-22',key:'fixture-22',text:'Read-only fixture command status',attachments:[],state:'unknown'}]));
    win.location.reload();await wait(()=>frame.contentDocument!==doc&&frame.contentDocument.querySelector('.msg'));
    const fresh=frame.contentDocument,get=id=>fresh.getElementById(id),recovered=[];
    // Every retry is a real visible button in the production client. The fixture
    // accelerates only its 15s read deadlines; all application guards run intact.
    for(let i=0;i<3;i++){
      await wait(()=>!get('readStatus').classList.contains('hidden')&&get('readStatus').textContent.includes('超时'));
      const text=get('readStatus').textContent;recovered.push(text);
      get('readStatus').querySelector('button').click();
      await wait(()=>get('readStatus').classList.contains('hidden')||get('readStatus').textContent!==text);
    }
    await wait(()=>get('readStatus').classList.contains('hidden'));
    check(recovered.some(text=>text.includes('电脑端')),'models timeout was visible');
    check(recovered.some(text=>text.includes('对话更新')),'poll timeout was visible');
    check(recovered.some(text=>text.includes('投递状态')),'delivery timeout was visible');
    get('input').value='unsent after read recovery';get('input').dispatchEvent(new Event('input'));
    check(!get('send').disabled,'capability retry restores send eligibility without sending');
    const stats=await(await fetch('/stats')).json();check(stats.writes.length===0,'no dispatch or upload');
    return {faultRecovery:true,width:innerWidth,recovered,stats};
  }
  if(phase==='init'){
  await wait(()=>$('list').getAttribute('aria-busy')==='false');
  // Failure, explicit retry, then late request completion after returning home.
  doc.querySelector('[data-scroll-key="session:fixture-22"]').click();await wait(()=>$('messages').querySelector('.err button'));
  $('messages').querySelector('.err button').click();await wait(()=>$('messages').querySelector('.msg'));await settle();
  $('modelChip').click();const retry=[...$('optionsMenu').querySelectorAll('button')].find(n=>n.textContent==='重新加载');check(retry,'model failure has retry');retry.click();await wait(()=>!$('optionsMenu').textContent.includes('重新加载'));doc.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  $('back').click();await wait(()=>$('list').getAttribute('aria-busy')==='false');
  doc.querySelector('[data-scroll-key="session:fixture-21"]').click();$('back').click();await sleep(250);
  check(!$('list').classList.contains('hidden'),'late load cannot reopen chat');
  $('list').scrollTop=900;$('list').dispatchEvent(new Event('scroll'));await settle();
  window.__navigationListBefore=doc.querySelector('[data-scroll-key="session:fixture-22"]').getBoundingClientRect().top;
  return {phase,initialized:true};
  }
  let listBefore=window.__navigationListBefore;
  if(phase==='round'){const i=round;
    await enter('fixture-22');
    $('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));$('messages').scrollTop=2200;$('messages').dispatchEvent(new Event('scroll'));await settle();
    const reading=position();check(reading,'reading anchor exists');
    for(const name of ['codex','dsh','claude'])await hub(name);verify(reading);
    const link=[...$('messages').querySelectorAll('a.file-link')].find(n=>n.getBoundingClientRect().top>=$('messages').getBoundingClientRect().top);
    link.click();await wait(()=>!doc.querySelector('.file-view').classList.contains('hidden'));doc.querySelector('.file-bar button').click();await settle();verify(reading);
    $('modelChip').click();check(!$('optionsMenu').classList.contains('hidden'),'model menu opens');
    doc.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle();verify(reading);
    $('input').value='unsent draft '+i;$('input').dispatchEvent(new Event('input'));
    $('back').click();await wait(()=>$('list').getAttribute('aria-busy')==='false');await settle();
    near(doc.querySelector('[data-scroll-key="session:fixture-22"]').getBoundingClientRect().top,listBefore,'list stable row after refresh/reorder');
    for(const name of ['dsh','codex','claude'])await hub(name);
    near(doc.querySelector('[data-scroll-key="session:fixture-22"]').getBoundingClientRect().top,listBefore,'list after hub');
    await enter('fixture-22');verify(reading);check($('input').value==='unsent draft '+i,'draft survives navigation');
    $('back').click();await wait(()=>$('list').getAttribute('aria-busy')==='false');
  return {phase,round,passed:true};
  }
  // Every workspace panel must have its own ARIA target after fragment rendering.
  const ids=[...doc.querySelectorAll('.workspace-content')].map(n=>n.id);check(new Set(ids).size===ids.length,'unique workspace panel IDs');
  $('workspaceView').focus();await settle();
  listBefore=doc.querySelector('[data-scroll-key="session:fixture-22"]').getBoundingClientRect().top;
  $('workspaceView').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  check($('optionsMenu').contains(doc.activeElement),'keyboard enters menu');
  [...$('optionsMenu').querySelectorAll('button')].find(n=>n.textContent.includes('最近更新')).click();await settle();
  $('list').scrollTop=380;$('list').dispatchEvent(new Event('scroll'));await settle();
  $('workspaceView').focus();await settle();$('workspaceView').click();[...$('optionsMenu').querySelectorAll('button')].find(n=>n.textContent.includes('按工作区')).click();await settle();
  near(doc.querySelector('[data-scroll-key="session:fixture-22"]').getBoundingClientRect().top,listBefore,'project mode saved independently');
  await enter('fixture-22');$('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));$('messages').scrollTop=2500;$('messages').dispatchEvent(new Event('scroll'));await settle();
  const beforeReload=position();win.location.reload();await wait(()=>frame.contentDocument!==doc&&frame.contentDocument.querySelector('.msg'));await sleep(150);
  const next=frame.contentDocument,n=[...next.querySelectorAll('[data-scroll-key]')].find(n=>n.dataset.scrollKey===beforeReload.key);
  near(n.getBoundingClientRect().top-next.getElementById('messages').getBoundingClientRect().top,beforeReload.offset,'reload reading anchor');
  const stats=await (await fetch('/stats')).json();check(stats.writes.length===0,'no writes or sends');
  return {completed:true,width:innerWidth,roundTrips:8,hubSwitches:24,previewReturns:4,stats};
}
