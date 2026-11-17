import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {fixture,response,deferred,draftStorage,pendingStorage,plain,html} from './native-ui-fixture.mjs';
import {parseTranscript} from '../backend/lib/sessions.mjs';

const receipt=(request,nativeMessageId,extra={})=>({requestId:request.requestId,messageId:nativeMessageId||request.requestId,nativeMessageId,sessionId:request.sessionId,state:'accepted',transport:'native-user-v1',queueMode:'next',...extra});
const user=(request,id=randomUUID(),extra={})=>({id,nativeMessageId:id,requestId:request.requestId,role:'user',text:request.text,...extra});
const answer=text=>({id:randomUUID(),role:'assistant',text});
const rows=f=>f.node('messages').children.filter(node=>node.classList.contains('msg'));
const textRows=f=>rows(f).map(row=>row.querySelector('.user-text')?.textContent||row.textContent);
async function existing(f,messages=[]){
  const session={id:randomUUID(),cwd:'/fixture',title:'Native title'};
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages,cursor:messages.length}):undefined;
  await f.api.openSession(session);await turn();delete f.ctx.fetchHook;return session;
}
async function sendText(f,text){f.type(text);await f.api.send(text);await turn();return f.requests().at(-1);}
async function delta(f,messages,cursor=20){
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages,cursor}):undefined;
  await f.api.poll();await turn();
}

for(const order of ['receipt-first','transcript-first'])test(`real send → poll → append reconciles N != O (${order}) without crossing user turns`,async()=>{
  const f=fixture(),session=await existing(f,[answer('previous answer')]),post=deferred();
  f.ctx.fetchHook=(url,options)=>url==='/claude/api/chat'?post.promise:undefined;
  f.type('phone message');const sending=f.api.send('phone message'),request=f.requests()[0],native=user(request),optimistic=request.wrap;
  assert.notEqual(native.id,request.requestId);assert.equal(f.api.seenMessages.has(request.requestId),false);
  if(order==='receipt-first'){
    post.resolve(response(200,receipt(request,native.id)));await sending;await turn();
    assert.equal(f.api.seenMessages.has(native.id),false,'a receipt UUID is not a rendered native user');
    assert.equal(f.stored()[0].nativeMessageId,native.id,'keep the association until transcript ingestion');
  }
  await delta(f,[native,answer('new answer')]);
  if(order==='transcript-first'){post.resolve(response(200,receipt(request,native.id)));await sending;await turn();}
  assert.equal(request.wrap,optimistic,'reuse the optimistic row in place');
  assert.equal(f.ctx.users.length,1);assert.equal(request.nativeMessageId,native.id);assert.equal(request.nativeObserved,true);
  assert.equal(f.api.seenMessages.has(native.id),true);assert.equal(f.api.seenMessages.has(request.requestId),false);
  assert.deepEqual(textRows(f),['previous answer','phone message','new answer']);
  assert.equal(f.api.getOwners().length,2);assert.equal(f.stored().length,0);assert.equal(f.api.state.sessionId,session.id);
});

test('a native UUID already rendered without correlation is merged when its late receipt supplies N',async()=>{
  const f=fixture();await existing(f);const request=await sendText(f,'phone'),id=randomUUID();
  await delta(f,[{id,role:'user',text:'phone'}]);assert.equal(f.ctx.users.length,2,'uncorrelated text is never swallowed');
  assert.equal(f.api.receiveDelivery(request,receipt(request,id)),true);
  assert.equal(f.ctx.users.length,1);assert.equal(request.wrap,f.api.nativeUserRows.get(id));
});

for(const order of ['receipt-first','transcript-first'])test(`image preview survives empty native echo and later enrichment (${order}) in place`,async()=>{
  const f=fixture();await existing(f,[answer('上一轮回复')]);f.api.state.capabilities={attachments:true};
  f.api.state.attachments=[{id:'image-one.png',name:'手机图片.png',url:'/fake/image-one.png'}];
  const post=deferred();f.ctx.fetchHook=url=>url==='/claude/api/chat'?post.promise:undefined;
  f.type('识别图片');const sending=f.api.send('识别图片'),request=f.requests()[0],nativeId=randomUUID(),optimistic=request.wrap,image=optimistic.querySelector('img');
  const empty=user(request,nativeId,{attachments:[],attachmentDelivery:'file-reference'});
  if(order==='receipt-first'){post.resolve(response(200,receipt(request,nativeId,{attachmentDelivery:'file-reference'})));await sending;await turn();}
  await delta(f,[empty,answer('识别结果')]);
  assert.equal(request.wrap,optimistic);assert.ok(request.wrap.querySelector('img')===image,'an empty echo is not a deletion of a sent image');assert.equal(f.ctx.users.length,1);
  if(order==='transcript-first'){post.resolve(response(200,receipt(request,nativeId,{attachmentDelivery:'file-reference'})));await sending;await turn();}
  const owners=f.api.getOwners().length;
  await delta(f,[{...empty,attachments:[{id:'image-one.png',name:'图片',url:'/fake/image-one.png'}]}],21);
  assert.ok(request.wrap.querySelector('img')===image);assert.equal(image.alt,'图片');assert.equal(f.ctx.users.length,1);assert.equal(f.api.getOwners().length,owners,'enrichment is not a new turn boundary');
  await delta(f,[empty],22);assert.ok(request.wrap.querySelector('img')===image,'a later partial snapshot cannot erase the recovered preview');
  assert.deepEqual(textRows(f),['上一轮回复','识别图片','识别结果']);assert.equal(f.posts().length,1);assert.equal(f.ctx.reloads,0);
});

test('a late receipt transfers the optimistic image into its already-rendered native row',async()=>{
  const f=fixture();await existing(f);f.api.state.capabilities={attachments:true};f.api.state.attachments=[{id:'late-image.png',name:'图片.png',url:'/fake/late-image.png'}];
  const post=deferred();f.ctx.fetchHook=url=>url==='/claude/api/chat'?post.promise:undefined;
  f.type('同一张图');const sending=f.api.send('同一张图'),request=f.requests()[0],image=request.wrap.querySelector('img'),id=randomUUID();
  await delta(f,[{id,role:'user',text:'电脑端的展示文字',attachments:[]},answer('回答')]);const nativeRow=f.api.nativeUserRows.get(id);assert.equal(f.ctx.users.length,2);
  post.resolve(response(200,receipt(request,id,{attachmentDelivery:'file-reference'})));await sending;await turn();
  assert.equal(f.ctx.users.length,1);assert.equal(request.wrap,nativeRow);assert.ok(nativeRow.querySelector('img')===image);assert.equal(nativeRow.querySelector('.user-text').textContent,'电脑端的展示文字');
  await delta(f,[user(request,id,{text:'电脑端的展示文字',attachments:[{id:'late-image.png',name:'图片',url:'/fake/late-image.png'}]})],21);
  assert.ok(nativeRow.querySelector('img')===image);assert.deepEqual(textRows(f),['电脑端的展示文字','回答']);assert.equal(f.posts().length,1);
});

test('an already-seen native user without a pending request accepts late images without moving rows or splitting replies',async()=>{
  const f=fixture(),id=randomUUID();await existing(f,[{id,role:'user',text:'历史图片',attachments:[]},answer('历史回答')]);
  const row=f.api.nativeUserRows.get(id),before=rows(f),owner=f.api.getHistoryAssistant();
  await delta(f,[{id,role:'user',text:'历史图片',attachmentDelivery:'file-reference',attachments:[{id:'history.png',url:'/fake/history.png',name:'图片'}]}]);
  assert.deepEqual(rows(f),before);assert.equal(row.querySelectorAll('img').length,1);assert.equal(f.api.getHistoryAssistant(),owner);
  await delta(f,[{id,role:'user',text:'历史图片',attachments:[]}],21);assert.equal(row.querySelectorAll('img').length,1);
  assert.equal(f.posts().length,0);assert.equal(f.ctx.reloads,0);
});

test('partial multi-image echoes enrich metadata without losing, duplicating or reloading selected images',async()=>{
  const f=fixture();await existing(f);f.api.state.capabilities={attachments:true};
  const images=Array.from({length:3},(_,i)=>({id:'batch-'+i+'.png',name:'手机图片'+i,url:'/fake/batch-'+i+'.png'}));f.api.state.attachments=images;
  const request=await sendText(f,'三张图片'),nodes=request.wrap.querySelectorAll('img'),id=randomUUID();
  await delta(f,[user(request,id,{attachments:[{...images[1],name:'图片'}],attachmentDelivery:'file-reference'})]);
  assert.deepEqual(request.wrap.querySelectorAll('img').map(node=>node.src),images.map(image=>image.url));
  assert.ok(request.wrap.querySelectorAll('img').every((node,i)=>node===nodes[i]));
  await delta(f,[user(request,id,{attachments:images.map(image=>({...image,name:'图片'})),attachmentDelivery:'file-reference'})],21);
  assert.equal(request.wrap.querySelectorAll('img').length,3);assert.ok(request.wrap.querySelectorAll('img').every((node,i)=>node===nodes[i]));assert.equal(f.ctx.users.length,1);assert.equal(f.posts().length,1);
});

test('same-text uncorrelated native rows cannot borrow optimistic attachments',async()=>{
  const f=fixture();await existing(f);f.api.state.capabilities={attachments:true};f.api.state.attachments=[{id:'owned.png',url:'/fake/owned.png',name:'我的图片'}];
  const request=await sendText(f,'同样的文字'),id=randomUUID();
  await delta(f,[{id,role:'user',text:'同样的文字',attachments:[]}]);
  assert.equal(f.api.nativeUserRows.get(id).querySelectorAll('img').length,0);assert.equal(request.wrap.querySelectorAll('img').length,1);
  await delta(f,[{id,role:'user',text:'同样的文字',requestId:randomUUID(),attachments:[]}],21);
  assert.equal(f.api.nativeUserRows.get(id).querySelectorAll('img').length,0);assert.equal(f.ctx.users.length,2);
});

test('restored pending image operation fills an initially empty full-history echo by O/N only',async()=>{
  const requestId=randomUUID(),nativeMessageId=randomUUID(),sessionId=randomUUID(),attachment={id:'restored.png',url:'/fake/restored.png',name:'待同步图片'};
  const local=new Map([[pendingStorage,JSON.stringify([{requestId,nativeMessageId,sessionId,scope:sessionId,state:'dispatched',text:'恢复图片',attachments:[attachment],transport:'native-user-v1'}])]]);
  const f=fixture({local});f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages:[{id:nativeMessageId,requestId,role:'user',text:'恢复图片',attachments:[]}],cursor:1}):undefined;
  await f.api.openSession({id:sessionId,title:'图片历史'});await turn();assert.equal(f.ctx.users.length,1);assert.equal(f.node('messages').querySelectorAll('img').length,1);
  assert.equal(f.node('messages').querySelector('img').src,attachment.url);assert.equal(f.posts().length,0);
});

test('two real transcript polls promote queued U2 in place without splitting A1 or merging A2',async()=>{
  const f=fixture(),sessionId=randomUUID(),u1=randomUUID(),u2=randomUUID();
  const userRecord=(id,text)=>({type:'user',uuid:id,origin:{kind:'human'},message:{content:text}});
  const assistantRecord=(text,terminal=false)=>({type:'assistant',uuid:randomUUID(),message:{content:[{type:'text',text}],stop_reason:terminal?'end_turn':null}});
  let records=[userRecord(u1,'U1'),assistantRecord('A1开头')];
  const projection=since=>parseTranscript(records.map(record=>JSON.stringify(record)).join('\n')+'\n',sessionId,since);
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,projection(Number(new URL(url,'http://fixture').searchParams.get('since')))):undefined;
  await f.api.openSession({id:sessionId,title:'排队边界'});await turn();const firstAssistant=f.api.getHistoryAssistant();
  records.push({type:'attachment',uuid:randomUUID(),attachment:{type:'queued_command',humanTurn:true,source_uuid:u2,prompt:'U2'}},assistantRecord('A1尾部',true));
  const firstDelta=projection(f.api.state.since);assert.equal(firstDelta.currentUserId,u1);assert.equal(firstDelta.messages[0].queued,true);
  await f.api.poll();await turn();
  const queued=f.node('messages').querySelectorAll('.msg.user').find(row=>row.querySelector('.user-text')?.textContent==='U2');
  const queuedAnchor=queued.dataset.scrollKey;assert.equal(queued.dataset.queued,'true');assert.equal(queued.querySelector('.queued-status').textContent,'排队中');assert.equal(f.api.seenMessages.has(u2),false);assert.equal(f.api.nativeUserRows.has(u2),false);
  assert.ok(f.api.getHistoryAssistant()===firstAssistant);assert.equal(f.api.getOwners().length,1);assert.equal(firstAssistant.text,'A1开头\n\nA1尾部');
  records.push(userRecord(u2,'U2'),assistantRecord('A2',true));await f.api.poll();await turn();
  assert.ok(f.api.nativeUserRows.get(u2)===queued);assert.equal(queued.dataset.scrollKey,queuedAnchor);assert.equal(queued.dataset.queued,undefined);assert.equal(queued.querySelector('.queued-status'),null);assert.equal(f.api.seenMessages.has(u2),true);
  assert.equal(f.api.getOwners().length,2);assert.equal(firstAssistant.text,'A1开头\n\nA1尾部');assert.equal(f.api.getOwners()[1].text,'A2');assert.deepEqual(textRows(f),['U1','A1开头\n\nA1尾部','U2','A2']);
  const refreshed=fixture();refreshed.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,projection(0)):undefined;
  await refreshed.api.openSession({id:sessionId,title:'排队边界'});assert.deepEqual(textRows(f),textRows(refreshed));assert.equal(f.posts().length,0);assert.equal(f.ctx.reloads,0);
});

for(const receiptOrder of ['receipt-first','queue-first'])test(`queued phone image is not native-observed until its formal U2 (${receiptOrder})`,async()=>{
  const f=fixture();await existing(f,[{id:randomUUID(),role:'user',text:'U1'},answer('A1开头')]);f.api.state.capabilities={attachments:true};
  const attachment={id:'queued.png',url:'/fake/queued.png',name:'排队图片'};f.api.state.attachments=[attachment];const request=await sendText(f,'U2'),nativeId=randomUUID(),image=request.wrap.querySelector('img');
  if(receiptOrder==='receipt-first'){f.api.receiveDelivery(request,receipt(request,nativeId));await turn();}
  await delta(f,[{id:nativeId,role:'user',text:'U2',queued:true,attachments:[]},answer('A1尾部')]);
  if(receiptOrder==='queue-first'){f.api.receiveDelivery(request,receipt(request,nativeId));await turn();}
  const queued=request.wrap;assert.equal(queued.dataset.queued,'true');assert.equal(request.nativeObserved,false);assert.equal(f.api.seenMessages.has(nativeId),false);assert.equal(f.api.nativeUserRows.has(nativeId),false);
  assert.ok(queued.querySelector('img')===image);assert.equal(f.stored()[0].nativeMessageId,nativeId,'preserve O/N until the formal native row arrives');assert.equal(f.ctx.users.length,2);
  assert.equal(f.api.getOwners().length,1);assert.equal(f.api.getOwners()[0].text,'A1开头\n\nA1尾部');
  await delta(f,[user(request,nativeId,{attachments:[attachment]}),answer('A2')],21);
  assert.ok(request.wrap===queued);assert.ok(queued.querySelector('img')===image);assert.equal(request.nativeObserved,true);assert.equal(f.stored().length,0);assert.equal(f.api.getOwners().length,2);
  assert.deepEqual(textRows(f),['U1','A1开头\n\nA1尾部','U2','A2']);assert.equal(f.posts().length,1);
  await delta(f,[{id:nativeId,role:'user',text:'过期队列文字',queued:true,attachments:[]}],22);
  assert.equal(queued.querySelector('.queued-status'),null);assert.equal(queued.querySelector('.user-text').textContent,'U2');assert.equal(f.api.getOwners().length,2,'stale queue cannot downgrade a formal user or reset its assistant');
});

test('a first assistant chunk stays above queued desktop input and navigation drops old queue bindings',async()=>{
  const f=fixture(),u1=randomUUID(),u2=randomUUID();await existing(f,[{id:u1,role:'user',text:'U1'}]);
  await delta(f,[{id:u2,role:'user',text:'U2',queued:true,attachments:[{id:'queue-only.png',url:'/fake/queue-only.png',name:'排队图片'}]}]);
  const queued=f.node('messages').querySelectorAll('.msg.user').find(row=>row.dataset.queued==='true');
  await delta(f,[answer('A1尚在回复')],21);assert.deepEqual(textRows(f),['U1','A1尚在回复','U2']);assert.equal(queued.querySelector('.queued-status').textContent,'排队中');assert.equal(f.api.seenMessages.has(u2),false);
  f.api.newChat('/other');assert.equal(f.node('messages').querySelectorAll('.queued-status').length,0);
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages:[{id:u2,role:'user',text:'重新读取的正式输入',attachments:[]}],cursor:1}):undefined;
  await f.api.openSession({id:randomUUID(),title:'另一视图'});assert.ok(f.api.nativeUserRows.get(u2)!==queued);assert.equal(f.node('messages').querySelectorAll('img').length,0,'a new view cannot inherit a previous queue image');
});

test('full history with requestId association precedes pending restore without duplicate users',async()=>{
  const requestId=randomUUID(),nativeMessageId=randomUUID(),sessionId=randomUUID();
  const local=new Map([[pendingStorage,JSON.stringify([{requestId,nativeMessageId,sessionId,scope:sessionId,state:'unknown',text:'restored',attachments:[],transport:'native-user-v1'}])]]);
  const f=fixture({local});f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages:[{id:nativeMessageId,nativeMessageId,requestId,role:'user',text:'restored'}],cursor:1}):undefined;
  await f.api.openSession({id:sessionId,title:'Native'});await turn();
  assert.equal(f.ctx.users.length,1);assert.equal(f.requests()[0].nativeObserved,true);assert.equal(f.requests()[0].nativeMessageId,nativeMessageId);
  f.api.restorePendingMessages();assert.equal(f.ctx.users.length,1);
});

test('two deliberate identical drafts are two operations and native output stays above queued optimistic rows',async()=>{
  const f=fixture();await existing(f);
  const first=await sendText(f,'继续'),second=await sendText(f,'继续');
  assert.equal(f.posts().length,2);assert.notEqual(first.requestId,second.requestId);assert.notEqual(first.draftRevision,second.draftRevision);
  await delta(f,[user(first),answer('first answer')]);
  assert.deepEqual(textRows(f),['继续','first answer','继续']);
  assert.equal(rows(f).at(-1),second.wrap);
});

test('a desktop user with the same text is preserved and cannot own the phone operation',async()=>{
  const f=fixture();await existing(f);const request=await sendText(f,'same text'),desktopId=randomUUID();
  await delta(f,[{id:desktopId,role:'user',text:'same text'},answer('desktop answer')]);
  assert.equal(f.ctx.users.length,2);assert.equal(request.nativeMessageId,null);
  assert.deepEqual(textRows(f),['same text','desktop answer','same text']);
  await delta(f,[user(request),answer('phone answer')],22);
  assert.deepEqual(textRows(f),['same text','desktop answer','same text','phone answer']);
});

test('unknown status and racing 404 only query the original O, including the explicit status button',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.ctx.fetchHook=url=>url==='/claude/api/chat'?Promise.reject(Error('lost response')):undefined;
  const request=await sendText(f,'original');assert.equal(request.state,'unknown');
  const button=request.wrap.querySelector('.message-delivery').querySelector('button');assert.equal(button.textContent,'查询状态');
  await button.onclick();await turn();
  assert.equal(f.posts().length,1);assert.equal(f.requests().length,1);assert.equal(f.stored()[0].requestId,request.requestId);
  assert.ok(f.queries().every(call=>call.url.endsWith(request.requestId)));
});

test('a lost first new-chat response blocks another null target, preserves its new draft, then binds once',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.ctx.fetchHook=url=>url==='/claude/api/chat'?Promise.reject(Error('lost response')):undefined;
  const original=await sendText(f,'first');f.type('second');await f.api.send('second');await turn();
  assert.equal(f.posts().length,1);assert.equal(f.node('send').disabled,true);assert.equal(f.node('input').value,'second');
  const sessionId=randomUUID();assert.notEqual(sessionId,original.requestId);
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/command/')?response(200,receipt(original,randomUUID(),{sessionId})):undefined;
  await f.api.checkDelivery(original);await turn();
  assert.equal(f.api.state.sessionId,sessionId);assert.equal(f.node('input').value,'second');
  const second=await sendText(f,'second');assert.equal(f.posts().length,2);assert.equal(second.sessionId,sessionId);
  assert.equal(JSON.parse(f.posts()[1].options.body).sessionId,sessionId);
});

test('navigating during an unknown status read neither hijacks the new target nor posts again',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.ctx.fetchHook=url=>url==='/claude/api/chat'?Promise.reject(Error('lost response')):undefined;
  const request=await sendText(f,'first'),status=deferred();
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/command/')?status.promise:undefined;
  const check=request.wrap.querySelector('.message-delivery').querySelector('button').onclick();
  const other={id:randomUUID(),title:'Other',cwd:'/other'};await f.api.openSession(other);f.type('keep here');
  status.resolve(response(200,receipt(request,randomUUID(),{sessionId:randomUUID()})));await check;await turn();
  assert.equal(f.api.state.sessionId,other.id);assert.equal(f.node('input').value,'keep here');assert.equal(f.posts().length,1);
});

test('an accepted receipt cannot clear a later identical draft revision',async()=>{
  const f=fixture();await existing(f);const request=await sendText(f,'继续');f.type('继续');const revision=f.api.state.draftRevision;
  f.api.receiveDelivery(request,receipt(request,randomUUID()));
  assert.equal(f.node('input').value,'继续');assert.equal(f.api.state.draftRevision,revision);
  assert.equal(JSON.parse(f.session.get(draftStorage))[f.api.getDraftKey()].text,'继续');
});

test('input writes through immediately, and a confirmed draft does not reappear after refresh',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.type('unsent draft');
  const refreshed=fixture({local:f.local,session:f.session});await refreshed.api.bootstrap();await turn();assert.equal(refreshed.node('input').value,'unsent draft');
  const request=await sendText(refreshed,'unsent draft');refreshed.api.receiveDelivery(request,receipt(request,randomUUID()));
  const again=fixture({local:refreshed.local,session:refreshed.session});await again.api.bootstrap();await turn();
  assert.equal(again.node('input').value,'');assert.equal(again.ctx.users.length,1,'accepted but not observed native message remains recoverable');
});

test('a late accepted response is final and cannot rebind a command to a different target or native UUID',async()=>{
  const f=fixture();await existing(f);const request=await sendText(f,'phone'),nativeId=randomUUID();
  assert.equal(f.api.receiveDelivery(request,receipt(request,nativeId)),true);
  assert.equal(f.api.receiveDelivery(request,receipt(request,randomUUID())),false);
  assert.equal(f.api.receiveDelivery(request,receipt(request,nativeId,{sessionId:randomUUID()})),false);
  assert.equal(f.api.receiveDelivery(request,receipt(request,nativeId,{state:'unknown'})),true);
  assert.equal(request.state,'accepted');assert.equal(request.nativeMessageId,nativeId);
});

test('HTTP 200 or unmarked rejection is not native acceptance or permission to repost',async t=>{
  for(const result of [{state:'accepted',nativeMessageId:null},{state:'rejected'},{ok:true}])await t.test(JSON.stringify(result),async()=>{
    const f=fixture();f.api.newChat('/fixture');
    f.ctx.fetchHook=(url,options)=>url==='/claude/api/chat'?response(200,{requestId:JSON.parse(options.body).requestId,sessionId:randomUUID(),transport:'native-user-v1',...result}):undefined;
    const request=await sendText(f,'keep draft');assert.equal(request.state,'unknown');assert.equal(request.notDispatched,false);assert.equal(f.node('input').value,'keep draft');
    await request.wrap.querySelector('.message-delivery').querySelector('button').onclick();await turn();assert.equal(f.posts().length,1);
  });
});

test('explicit image rejection preserves the draft and is the only route to a fresh retry',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.api.state.capabilities={attachments:true};f.api.state.attachments=[{id:'image',name:'photo.png',url:'/fake/image'}];
  f.ctx.fetchHook=url=>url==='/claude/api/chat'?response(409,{notDispatched:true,state:'rejected',error:'原生通道暂不支持图片'}):undefined;
  const request=await sendText(f,'look at this');
  assert.equal(request.state,'rejected');assert.equal(request.notDispatched,true);assert.equal(f.node('input').value,'look at this');assert.equal(f.api.state.attachments[0].id,'image');
  assert.doesNotMatch(request.wrap.textContent,/已送达|已作为原生附件/);assert.equal(f.queries().length,0);
  await request.wrap.querySelector('.message-delivery').querySelector('button').onclick();await turn();
  assert.equal(f.posts().length,2);assert.notEqual(f.requests()[1].requestId,request.requestId);
});

test('a rejected retry button belongs to its original view version',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.ctx.fetchHook=url=>url==='/claude/api/chat'?response(503,{notDispatched:true,error:'not dispatched'}):undefined;
  const request=await sendText(f,'original'),button=request.wrap.querySelector('.message-delivery').querySelector('button');
  f.api.newChat('/fixture');f.type('new draft');await button.onclick();await turn();
  assert.equal(f.posts().length,1);assert.equal(f.node('input').value,'new draft');
});

test('the submit timeout preserves O and any late body cannot create a second operation',async()=>{
  const f=fixture();f.api.newChat('/fixture');const post=deferred();f.ctx.fetchHook=url=>url==='/claude/api/chat'?post.promise:undefined;
  f.type('slow');const sending=f.api.send('slow'),request=f.requests()[0];await f.runTimers(45000);await sending;await turn();
  assert.equal(request.state,'unknown');assert.equal(request.posting,false);assert.equal(f.stored()[0].requestId,request.requestId);
  post.resolve(response(200,receipt(request,randomUUID(),{sessionId:randomUUID()})));await turn();assert.equal(f.posts().length,1);assert.equal(request.state,'unknown');
});

test('paging cancellation releases the next view and an old finally cannot unlock its new read',async()=>{
  const f=fixture(),first=await existing(f),oldPage=deferred(),newPage=deferred();f.api.state.hasOlder=true;f.api.state.before=10;
  f.ctx.fetchHook=url=>url.includes('?before=')?oldPage.promise:undefined;
  const old=f.api.loadOlder(),oldSignal=f.ctx.calls.at(-1).options.signal;
  const second={id:randomUUID(),title:'Second'};await f.api.openSession(second);assert.equal(oldSignal.aborted,true);assert.equal(f.api.state.loadingOlder,false);
  f.api.state.hasOlder=true;f.api.state.before=20;f.ctx.fetchHook=url=>url.includes('?before=')?newPage.promise:undefined;
  const next=f.api.loadOlder();oldPage.resolve(response(200,{messages:[{id:'old',role:'user',text:'old'}],before:1,hasMore:false}));await old;
  assert.equal(f.api.state.loadingOlder,true);assert.equal(f.api.state.sessionId,second.id);assert.notEqual(first.id,second.id);
  newPage.resolve(response(200,{messages:[{id:'new',role:'user',text:'new'}],before:1,hasMore:false}));await next;
  assert.equal(f.api.state.loadingOlder,false);assert.deepEqual(textRows(f),['new']);
});

test('a page timeout is finite and permits another real older-history read',async()=>{
  const f=fixture();await existing(f);f.api.state.hasOlder=true;f.api.state.before=10;const never=deferred();f.ctx.fetchHook=url=>url.includes('?before=')?never.promise:undefined;
  const loading=f.api.loadOlder();await f.runTimers(15000);await loading;assert.equal(f.api.state.loadingOlder,false);assert.ok(f.ctx.errors.has('history'));
  f.ctx.fetchHook=url=>url.includes('?before=')?response(200,{messages:[],before:null,hasMore:false}):undefined;await f.api.loadOlder();assert.equal(f.api.state.hasOlder,false);assert.equal(f.ctx.errors.has('history'),false);
});

test('a queued cursor-reset reload cannot reopen a page after navigation',async()=>{
  const f=fixture(),session=await existing(f);f.api.finallyReloadSession(session);f.api.showList();
  const reads=f.ctx.calls.length;await f.runTimers(0);await turn();
  assert.equal(f.api.state.sessionId,null);assert.equal(f.node('list').classList.contains('hidden'),false);assert.equal(f.ctx.calls.length,reads);
});

test('background upload completion writes the original draft and refresh never restores a fictitious running upload',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.api.state.capabilities={attachments:true};const pending=deferred();f.ctx.fetchHook=url=>url==='/claude/api/upload'?pending.promise:undefined;
  const uploading=f.api.uploadFile({name:'photo.png',size:20});await turn();const scope=f.api.getDraftKey();f.api.showList();
  const interrupted=fixture({local:f.local,session:f.session});interrupted.api.newChat('/fixture');assert.equal(interrupted.api.state.attachments[0].uploading,false);assert.equal(interrupted.api.state.attachments[0].failed,true);
  pending.resolve(response(200,{id:'uploaded-image',url:'/fake/uploaded-image'}));await uploading;
  const saved=JSON.parse(f.session.get(draftStorage))[scope].attachments[0];assert.equal(saved.id,'uploaded-image');assert.equal(saved.uploading,false);assert.equal(saved.file,undefined);
  const completed=fixture({local:f.local,session:f.session});completed.api.newChat('/fixture');assert.equal(completed.api.state.attachments[0].id,'uploaded-image');assert.equal(completed.api.state.attachments[0].failed,false);
});

test('reselecting an interrupted image replaces that slot, and file-picker results cannot cross views',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.api.state.capabilities={attachments:true};const item={name:'old.png',failed:true,uploading:false};f.api.state.attachments=[item];f.api.saveDraft(true);
  await f.api.uploadFile(undefined,item);f.ctx.fetchHook=url=>url==='/claude/api/upload'?response(200,{id:'new-image',url:'/fake/new-image'}):undefined;
  f.node('file').files=[{name:'new.png',size:10}];f.node('file').dispatch('change');await turn();
  assert.equal(f.api.state.attachments.length,1);assert.equal(item.id,'new-image');assert.equal(item.failed,false);
  f.api.attachmentAction();f.api.newChat('/other');f.node('file').files=[{name:'stale.png',size:10}];const uploads=f.ctx.calls.filter(call=>call.url==='/claude/api/upload').length;f.node('file').dispatch('change');await turn();
  assert.equal(f.api.state.attachments.length,0);assert.equal(f.ctx.calls.filter(call=>call.url==='/claude/api/upload').length,uploads);
});

test('command payload attachments are snapshots, and failed local durability never reaches the transport',async()=>{
  const f=fixture();await existing(f);f.api.state.capabilities={attachments:true};const attachment={id:'original-image',name:'image.png',url:'/fake/image'};f.api.state.attachments=[attachment];const post=deferred();f.ctx.fetchHook=url=>url==='/claude/api/chat'?post.promise:undefined;
  f.type('image');const sending=f.api.send('image'),request=f.requests()[0];attachment.id='replacement';assert.equal(request.attachments[0].id,'original-image');
  post.resolve(response(409,{notDispatched:true,error:'unsupported'}));await sending;assert.deepEqual(JSON.parse(f.posts()[0].options.body).attachments,['original-image']);
  const blocked=fixture();blocked.api.newChat('/fixture');blocked.context.localStorage.setItem=()=>{throw Error('quota');};const rejected=await sendText(blocked,'keep');
  assert.equal(blocked.posts().length,0);assert.equal(rejected.notDispatched,true);assert.equal(blocked.node('input').value,'keep');
});

test('build reload defers for current images, background File uploads and IME',async()=>{
  const f=fixture();f.api.newChat('/fixture');f.api.state.attachments=[{id:'image'}];assert.equal(f.api.buildReloadSafe(),false);
  f.api.state.attachments=[];f.api.drafts.set('background',{text:'',attachments:[{uploading:true,file:{name:'image'}}]});assert.equal(f.api.buildReloadSafe(),false);
  f.api.drafts.delete('background');f.node('input').dispatch('compositionstart');assert.equal(f.api.buildReloadSafe(),false);
  f.node('input').dispatch('compositionend');assert.equal(f.api.buildReloadSafe(),true);
});

test('measured mobile geometry has a left 16px status slot and one conversation gutter',()=>{
  assert.match(html,/--conversation-gutter:16px;--conversation-width:calc\(100% - var\(--conversation-gutter\) - var\(--conversation-gutter\)\)/);
  assert.match(html,/#waitingStatus,#planDock,#composer\{width:var\(--conversation-width\);min-width:0;margin-left:auto;margin-right:auto\}/);
  assert.match(html,/#messages\{[^}]*padding:20px var\(--conversation-gutter\) 24px/);
  assert.match(html,/\.row\{[^}]*gap:8px;padding:2px 4px 2px 12px;[^}]*height:36px/);
  assert.match(html,/\.row-status\{[^}]*width:16px;height:16px;flex:0 0 16px/);
  assert.match(html,/#composer\{[^}]*padding:10px;[^}]*border:1px solid var\(--line\);border-radius:16px/);
  assert.match(html,/#input\{[^}]*height:44px;min-height:44px;max-height:44px;overflow-y:auto/);
  assert.match(html,/#input::placeholder\{[^}]*font-size:16px/);
  assert.doesNotMatch(html,/运行状态待确认|电脑端模型待确认|图片已作为原生附件送达电脑端|并以文件读取图片/);
});

test('list activity and unread share the left slot; clocks and unknown state never fabricate activity',()=>{
  const f=fixture(),id=randomUUID(),base={id,cwd:'/fixture',title:'不会被状态挤到右侧的标题',messageCount:2,updatedAt:f.ctx.wall,unread:true,unreadKnown:true};
  f.api.state.unread={isUnread:session=>session.unread===true};
  f.api.state.sessions=[{...base,running:true}];f.api.renderSessions();
  const row=f.node('rows').querySelector('.row'),slot=row.firstElementChild,mark=slot.firstElementChild,title=row.children[1],time=row.lastElementChild,stamp=time.textContent;
  assert.equal(slot.className,'row-status');assert.equal(title.className,'name');assert.equal(mark.className,'dot');assert.equal(slot.getAttribute('aria-label'),'未读回复');
  f.api.state.sessions=[{...base,running:true,runtime:{known:true,phase:'running',running:true,serverNowMs:f.ctx.wall}}];f.api.renderSessions();
  assert.equal(f.node('rows').querySelector('.row'),row);assert.equal(mark.className,'spark');assert.equal(time.textContent,stamp);assert.equal(title.textContent,base.title);
  f.api.state.sessions=[{...base,running:true,waitingFor:'permission prompt',runtime:{known:true,phase:'running',running:true,serverNowMs:f.ctx.wall}}];f.api.renderSessions();
  assert.equal(mark.className,'waiting-indicator');assert.equal(mark.textContent,'!');assert.equal(slot.getAttribute('aria-label'),'等待你在电脑端确认');assert.equal(time.textContent,stamp);
  f.api.state.sessions=[{...base,unread:false,unreadKnown:false,runtime:{known:false,phase:'unknown',running:false}}];f.api.renderSessions();
  assert.equal(mark.className,'dot');assert.equal(mark.style.visibility,'visible','unknown unread keeps the last native unread, not a local read mask');
  f.api.state.sessions=[{...base,unread:false,runtime:{known:true,phase:'idle',running:false}}];f.api.renderSessions();
  assert.equal(mark.style.visibility,'hidden');assert.equal(slot.getAttribute('aria-label'),null);assert.equal(row.children[1],title);assert.equal(time.textContent,stamp);
});

test('unknown runtime is quiet; running and elapsed need a real native phase and turn clock',async()=>{
  const f=fixture();await existing(f);const box=f.node('waitingStatus');
  for(const control of [{running:true},{running:false},{running:true,runtime:{known:false,phase:'unknown',running:true}}]){
    f.api.applyControl(control);assert.equal(box.classList.contains('hidden'),true);assert.equal(box.textContent,'');
  }
  f.api.applyControl({running:true,runtime:{known:true,phase:'running',running:true,serverNowMs:10000}});
  assert.equal(box.classList.contains('hidden'),false);assert.equal(box.querySelector('.runtime-label').textContent,'进行中');assert.equal(box.querySelector('.runtime-duration').hidden,true);
  assert.equal(box.querySelector('.runtime-icon').classList.contains('spark'),true);
  f.api.applyControl({running:true,runtime:{known:true,phase:'running',running:true,turnId:'native-turn',startedAtMs:1000,serverNowMs:10000}});
  const label=box.querySelector('.runtime-label'),duration=box.querySelector('.runtime-duration');assert.equal(duration.textContent,' · 9秒');
  f.advance(2100);f.ctx.wall+=86400000;f.api.tickRuntime();assert.equal(duration.textContent,' · 11秒','the phone wall clock cannot change native elapsed time');assert.equal(duration.getAttribute('datetime'),'PT11S');assert.equal(box.querySelector('.runtime-label'),label);
  f.advance(15000);f.api.tickRuntime();assert.equal(box.classList.contains('hidden'),true,'a stale observation is not an endlessly running clock');assert.equal(box.querySelector('.runtime-icon'),null);
});

test('waiting, ended, disconnected and failed refresh use distinct evidence without phantom success',async()=>{
  const f=fixture();await existing(f);const box=f.node('waitingStatus');
  f.api.applyControl({running:true,waitingFor:'permission prompt',runtime:{known:true,phase:'waiting',running:false,startedAtMs:0,serverNowMs:10000}});
  assert.equal(box.querySelector('.runtime-label').textContent,'等待你在电脑端确认');assert.equal(box.querySelector('.runtime-icon'),null);
  f.api.applyControl({running:false,runtime:{known:true,phase:'idle',running:false,durationMs:4250,serverNowMs:20000}});
  assert.equal(box.querySelector('.runtime-label').textContent,'本轮已结束');assert.equal(box.querySelector('.runtime-duration').textContent,' · 4秒');
  f.advance(1000);f.api.tickRuntime();assert.equal(box.querySelector('.runtime-duration').textContent,' · 4秒');
  f.api.applyControl({running:false,nativeInputReady:false,runtime:{known:false,phase:'unknown',running:false}});
  assert.equal(box.dataset.phase,'disconnected');assert.equal(box.querySelector('.runtime-label').textContent,'电脑端未连接');assert.equal(box.querySelector('.runtime-duration').hidden,true);
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages:[],cursor:2,control:{nativeInputReady:true,runtime:{known:false,phase:'unknown',running:false}}}):undefined;
  await box.querySelector('.runtime-retry').click();assert.equal(f.posts().length,0);assert.equal(box.classList.contains('hidden'),true);
  f.api.applyControl({running:true,runtime:{known:true,phase:'running',running:true,startedAtMs:0,serverNowMs:10000}});
  f.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?Promise.reject(Error('offline')):undefined;
  await f.api.poll();assert.equal(box.classList.contains('hidden'),true);assert.match(f.ctx.errors.get('poll').text,/无法更新.*保留/);assert.equal(typeof f.ctx.errors.get('poll').retry,'function');
});

test('native task updates preserve expanded rows and only spin while runtime is truly running',async()=>{
  const f=fixture();await existing(f);f.api.renderPlan([{content:'已经完成',status:'completed'},{content:'当前任务',status:'in_progress'},{content:'后续任务',status:'pending'}]);
  f.node('planChip').click();f.api.renderPlan(f.api.state.plan);const row=f.node('planList').children[1];
  assert.equal(f.node('planDock').classList.contains('hidden'),false);assert.equal(f.node('planChip').getAttribute('aria-expanded'),'true');assert.equal(row.firstElementChild.querySelector('.spark'),null);
  f.api.applyControl({running:true,runtime:{known:true,phase:'running',running:true}});assert.ok(row.firstElementChild.querySelector('.spark'));assert.ok(f.node('planChip').querySelector('.plan-running'));
  f.api.applyControl({running:false,runtime:{known:true,phase:'waiting',running:false}});assert.equal(row.firstElementChild.querySelector('.spark'),null);assert.equal(f.node('planChip').querySelector('.plan-running'),null);
  f.api.renderPlan([{content:'已经完成',status:'completed'},{content:'当前任务',status:'completed'},{content:'后续任务',status:'in_progress'}]);
  assert.equal(f.node('planList').children[1],row);assert.equal(f.node('planChip').getAttribute('aria-expanded'),'true');assert.match(f.node('planTask').textContent,/2 已完成/);
});

for(const count of [1,3])test(`real file change snapshots a live FileList before reset, then sends and restores ${count} image previews`,async()=>{
  const f=fixture();f.api.newChat('/fixture');f.api.state.capabilities={attachments:true};f.api.attachmentAction();
  const liveFiles=Array.from({length:count},(_,i)=>({name:'photo-'+i+'.png',size:20,data:'bytes-'+i}));f.node('file').files=liveFiles;
  f.ctx.fetchHook=(url,options)=>{
    if(url==='/claude/api/upload'){const {name}=JSON.parse(options.body);return response(200,{id:name,url:'/fake/'+name,name});}
  };
  f.node('file').dispatch('change');assert.equal(liveFiles.length,0,'the fixture models native FileList clearing with input.value');await turn();
  assert.equal(f.ctx.calls.filter(call=>call.url==='/claude/api/upload').length,count);assert.equal(f.node('attachments').classList.contains('hidden'),false);assert.equal(f.node('attachments').children.length,count);
  assert.equal(f.api.state.attachments.every(item=>item.id&&!item.uploading&&!item.failed),true);
  const pending=fixture({local:f.local,session:f.session});await pending.api.bootstrap();await turn();assert.equal(pending.node('attachments').children.length,count,'uploaded previews survive a new-page refresh before sending');
  const request=await sendText(f,count===1?'':'请看这几张图');assert.deepEqual(JSON.parse(f.posts()[0].options.body).attachments,Array.from({length:count},(_,i)=>'photo-'+i+'.png'));
  assert.equal(request.wrap.querySelectorAll('img').length,count);assert.equal(f.node('input').value,'');
  const nativeId=randomUUID();f.api.receiveDelivery(request,receipt(request,nativeId,{attachmentDelivery:'file-reference'}));await turn();
  assert.equal(request.wrap.querySelector('.attachment-delivery'),null);assert.doesNotMatch(request.wrap.textContent,/已读取|原生附件|非原生/);
  const refreshed=fixture({local:f.local,session:f.session});refreshed.ctx.fetchHook=url=>url.startsWith('/claude/api/session/')?response(200,{messages:[user(request,nativeId,{attachments:request.attachments,attachmentDelivery:'file-reference'})],cursor:1,control:{runtime:{known:false,phase:'unknown'}}}):undefined;
  await refreshed.api.openSession({id:request.sessionId,title:'图片会话'});await turn();assert.equal(refreshed.ctx.users.length,1);assert.equal(refreshed.node('messages').querySelectorAll('img').length,count);assert.doesNotMatch(refreshed.node('messages').textContent,/已读取|原生附件|非原生/);
});
