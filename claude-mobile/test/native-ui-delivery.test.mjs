import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Script} from 'node:vm';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {chatHtml} from '../backend/lib/ui.mjs';
import {scripts,client,harnessSource,fixture,pendingStorage,viewStorage,response,plain,deferred} from './native-ui-fixture.mjs';

test('all generated inline scripts and the extracted actual-function harness compile',()=>{
  for(const source of scripts)new Script(source);
  new Script(harnessSource);
});

test('phone delta cursor follows the native record sequence and may move back after a rewrite',async()=>{
  assert.doesNotMatch(client,/state\.since\s*=\s*ts/);
  assert.doesNotMatch(client,/Date\.parse\(message\.ts\)/);
  // 服务端 cursor 是唯一依据；文件被桌面重写后允许回退，不能只增不减。
  assert.doesNotMatch(client,/state\.since=Math\.max\(/);
  const f=fixture(),id=randomUUID();
  f.ctx.fetchHook=()=>response(200,{messages:[],cursor:12,anchor:'prefix-before-rewrite'});
  await f.api.openSession({id,cwd:'/project',title:'Cursor fixture'});
  assert.equal(f.api.state.since,12);assert.equal(f.api.state.cursorAnchor,'prefix-before-rewrite');
  f.ctx.fetchHook=()=>response(200,{messages:[],cursor:3,anchor:'prefix-after-rewrite'});
  await f.api.poll();
  assert.equal(f.api.state.since,3,'poll accepts a lower native record sequence rather than a monotonic timestamp');
  assert.equal(f.api.state.cursorAnchor,'prefix-after-rewrite');
  assert.match(f.ctx.calls.at(-1).url,/\?since=12&anchor=prefix-before-rewrite$/);
  f.api.updateTranscriptCursor({cursor:NaN,anchor:'invalid'});
  assert.equal(f.api.state.since,3);assert.equal(f.api.state.cursorAnchor,'prefix-after-rewrite','an invalid sequence cannot commit a new anchor');
  f.api.updateTranscriptCursor({cursor:0});
  assert.equal(f.api.state.since,0);assert.equal(f.api.state.cursorAnchor,null,'a valid sequence without an anchor clears the obsolete digest');
});

test('composer has no insertion controls and the native-user transport queues next',async()=>{
  assert.equal(/priorityNow|priorityNext/.test(client),false);
  assert.equal(/>插入<|>排队</.test(chatHtml()),false);
  const f=fixture();f.api.newChat('/project');f.type('queued');await f.api.send('queued');
  assert.equal(f.requests()[0].transport,'native-user-v1');assert.equal(f.requests()[0].queueMode,'next');
  assert.equal(JSON.parse(f.posts()[0].options.body).priority,'now','retain the legacy intent field without exposing insertion controls');
});

test('lost POST response then refresh restores the same viewId and queries the original ID without reposting',async()=>{
  const first=fixture();first.api.newChat('/project');first.type('original message');
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
  await refreshed.api.send(original.text);await yieldTurn();
  assert.equal(refreshed.posts().length,0);assert.deepEqual(refreshed.requests().map(item=>item.requestId),[original.requestId]);
  assert.equal(refreshed.api.state.sessionId,original.requestId);
  assert.equal(refreshed.api.getDraftKey(),original.requestId);
  assert.equal(refreshed.api.readRememberedView().kind,'chat');
  assert.equal(refreshed.node('title').textContent,original.text);assert.equal(refreshed.node('input').value,'');
  await refreshed.api.checkDelivery(request);await yieldTurn();assert.equal(refreshed.posts().length,0);
  const nativeMessageId=randomUUID();
  refreshed.ctx.fetchHook=url=>url.startsWith('/claude/api/command/')?response(200,{requestId:original.requestId,sessionId:original.requestId,state:'accepted',nativeMessageId,transport:'native-user-v1'}):undefined;
  await refreshed.api.checkDelivery(request);await yieldTurn();
  assert.equal(request.state,'accepted');assert.equal(refreshed.stored()[0].nativeMessageId,nativeMessageId);
  refreshed.ctx.fetchHook=()=>response(200,{messages:[{id:nativeMessageId,nativeMessageId,requestId:request.requestId,role:'user',text:request.text}],cursor:1});
  await refreshed.api.poll();assert.equal(refreshed.stored().length,0);assert.equal(refreshed.ctx.users.length,1);
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
  post.resolve(response(200,{requestId:old.requestId,sessionId:old.requestId,state:'accepted',nativeMessageId:randomUUID(),transport:'native-user-v1'}));await sending;
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
  post.resolve(response(200,{requestId:request.requestId,sessionId:request.requestId,state:'accepted',nativeMessageId:randomUUID(),transport:'native-user-v1'}));await sending;
  assert.equal(f.api.drafts.has(request.scope),false);
  assert.equal(f.node('input').value,'unrelated visible input');assert.equal(f.api.state.sessionId,null);
  assert.equal(f.ctx.refreshes,refreshes+1,'accepted in background updates the visible list');
  assert.equal(request.state,'accepted');assert.equal(f.stored().length,1,'retain N until its native row is observed');
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
    post.resolve(response(200,{requestId:request.requestId,sessionId:request.requestId,state:'accepted',nativeMessageId:randomUUID(),transport:'native-user-v1'}));await sending;
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
  post.resolve(response(200,{requestId:request.requestId,sessionId:id,state:'accepted',nativeMessageId:randomUUID(),transport:'native-user-v1'}));await sending;
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
  post.resolve(response(200,{requestId:request.requestId,sessionId:request.requestId,state:'accepted',nativeMessageId:randomUUID(),transport:'native-user-v1'}));await sending;
  assert.equal(request.state,'accepted');assert.equal(f.posts().length,1);
});

test('existing session title is preserved, and navigation clears per-session native row associations',async()=>{
  const f=fixture(),id=randomUUID();f.api.nativeUserRows.set('stale-before-new',{});f.api.seenMessages.add('stale-before-new');
  f.api.newChat('/project');assert.equal(f.api.nativeUserRows.size,0);assert.equal(f.api.seenMessages.size,0);
  f.api.nativeUserRows.set('stale-before-open',{});f.api.seenMessages.add('stale-before-open');
  await f.api.openSession({id,cwd:'/project',title:'Keep native title'});
  assert.equal(f.api.nativeUserRows.size,0);assert.equal(f.api.seenMessages.size,0);
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
