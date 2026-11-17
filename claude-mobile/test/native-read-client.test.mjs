import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInContext,Script} from 'node:vm';
import {fixture as nativeFixture,scripts,client} from './native-ui-fixture.mjs';
const unread=readFileSync(new URL('../backend/lib/unread-indicator.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const marker={id:'cli',desktopSessionId:'desktop',replyId:'reply',known:true,unread:true,unreadVersion:'native-rev-1:reply'};
const transcript=(m=marker,messages=[{id:'reply',role:'assistant',text:'loaded reply'}])=>({id:m.id,messages,readMarker:m,cursor:8});
const response=value=>({ok:true,json:async()=>value});
function fixture(){
  const f=nativeFixture(),state=f.api.state,window=f.context.window;
  Object.assign(state,{sessionId:'cli',viewVersion:1,since:0,sending:false,loading:false,sessions:[{...marker}]});
  f.node('list').classList.add('hidden');f.node('chat').classList.remove('hidden');f.node('composer').classList.remove('hidden');
  const h={calls:f.ctx.calls,errors:f.ctx.errors,state,window,$:f.node,api:f.api,timers:f.timers,readResponse:()=>response({ok:true,verified:true,unread:false}),historyResponse:()=>response(transcript()),renderFails:false};
  const render=window.claudeRender;window.claudeRender=(...args)=>{if(h.renderFails)throw Error('render failed');return render(...args);};
  f.ctx.fetchHook=url=>url==='/claude/api/read'?h.readResponse():url.startsWith('/claude/api/session/')?h.historyResponse():undefined;
  runInContext(unread,f.context);state.unread=window.claudeUnread;
  h.sandbox={document:f.document,seenMessages:f.api.seenMessages,get hubActive(){return f.api.getHubActive();},set hubActive(value){f.api.setHubActive(value);}};
  Object.defineProperties(h,{refreshes:{get:()=>f.ctx.refreshes},loadError:{get:()=>f.node('messages').querySelector('.err')?.textContent}});
  h.posts=()=>f.ctx.calls.filter(call=>call.url==='/claude/api/read');
  return h;
}
test('every generated production script compiles and legacy unread storage/mask is absent',()=>{
  for(const script of scripts)new Script(script);
  assert.doesNotMatch(unread,/localStorage|clm-read-replies-v1/);
  assert.match(client,/let hubActive=parent===window;/,'embedded frame waits for parent activation');
});
test('opening the visible session renders its actual reply, posts native read, then refreshes authoritative sessions',async()=>{
  const h=fixture();await h.api.openSession({...marker,title:'test'});await turn();
  assert.equal(h.posts().length,1);assert.equal(h.refreshes,1);assert.equal(h.sandbox.seenMessages.has('reply'),true);
  assert.equal(h.state.unread.isUnread(h.state.sessions[0]),true,'only a later server session snapshot may clear the dot');
  assert.deepEqual(JSON.parse(h.posts()[0].options.body),{requestId:JSON.parse(h.posts()[0].options.body).requestId,sessionId:'cli',desktopSessionId:'desktop',unreadVersion:marker.unreadVersion});
});
test('failed rendering never qualifies a reply UUID as successfully loaded',async()=>{
  const h=fixture();h.renderFails=true;await h.api.openSession({...marker,title:'test'});await turn();
  assert.equal(h.posts().length,0);assert.equal(h.sandbox.seenMessages.has('reply'),false);assert.match(h.loadError,/消息显示失败.*重试/);assert.doesNotMatch(h.loadError,/render failed|电脑端连接/);
});
for(const boundary of ['hub','document','parent','chat-preview','composer-preview','menu','hidden-chat'])test(boundary+' suppresses native reads through the actual poll path',async()=>{
  const h=fixture();
  if(boundary==='hub')h.sandbox.hubActive=false;
  if(boundary==='document')h.sandbox.document.hidden=true;
  if(boundary==='parent')h.window.parent={document:{hidden:true}};
  if(boundary==='chat-preview')h.$('chat').inert=true;
  if(boundary==='composer-preview')h.$('composer').inert=true;
  if(boundary==='menu')h.$('optionsMenu').classList.remove('hidden');
  if(boundary==='hidden-chat')h.$('chat').classList.add('hidden');
  await h.api.poll();await turn();assert.equal(h.posts().length,0);
});
test('a delayed load for an abandoned session cannot acknowledge or render its reply',async()=>{
  const h=fixture(),pending=deferred();h.historyResponse=()=>pending.promise;
  const open=h.api.openSession({...marker,title:'old'});h.state.sessionId='other';h.state.viewVersion++;
  pending.resolve(response(transcript()));await open;await turn();assert.equal(h.posts().length,0);assert.equal(h.sandbox.seenMessages.size,0);
});
test('polling an empty delta cannot acknowledge a truly empty session until full history loads',async()=>{
  const h=fixture(),empty={...marker,replyId:null};h.state.since=8;h.historyResponse=()=>response(transcript(empty,[]));
  await h.api.poll();await turn();assert.equal(h.posts().length,0);
  await h.api.openSession({...empty,title:'empty'});await turn();assert.equal(h.posts().length,1);
});
test('failure stays visible and retry reuses the operation ID; navigating makes that retry inert',async()=>{
  const h=fixture();h.readResponse=()=>{throw Error('offline');};await h.api.poll();await turn();
  let status=h.errors.get('native-read:cli');assert.match(status.text,/offline/);assert.equal(status.visible(),true);assert.equal(h.state.unread.isUnread(marker),true);
  await h.api.poll();await turn();assert.equal(h.posts().length,1);
  status=h.errors.get('native-read:cli');h.readResponse=()=>response({ok:true,verified:true,unread:false});
  assert.equal(await status.retry(),true);assert.equal(h.posts().length,2);assert.equal(h.posts()[0].options.body,h.posts()[1].options.body);assert.equal(h.errors.size,0);
  h.readResponse=()=>{throw Error('offline');};h.historyResponse=()=>response(transcript({...marker,unreadVersion:'native-rev-2:manual'}));await h.api.poll();await turn();
  status=h.errors.get('native-read:cli');assert.ok(status);h.state.sessionId='other';h.state.viewVersion++;
  assert.equal(status.visible(),false);assert.equal(await status.retry(),false);assert.equal(h.posts().length,3);
});
test('manual native unread of the same reply posts a new operation; native false never posts',async()=>{
  const h=fixture();await h.api.poll();await turn();
  h.historyResponse=()=>response(transcript({...marker,unreadVersion:'native-rev-3:manual'},[]));await h.api.poll();await turn();
  assert.equal(h.posts().length,2);assert.notEqual(h.posts()[0].options.body,h.posts()[1].options.body);
  h.historyResponse=()=>response(transcript({...marker,unread:false,unreadVersion:'native-rev-4'},[]));await h.api.poll();await turn();assert.equal(h.posts().length,2);
});
test('unknown native state displays retry without posting or masking',async()=>{
  const h=fixture();h.historyResponse=()=>response(transcript({...marker,known:false}));await h.api.poll();await turn();
  const status=h.errors.get('native-read:cli');assert.match(status.text,/无法确认/);assert.equal(typeof status.retry,'function');assert.equal(h.posts().length,0);
});
test('synchronous and asynchronous controller failures are caught by the actual page wiring',async()=>{
  const h=fixture();
  for(const acknowledge of [()=>{throw Error('sync');},async()=>{throw Error('async');}]){
    h.state.unread={acknowledge};await h.api.poll();await turn();assert.match(h.errors.get('native-read:cli').text,/原生已读同步失败/);
  }
});
