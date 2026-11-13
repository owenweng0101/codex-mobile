import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../backend/lib/unread-indicator.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const receipt={ok:true,verified:true,unread:false};
const response=(body=receipt,ok=true,status=200)=>({ok,status,json:async()=>body});
const accepted=()=>response({ok:false,verified:false,unread:true,pending:true},true,202);
function fixture(storage=new Map()){
  const calls=[],statuses=[],verified=[],timers=new Map(),delays=new Map(),listeners=new Map();let uuid=0,timer=0,visible=true;
  const document={hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn)},window={};window.parent=window;
  const h={calls,statuses,verified,timers,window,document,storage,uuidCount:()=>uuid,reply:()=>response(),setVisible:value=>visible=value};
  vm.runInNewContext(source,{window,document,AbortController,crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`},
    fetch:(url,options)=>{calls.push({url,...options,body:JSON.parse(options.body)});return h.reply(calls.at(-1).body);},
    setTimeout:(fn,ms)=>{timers.set(++timer,fn);delays.set(timer,ms);return timer;},clearTimeout:id=>{timers.delete(id);delays.delete(id);},
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    localStorage:{getItem(){throw Error('must not read local storage');},setItem(){throw Error('must not mask native state');}}
  });
  h.api=window.claudeUnread;
  h.options={isVisible:()=>visible,fullHistory:true,onStatus:(text,retry)=>statuses.push({text,retry}),onVerified:value=>verified.push(value),refresh:()=>{}};
  h.ack=(m=marker,seen=new Set(['reply-a']),transcript={id:m.id,messages:[{id:'reply-a'}]},options={})=>h.api.acknowledge(m,seen,transcript,{...h.options,...options});
  h.check=()=>{const entry=[...timers].find(([id])=>delays.get(id)<30000);if(!entry)return false;const [id,fn]=entry;timers.delete(id);delays.delete(id);fn();return true;};
  h.hide=()=>{document.hidden=true;listeners.get('visibilitychange')?.();};
  h.expire=()=>{for(const fn of [...timers.values()])fn();};
  return h;
}
const session={id:'cli',desktopSessionId:'desktop',unread:true,known:true,unreadVersion:'native-seq-10:reply-a'};
const marker={...session,replyId:'reply-a'};
test('isUnread follows only the supplied native boolean, regardless of reply/version/owner or earlier receipts',async()=>{
  const h=fixture();
  for(const extra of [{running:false},{running:true},{unreadVersion:null},{desktopSessionId:null}])assert.equal(h.api.isUnread({...session,...extra}),true);
  assert.equal(await h.ack(),true);
  assert.equal(h.api.isUnread(session),true,'receipt is not a local unread mask');
  for(const unread of [false,null,undefined])assert.equal(h.api.isUnread({...session,unread}),false);
  assert.equal(fixture().api.isUnread(session),true,'no persisted receipts');
});
test('posts only the exact target and stable operation ID after its reply loads',async()=>{
  const h=fixture();
  assert.equal(await h.ack(marker,new Set()),false);
  assert.equal(await h.ack(marker,new Set(['reply-a']),{id:'other',messages:[]}),false);
  assert.equal(h.calls.length,0);
  assert.equal(await h.ack(),true);
  const call=h.calls[0];assert.equal(call.url,'/claude/api/read');assert.equal(call.method,'POST');assert.equal(call.credentials,'same-origin');
  assert.deepEqual(call.body,{requestId:'00000000-0000-4000-8000-000000000001',sessionId:'cli',desktopSessionId:'desktop',unreadVersion:marker.unreadVersion});
  assert.equal(await h.ack(),true);assert.equal(h.calls.length,1);
  assert.equal(h.verified.length,1);assert.equal(h.timers.size,0);
});
test('supports a replyUUID marker without guessing another reply',async()=>{
  const h=fixture(),m={...marker,replyId:undefined,replyUUID:'reply-b'};
  assert.equal(await h.ack(m),false);assert.equal(await h.ack(m,new Set(['reply-b'])),true);
});
test('concurrent observations of one native version post once',async()=>{
  const h=fixture(),pending=deferred();h.reply=()=>pending.promise;
  const one=h.ack(),two=h.ack();assert.equal(h.calls.length,1);
  pending.resolve(response());assert.deepEqual(await Promise.all([one,two]),[true,true]);
});
test('manual unread of the same reply with a new native revision makes a new operation',async()=>{
  const h=fixture();await h.ack();
  const manual={...marker,unreadVersion:'native-seq-12:reply-a'};
  assert.equal(await h.ack(manual),true);assert.equal(h.calls.length,2);
  assert.notEqual(h.calls[0].body.requestId,h.calls[1].body.requestId);
  assert.equal(h.api.isUnread(manual),true);
});
test('native false and unknown never invoke resume; unknown offers refresh',async()=>{
  const h=fixture();assert.equal(await h.ack({...marker,unread:false}),false);
  assert.equal(await h.ack({...marker,known:false}),false);assert.equal(h.calls.length,0);
  assert.match(h.statuses.at(-1).text,/无法确认/);assert.equal(typeof h.statuses.at(-1).retry,'function');
});
test('genuinely empty history requires a complete load of that same empty session',async()=>{
  const h=fixture(),empty={...marker,replyId:null};
  for(const [transcript,seen,options] of [
    [{id:'other',messages:[]},new Set(),{}],
    [{id:empty.id,messages:[]},new Set(),{fullHistory:false}],
    [{id:empty.id,messages:[],truncated:true},new Set(),{}],
    [{id:empty.id,messages:[]},new Set(['previous-message']),{}],
    [{id:empty.id,messages:[{id:'user'}]},new Set(),{}],
  ])assert.equal(await h.ack(empty,seen,transcript,options),false);
  assert.equal(h.calls.length,0);
  assert.equal(await h.ack(empty,new Set(),{id:empty.id,messages:[]}),true);
});
test('hidden document, hidden parent/frame, preview or stale view never acknowledge',async()=>{
  const h=fixture();h.setVisible(false);assert.equal(await h.ack(),false);
  h.setVisible(true);h.document.hidden=true;assert.equal(await h.ack(),false);h.document.hidden=false;
  h.window.parent={document:{hidden:true}};assert.equal(await h.ack(),false);
  h.window.parent.document.hidden=false;h.window.frameElement={closest:()=>null,getClientRects:()=>[]};assert.equal(await h.ack(),false);
  h.window.frameElement.getClientRects=()=>[{}];h.window.frameElement.closest=()=>({});assert.equal(await h.ack(),false);
  assert.equal(h.calls.length,0);
});
for(const body of [{ok:true,unread:false},{ok:true,verified:false,unread:false},{ok:true,verified:true,unread:true},{ok:false,verified:true,unread:false},null]){
  test('unverified receipt retains native state and offers retry: '+JSON.stringify(body),async()=>{
    const h=fixture();h.reply=()=>response(body);assert.equal(await h.ack(),false);
    assert.equal(h.api.isUnread(session),true);assert.equal(h.verified.length,0);assert.equal(typeof h.statuses.at(-1).retry,'function');
    await h.ack();assert.equal(h.calls.length,1,'polling must not repeatedly resume a failed operation');
    h.reply=()=>response();assert.equal(await h.statuses.at(-1).retry(),true);assert.equal(h.calls.length,2);
    assert.deepEqual(h.calls[1].body,h.calls[0].body);
  });
}
for(const field of ['requestId','sessionId','desktopSessionId'])test('rejects receipt for a different '+field,async()=>{
  const h=fixture();h.reply=()=>response({...receipt,[field]:'other'});
  assert.equal(await h.ack(),false);assert.equal(h.verified.length,0);assert.equal(h.api.isUnread(session),true);
});
for(const phase of ['headers','body'])test('timeout during '+phase+' retries only the same operation, and ignores late receipt',async()=>{
  const h=fixture(),pending=deferred();h.reply=()=>phase==='headers'?pending.promise:{ok:true,json:()=>pending.promise};
  const first=h.ack();await turn();h.expire();assert.equal(await first,false);
  assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.api.isUnread(session),true);
  const retry=h.statuses.at(-1).retry;h.reply=()=>response();assert.equal(await retry(),true);
  assert.deepEqual(h.calls[1].body,h.calls[0].body);assert.equal(h.verified.length,1);
  pending.resolve(phase==='headers'?response():receipt);await turn();assert.equal(h.verified.length,1);
});
test('a retry after navigation/preview is suppressed and never retargets another session',async()=>{
  const h=fixture();h.reply=()=>{throw Error('offline');};await h.ack();
  const retry=h.statuses.at(-1).retry;h.setVisible(false);assert.equal(await retry(),false);assert.equal(h.calls.length,1);
  h.setVisible(true);assert.equal(await h.ack({...marker,id:'resumed-other-cli'}),false);assert.equal(h.calls.length,1);
});
test('transport/JSON/callback failures do not produce unhandled rejections',async()=>{
  const h=fixture();h.reply=()=>({ok:true,json:async()=>{throw Error('bad JSON');}});
  assert.equal(await h.ack(marker,undefined,undefined,{onStatus:async()=>{throw Error('UI callback failure');}}),false);
  h.reply=()=>response();assert.equal(await h.ack({...marker,unreadVersion:'next' },undefined,undefined,{onVerified:async()=>{throw Error('refresh failed');},onStatus:()=>{throw Error('status failed');}}),true);
  await turn();assert.equal(h.api.isUnread(session),true);
});

test('reload after a lost response reuses the original requestId without persisting read state',async()=>{
  const h=fixture();h.reply=()=>{throw Error('response lost');};await h.ack();
  const reloaded=fixture(h.storage);assert.equal(await reloaded.ack(),true);
  assert.deepEqual(reloaded.calls[0].body,h.calls[0].body);assert.equal(reloaded.uuidCount(),0);
  assert.equal(reloaded.api.isUnread(session),true);
  assert.ok([...h.storage.values()].every(value=>/^[0-9a-f-]{36}$/.test(value)),'storage contains operation UUIDs only');
});

test('202 automatically rechecks to verified 200 using exactly the original request body',async()=>{
  const h=fixture();h.reply=accepted;assert.equal(await h.ack(),false);assert.equal(h.verified.length,0);
  h.reply=()=>response();assert.equal(h.check(),true);await turn();
  assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].body,h.calls[0].body);assert.equal(h.verified.length,1);assert.equal(h.timers.size,0);
});
test('native false at a later revision confirms the pending operation instead of just clearing status',async()=>{
  const h=fixture();h.reply=accepted;await h.ack();h.reply=()=>response();
  assert.equal(await h.ack({...marker,unread:false,unreadVersion:'reply-a:reply:2666'}),true);
  assert.deepEqual(h.calls[1].body,h.calls[0].body);assert.equal(h.uuidCount(),1);assert.equal(h.verified.length,1);
});
test('hidden stops pending timers; reload checks the stored operation only, with no new UUID',async()=>{
  const h=fixture();h.reply=accepted;await h.ack();h.hide();assert.equal(h.timers.size,0);assert.equal(h.check(),false);
  const reloaded=fixture(h.storage);assert.equal(await reloaded.ack({...marker,unread:false,unreadVersion:'reply-a:reply:2666'}),true);
  assert.deepEqual(reloaded.calls[0].body,h.calls[0].body);assert.equal(reloaded.uuidCount(),0);assert.equal(reloaded.verified.length,1);
  assert.ok([...h.storage.values()].every(value=>/^[0-9a-f-]{36}$/.test(value)),'confirmed operation is removed, no read mask stored');
});
test('pending checks stop after three automatic attempts, repeated polls cannot loop them',async()=>{
  const h=fixture();h.reply=accepted;await h.ack();
  for(let i=0;i<3;i++){assert.equal(h.check(),true);await turn();}
  assert.equal(h.calls.length,4);assert.equal(h.timers.size,0);
  for(let i=0;i<8;i++)await h.ack();assert.equal(h.calls.length,4);assert.equal(h.check(),false);assert.match(h.statuses.at(-1).text,/点击重试/);
  h.reply=()=>response();assert.equal(await h.statuses.at(-1).retry(),true);assert.equal(h.calls.length,5);assert.deepEqual(h.calls[4].body,h.calls[0].body);
});
test('a failed automatic check does not recursively retry errors or lose the original ID',async()=>{
  const h=fixture();h.reply=accepted;await h.ack();h.reply=()=>{throw Error('offline');};h.check();await turn();
  assert.equal(h.calls.length,2);assert.equal(h.timers.size,0);await h.ack();assert.equal(h.calls.length,2);assert.match(h.statuses.at(-1).text,/offline/);
  h.reply=()=>response();await h.statuses.at(-1).retry();assert.deepEqual(h.calls[2].body,h.calls[0].body);
});
for(const version of ['reply-b:reply:2670','reply-a:manual:2670','reply-a:manual:2671'])test('a new reply/manual generation retires old pending and can ACK '+version,async()=>{
  const h=fixture(),old={...marker,unreadVersion:version.endsWith('2671')?'reply-a:manual:2660':'reply-a:reply:2660'};
  h.reply=accepted;await h.ack(old);h.reply=()=>response();
  const next={...old,replyId:version.startsWith('reply-b')?'reply-b':'reply-a',unreadVersion:version};
  assert.equal(await h.ack(next,new Set([next.replyId])),true);assert.equal(h.calls.length,2);assert.notEqual(h.calls[0].body.requestId,h.calls[1].body.requestId);assert.equal(h.calls[1].body.unreadVersion,version);assert.equal(h.timers.size,0);
});
test('a superseded in-flight 202 cannot resurrect old pending or block the newer reply',async()=>{
  const h=fixture(),old={...marker,unreadVersion:'reply-a:reply:2660'},pending=deferred();h.reply=accepted;await h.ack(old);
  h.reply=()=>pending.promise;h.check();await turn();h.reply=()=>response();
  assert.equal(await h.ack({...old,replyId:'reply-b',unreadVersion:'reply-b:reply:2670'},new Set(['reply-b'])),true);
  pending.resolve(accepted());await turn();assert.equal(h.timers.size,0);assert.equal(h.verified.length,1);
  const calls=h.calls.length;await h.ack({...old,replyId:'reply-b',unreadVersion:'reply-b:reply:2670'},new Set(['reply-b']));assert.equal(h.calls.length,calls);
});
test('server generation conflict retires pending so the next fully loaded marker is not blocked',async()=>{
  const h=fixture(),old={...marker,unreadVersion:'reply-a:reply:2660'};h.reply=accepted;await h.ack(old);
  h.reply=()=>response({code:'READ_STATE_CHANGED',error:'changed'},false,409);h.check();await turn();h.reply=()=>response();
  assert.equal(await h.ack({...old,unreadVersion:'reply-a:reply:2670'}),true);assert.equal(h.calls.length,3);assert.notEqual(h.calls[2].body.requestId,h.calls[0].body.requestId);
});
