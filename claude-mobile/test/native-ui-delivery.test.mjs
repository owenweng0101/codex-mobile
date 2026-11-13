import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runInNewContext,Script} from 'node:vm';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {chatHtml} from '../backend/lib/ui.mjs';

const scripts=[...chatHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
const client=scripts.find(source=>source.includes('const deliveryCommands=new Map()'));
assert.ok(client,'test the actual generated native-delivery client');
const between=(start,end)=>{
  const a=client.indexOf(start),b=client.indexOf(end,a);
  assert.ok(a>=0&&b>a,`locate client section: ${start}`);
  return client.slice(a,b);
};
function actualFunction(name){
  const match=new RegExp('^  (?:async )?function '+name+'\\(','m').exec(client);
  assert.ok(match,`locate real client function ${name}`);
  const start=match.index,lineEnd=client.indexOf('\n',start);
  if(client.slice(start,lineEnd).trimEnd().endsWith('}'))return client.slice(start,lineEnd);
  const end=client.indexOf('\n  }',lineEnd);
  assert.ok(end>start,`locate function end: ${name}`);
  return client.slice(start,end+4);
}
const functions=['rememberView','readRememberedView','projectName','currentRequest','syncInputHeight','afterComposerVisible','saveDraft','restoreDraft','showList','updateSendState','openSession','newChat','bootstrap'];
const harnessSource=[
  between('  const state = {','  let hubActive='),
  'let hubActive=true,historyAssistant=null; const assistantOwners=new Set(),seenMessages=new Set(),pendingNativeUsers=new Set();',
  'const drafts=new Map(),pendingRequests=new Map();let draftKey=null;',
  ...functions.map(actualFunction),
  between('  const deliveryCommands=new Map();','  function attachmentPreview('),
  '({state,drafts,pendingRequests,deliveryCommands,seenMessages,pendingNativeUsers,send,checkDelivery,receiveDelivery,pendingSame,restorePendingMessages,newChat,openSession,showList,saveDraft,bootstrap,updateSendState,currentRequest,readRememberedView,getDraftKey:()=>draftKey})',
].join('\n');

const pendingStorage='clm-pending-desktop-commands-v1',viewStorage='clm-current-view-v1';
const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const store=map=>({getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value))});

function element(connected=false){
  const classes=new Set();let text='';
  const node={parent:null,children:[],style:{},value:'',scrollHeight:24,attributes:{},
    classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},
    setAttribute(name,value){this.attributes[name]=value;},focus(){},
    append(...nodes){for(const child of nodes){child.parent=this;this.children.push(child);}},
    replaceChildren(){for(const child of this.children)child.parent=null;this.children=[];},
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;},
    querySelector(selector){return this.children.find(child=>('.'+child.className)===selector)||null;},
  };
  Object.defineProperties(node,{
    isConnected:{get:()=>connected||Boolean(node.parent?.isConnected)},
    textContent:{get:()=>text,set(value){text=value;node.replaceChildren();}},
  });
  return node;
}

// DOM, transport, timers and output rendering are boundary fakes. Delivery,
// navigation, persistence, matching and response handling above run unchanged.
function fixture({local=new Map(),session=new Map()}={}){
  const nodes=new Map(),ctx={calls:[],refreshes:0,polls:0,menus:[],users:[],uuidCalls:0};
  const node=id=>{if(!nodes.has(id))nodes.set(id,element(true));return nodes.get(id);};
  let api;
  const sandbox={
    document:{getElementById:node,createElement:()=>element(),hidden:false},
    localStorage:store(local),sessionStorage:store(session),history:{state:{},replaceState(value){this.state=value;}},
    crypto:{randomUUID:()=>{ctx.uuidCalls++;return randomUUID();}},AbortController,
    requestAnimationFrame:fn=>fn(),viewportChanged(){},renderAttachments(){},updateChips(){},
    closeMenu(){},openMenu:kind=>ctx.menus.push(kind),renderPlan(){},scrollDown(){},
    stopPoll(){},startPoll(){},poll:()=>ctx.polls++,refreshSessions:()=>ctx.refreshes++,
    appendMessage(){},errorLine(){},
    addUserMessage(text,attachments){const wrap=element();wrap.className='msg user';node('messages').append(wrap);ctx.users.push({text,attachments,wrap});return wrap;},
    loadModels:async()=>{api.state.modelsLoaded=true;api.state.capabilities={attachments:false};},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,
    async fetch(url,options={}){
      ctx.calls.push({url,options});
      const custom=ctx.fetchHook?.(url,options);
      if(custom!==undefined)return custom;
      if(options.method==='POST'){
        const body=JSON.parse(options.body);
        return response(202,{requestId:body.requestId,sessionId:body.sessionId||body.requestId,state:'dispatched'});
      }
      if(url.startsWith('/claude/api/session/'))return response(200,{messages:[]});
      return response(404,{error:'request not found yet'});
    },
  };
  api=runInNewContext(harnessSource,sandbox);
  api.state.modelsLoaded=true;api.state.capabilities={attachments:false};api.state.model='chosen-model';
  return {api,ctx,node,local,session,
    posts:()=>ctx.calls.filter(call=>call.options.method==='POST'),
    queries:()=>ctx.calls.filter(call=>call.url.startsWith('/claude/api/command/')),
    requests:()=>[...api.deliveryCommands.values()],
    stored:()=>JSON.parse(local.get(pendingStorage)||'[]'),
  };
}

test('all generated inline scripts and the extracted actual-function harness compile',()=>{
  for(const source of scripts)new Script(source);
  new Script(harnessSource);
});

test('phone delta cursor advances by native record sequence, not message timestamps',()=>{
  assert.doesNotMatch(client,/state\.since\s*=\s*ts/);
  assert.doesNotMatch(client,/Date\.parse\(message\.ts\)/);
  assert.match(client,/state\.since=Math\.max\(state\.since,value\.cursor\|\|0\)/);
  assert.match(client,/state\.since=Math\.max\(state\.since,Number\.isFinite\(value\.cursor\)\?value\.cursor:0\)/);
});

test('composer has no insert/queue controls and sends with native now priority',()=>{
  assert.doesNotMatch(client,/priorityNow|priorityNext/);
  assert.match(client,/priority:state\.priority\|\|'now'/);
  assert.doesNotMatch(chatHtml(),/>插入<|>排队</);
});

test('lost POST response then refresh restores the same viewId and queries the original ID without reposting',async()=>{
  const first=fixture();first.api.newChat('/project');first.node('input').value='original message';
  first.ctx.fetchHook=(url,options)=>{if(options.method==='POST')return Promise.reject(new Error('HTTP response lost after native delivery'));};
  await first.api.send('original message');await yieldTurn();
  const original=first.requests()[0],savedView=first.api.readRememberedView();
  assert.equal(first.posts().length,1);assert.equal(original.state,'unknown');
  assert.equal(first.stored()[0].viewId,savedView.viewId);
  const refreshed=fixture({local:first.local,session:first.session});
  await refreshed.api.bootstrap();
  assert.equal(refreshed.api.state.deliveryViewId,savedView.viewId);
  assert.equal(refreshed.api.getDraftKey(),original.scope);
  assert.equal(refreshed.ctx.users.length,1,'pending user bubble is restored on the new page');
  const request=refreshed.requests()[0];
  refreshed.ctx.fetchHook=url=>url.startsWith('/claude/api/command/')?response(200,{requestId:original.requestId,sessionId:original.requestId,state:'dispatched'}):undefined;
  refreshed.node('input').value=original.text;
  await refreshed.api.send(original.text);await yieldTurn();
  assert.equal(refreshed.posts().length,0);
  assert.equal(refreshed.ctx.uuidCalls,0,'refresh/dedup never allocates a replacement request ID');
  assert.equal(refreshed.api.state.sessionId,original.requestId);
  assert.equal(refreshed.api.getDraftKey(),original.requestId);
  assert.equal(refreshed.api.readRememberedView().kind,'chat');
  assert.equal(refreshed.node('title').textContent,original.text);
  assert.equal(refreshed.api.pendingSame(original.text,[]),request);
  await refreshed.api.send(original.text);await yieldTurn();
  assert.equal(refreshed.posts().length,0,'dedup also holds after scope-to-session binding');
  refreshed.ctx.fetchHook=()=>response(200,{requestId:original.requestId,sessionId:original.requestId,state:'accepted'});
  await refreshed.api.checkDelivery(request);
  assert.equal(request.state,'accepted');assert.equal(refreshed.stored().length,0);
});

test('a persisted sessionId still matches the restored new-page scope before first status response',async()=>{
  const id=randomUUID(),viewId=randomUUID(),scope='new:/project';
  const local=new Map([[pendingStorage,JSON.stringify([{requestId:id,sessionId:id,scope,viewId,text:'pending',attachments:[],state:'dispatched'}])]]);
  const session=new Map([[viewStorage,JSON.stringify({kind:'new',cwd:'/project',scope,viewId})]]);
  const f=fixture({local,session});await f.api.bootstrap();
  assert.equal(f.ctx.users.length,1);assert.equal(f.api.pendingSame('pending',[]).requestId,id);
  await f.api.send('pending');await yieldTurn();
  assert.equal(f.posts().length,0);assert.equal(f.queries()[0].url,'/claude/api/command/'+id);
  assert.equal(f.requests()[0].state,'dispatched','404 cannot turn it into rejected');
});

test('legacy saved new view adopts only matching scope records and persists its upgrade',async()=>{
  const id=randomUUID(),other=randomUUID();
  const local=new Map([[pendingStorage,JSON.stringify([
    {requestId:id,scope:'new:/project',text:'pending',state:'unknown'},
    {requestId:other,scope:'new:/elsewhere',text:'other',state:'unknown'},
  ])]]);
  const session=new Map([[viewStorage,JSON.stringify({kind:'new',cwd:'/project'})]]);
  const f=fixture({local,session});await f.api.bootstrap();
  const view=f.api.readRememberedView();
  assert.ok(view.viewId);assert.equal(f.api.pendingSame('pending',[]).requestId,id);
  assert.equal(f.api.deliveryCommands.get(other).viewId,undefined);
  assert.equal(f.stored().find(record=>record.requestId===id).viewId,view.viewId);
});

test('late response from an older new-page viewId cannot hijack a new page in the same scope',async()=>{
  const f=fixture(),post=deferred();f.api.newChat('/project');f.node('input').value='old request';
  f.ctx.fetchHook=(url,options)=>options.method==='POST'?post.promise:undefined;
  const sending=f.api.send('old request'),old=f.requests()[0];
  f.api.newChat('/project');const newView=f.api.state.deliveryViewId;
  assert.notEqual(old.viewId,newView);
  f.node('input').value='new user input';f.api.saveDraft();
  post.resolve(response(200,{requestId:old.requestId,sessionId:old.requestId,state:'accepted'}));await sending;
  assert.equal(f.api.state.sessionId,null);assert.equal(f.api.state.deliveryViewId,newView);
  assert.equal(f.api.readRememberedView().kind,'new');
  assert.equal(f.node('input').value,'new user input');
  assert.equal(f.api.drafts.get(old.scope).text,'new user input');
  assert.equal(f.node('title').textContent,'新会话 · project');
});

test('background accepted clears matching original draft, preserves visible new input and refreshes the list',async()=>{
  const f=fixture(),post=deferred();f.api.newChat('/project');f.node('input').value='submitted';
  f.ctx.fetchHook=(url,options)=>options.method==='POST'?post.promise:undefined;
  const sending=f.api.send('submitted'),request=f.requests()[0];
  f.api.showList();assert.equal(f.api.drafts.get(request.scope).text,'submitted');
  f.node('input').value='unrelated visible input';const refreshes=f.ctx.refreshes;
  post.resolve(response(200,{requestId:request.requestId,sessionId:request.requestId,state:'accepted'}));await sending;
  assert.equal(f.api.drafts.has(request.scope),false);
  assert.equal(f.node('input').value,'unrelated visible input');assert.equal(f.api.state.sessionId,null);
  assert.equal(f.ctx.refreshes,refreshes+1,'accepted in background updates the visible list');
  assert.equal(f.stored().length,0);
  f.api.newChat('/project');assert.equal(f.node('input').value,'','acknowledged content is not restored as a draft');
});

test('background accepted preserves changed text, changed attachments and a newer draft viewId',async t=>{
  for(const change of ['text','attachments','viewId'])await t.test(change,async()=>{
    const f=fixture(),post=deferred();f.api.newChat('/project');f.node('input').value='submitted';
    f.ctx.fetchHook=(url,options)=>options.method==='POST'?post.promise:undefined;
    const sending=f.api.send('submitted'),request=f.requests()[0];
    if(change==='viewId')f.api.newChat('/project');
    f.node('input').value=change==='text'?'new draft text':'submitted';
    if(change==='attachments')f.api.state.attachments=[{id:'new-image'}];
    f.api.showList();const draft=f.api.drafts.get(request.scope);
    post.resolve(response(200,{requestId:request.requestId,sessionId:request.requestId,state:'accepted'}));await sending;
    assert.equal(f.api.drafts.get(request.scope),draft);
    assert.equal(f.node('input').value,draft.text);
  });
});

test('existing session draft is cleaned in background while an unrelated draft survives',async()=>{
  const f=fixture(),id=randomUUID(),post=deferred();
  await f.api.openSession({id,cwd:'/project',title:'Existing title'});f.node('input').value='submitted';
  f.ctx.fetchHook=(url,options)=>options.method==='POST'?post.promise:undefined;
  const sending=f.api.send('submitted'),request=f.requests()[0];f.api.showList();
  f.api.drafts.set('another-session',{text:'keep this',attachments:[]});
  post.resolve(response(200,{requestId:request.requestId,sessionId:id,state:'accepted'}));await sending;
  assert.equal(f.api.drafts.has(id),false);assert.equal(f.api.drafts.get('another-session').text,'keep this');
});

test('explicit notDispatched 503 rejects without status polling and permits an explicit fresh retry',async()=>{
  const f=fixture();f.api.newChat('/project');f.node('input').value='submitted';
  f.ctx.fetchHook=(url,options)=>options.method==='POST'?response(503,{error:'电脑端暂不可用',preflight:'rejected',notDispatched:true,delivery:'rejected'}):undefined;
  await f.api.send('submitted');const original=f.requests()[0];
  assert.equal(original.state,'rejected');assert.equal(original.error,'电脑端暂不可用');
  assert.equal(f.queries().length,0);assert.equal(f.stored().length,0);
  assert.equal(f.node('input').value,'submitted');assert.equal(f.api.currentRequest(),null);
  assert.equal(f.node('send').disabled,false);
  delete f.ctx.fetchHook;await f.api.send('submitted');
  assert.equal(f.posts().length,2);assert.notEqual(f.requests()[1].requestId,original.requestId);
});

test('unmarked errors including 504 stay unknown and a racing 404 never permits a repost',async t=>{
  for(const status of [400,503,504])await t.test(String(status),async()=>{
    const f=fixture();f.api.newChat('/project');f.node('input').value='submitted';
    f.ctx.fetchHook=(url,options)=>options.method==='POST'?response(status,{error:'ambiguous transport failure'}):undefined;
    await f.api.send('submitted');await yieldTurn();const request=f.requests()[0];
    assert.equal(request.state,'unknown');assert.equal(f.stored()[0].requestId,request.requestId);
    assert.ok(f.queries().length>0);assert.equal(f.posts().length,1);
    await f.api.send('submitted');await yieldTurn();
    assert.equal(request.state,'unknown');assert.equal(f.posts().length,1);
  });
});

test('404 while the original POST is still pending cannot reject it before a later accepted response',async()=>{
  const f=fixture(),post=deferred();f.api.newChat('/project');f.node('input').value='submitted';
  f.ctx.fetchHook=(url,options)=>options.method==='POST'?post.promise:undefined;
  const sending=f.api.send('submitted'),request=f.requests()[0];
  await f.api.checkDelivery(request);assert.equal(request.state,'prepared');assert.equal(request.posting,true);
  post.resolve(response(200,{requestId:request.requestId,sessionId:request.requestId,state:'accepted'}));await sending;
  assert.equal(request.state,'accepted');assert.equal(f.posts().length,1);
});

test('existing session title is preserved, and navigation clears per-session pending native UUIDs',async()=>{
  const f=fixture(),id=randomUUID();f.api.pendingNativeUsers.add('stale-before-new');f.api.seenMessages.add('stale-before-new');
  f.api.newChat('/project');assert.equal(f.api.pendingNativeUsers.size,0);assert.equal(f.api.seenMessages.size,0);
  f.api.pendingNativeUsers.add('stale-before-open');f.api.seenMessages.add('stale-before-open');
  await f.api.openSession({id,cwd:'/project',title:'Keep native title'});
  assert.equal(f.api.pendingNativeUsers.size,0);assert.equal(f.api.seenMessages.size,0);
  f.node('input').value='a new message';await f.api.send('a new message');
  assert.equal(f.node('title').textContent,'Keep native title');
  assert.equal(f.api.readRememberedView().title,'Keep native title');
});

test('model, permission, queue priority and attachment IDs retain their original POST values',async()=>{
  const f=fixture();f.api.newChat('/project');f.api.state.capabilities={attachments:true};
  f.api.state.model='selected-native-model';f.api.state.mode='plan';f.api.state.priority='next';
  f.api.state.attachments=[{id:'original-image',name:'image.png',url:'/fake/image'}];
  f.node('input').value='original text';await f.api.send('original text');
  const body=JSON.parse(f.posts()[0].options.body);
  assert.deepEqual(plain({text:body.text,model:body.model,permissionMode:body.permissionMode,priority:body.priority,attachments:body.attachments}),
    {text:'original text',model:'selected-native-model',permissionMode:'plan',priority:'next',attachments:['original-image']});
});
