import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DesktopBridge, applyDesktopPatches, desktopHistory, encodeDesktopFrame, trimIdleDesktopSubscriptions, forkThreadAtTurn } from '../desktop-bridge.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixtureState() {
  return { id:'test-thread',title:'Testing',cwd:'/tmp',latestModel:'test-model',latestReasoningEffort:'high',requests:[],currentPermissions:{approvalPolicy:'on-request',sandboxPolicy:{type:'workspaceWrite'}},turns:[],threadRuntimeStatus:{type:'idle'},turnHistory:{kind:'canonical',history:{islands:[{entries:[{key:'entry',value:'entry'}]}],entitiesByKey:{entry:{turnId:'prior-turn',status:'completed',params:{input:[{type:'text',text:'Hello'}]},turnStartedAtMs:1000,durationMs:100,items:[{type:'agentMessage',id:'message',text:'Prior reply'}]}}}} };
}
async function mock(t,{missingOwner=false,holdSend=false,startError=false,materializeOnError=false,emptySendReply=false,steerReply={result:{turnId:'new-turn'}}}={}) {
  const directory=await mkdtemp(join(tmpdir(),'codex-desktop-test-'));await chmod(directory,0o700);
  const socketPath=join(directory,'ipc.sock'),sockets=new Set(),messages=[];let state=fixtureState(),client;
  const write=(s,message,fragment=false)=>{const bytes=encodeDesktopFrame(message);if(fragment){s.write(bytes.subarray(0,3));s.write(bytes.subarray(3,9));s.write(bytes.subarray(9));}else s.write(bytes);};
  const response=(s,r,result)=>write(s,{type:'response',requestId:r.requestId,resultType:'success',method:r.method,handledByClientId:'desktop-owner',result});
  const snapshot=s=>write(s,{type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'desktop-owner',params:{hostId:'local',conversationId:'test-thread',change:{type:'snapshot',revision:1,conversationState:state}}},true);
  const server=net.createServer(s=>{client=s;sockets.add(s);let buffer=Buffer.alloc(0);s.on('close',()=>sockets.delete(s));s.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4){const size=buffer.readUInt32LE();if(buffer.length<size+4)return;const r=JSON.parse(buffer.subarray(4,size+4).toString());buffer=buffer.subarray(size+4);messages.push(r);
    if(r.type==='request') {
      if(r.method==='initialize')response(s,r,{clientId:'test-client'});
      else if(r.method==='thread-owner-discovery')missingOwner?write(s,{type:'response',requestId:r.requestId,resultType:'error',error:'no-client-found'}):response(s,r,{supportsUntrustedAppInput:true});
      else if(r.method==='thread-follower-read-model-settings')response(s,r,{settings:{model:'test-model'}});
      else if(r.method==='thread-follower-start-turn'){
        if(materializeOnError){const request=r.params.turnStart.request;state.turnHistory.history.islands[0].entries.push({key:'accepted',value:'accepted'});state.turnHistory.history.entitiesByKey.accepted={turnId:'accepted-native-turn',status:'completed',params:{input:request.input,clientUserMessageId:request.clientUserMessageId},items:[{id:'allocated-user-message',type:'userMessage',content:request.input},{id:'native-reply',type:'agentMessage',text:'fixture reply'}]};}
        if(startError)write(s,{type:'response',requestId:r.requestId,resultType:'error',error:'fixture UI follow-up failed after native handling'});
        else if(emptySendReply)response(s,r,{});
        else if(!holdSend)response(s,r,{result:{turn:{id:'new-turn',status:'inProgress',items:[]}}});
      }
      else if(r.method==='thread-follower-steer-turn')response(s,r,steerReply);
      else if(r.method==='thread-follower-compact-thread'||r.method==='thread-follower-edit-last-user-turn')response(s,r,{ok:true});
      else if(r.method==='thread-follower-interrupt-turn')response(s,r,{ok:true,interruptedTurnId:r.params.expectedTurnId});
      else if(r.method.includes('approval')||r.method.includes('submit-user-input'))response(s,r,{ok:true});
    }else if(r.type==='broadcast'&&r.method==='thread-stream-following-changed'&&r.params.following)snapshot(s);
  }});});
  server.listen(socketPath);await once(server,'listening');await chmod(socketPath,0o600);
  const bridge=new DesktopBridge({socketPath,requestTimeoutMs:300,snapshotTimeoutMs:200,snapshotThrottleMs:5,reconnectDelayMs:10000});
  t.after(async()=>{bridge.stop();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});
  return {bridge,messages,directory,socketPath,get state(){return state;},set state(v){state=v;},push:message=>write(client,message),disconnect:()=>client.destroy()};
}

test('canonical desktop turns project input and visible items into app-server shape',()=>{
  const state=fixtureState(),turn=state.turnHistory.history.entitiesByKey.entry;
  turn.items.push({type:'steeringUserMessage',id:'s',serverUserMessageId:'u',status:'accepted',input:[{type:'text',text:'follow up'}]},{type:'userMessage',id:'u',content:[{type:'text',text:'follow up'}]},{type:'subAgentActivity',id:'agent',kind:'started',agentThreadId:'child'});
  const h=desktopHistory(state);assert.equal(h.turns[0].id,'prior-turn');assert.equal(h.turns[0].items.filter(i=>i.type==='userMessage').length,1);assert.equal(h.turns[0].items.at(-1).type,'collabAgentToolCall');assert.equal(h.settings.sandbox,'workspace-write');assert.equal(h.turns[0].durationMs,100);
});

test('native initial request IDs survive normalization without being assigned to steering or other user messages',()=>{
  const state=fixtureState(),turn=state.turnHistory.history.entitiesByKey.entry;turn.params.clientUserMessageId='initial-request';
  turn.items=[{type:'steeringUserMessage',id:'steer-client',serverUserMessageId:'steer-server',status:'accepted',input:[{type:'text',text:'steer'}]},{type:'userMessage',id:'steer-server',content:[{type:'text',text:'steer'}]},{type:'userMessage',id:'initial-native',content:turn.params.input},{type:'userMessage',id:'other-native',content:[{type:'text',text:'other'}]}];
  const items=desktopHistory(state).turns[0].items;
  assert.equal(items.find(item=>item.id==='initial-native').clientUserMessageId,'initial-request');
  assert.equal(items.find(item=>item.id==='steer-server').clientUserMessageId,undefined);
  assert.equal(items.find(item=>item.id==='other-native').clientUserMessageId,undefined);
  assert.equal(items.filter(item=>item.clientUserMessageId==='initial-request').length,1);
  assert.equal(turn.items.find(item=>item.id==='initial-native').clientUserMessageId,undefined);
});

test('an initial input absent from native items remains separate from a steering message',()=>{
  const state=fixtureState(),turn=state.turnHistory.history.entitiesByKey.entry;turn.params.clientUserMessageId='initial-request';turn.items=[{type:'steeringUserMessage',id:'steer-client',serverUserMessageId:'steer-server',status:'accepted',input:[{type:'text',text:'steer'}]}];
  const items=desktopHistory(state).turns[0].items;assert.equal(items[0].clientUserMessageId,'initial-request');assert.equal(items[0].content[0].text,'Hello');assert.equal(items[1].id,'steer-server');assert.equal(items[1].clientUserMessageId,undefined);
});

test('native diff keeps the exact raw turn identity, including an empty newer diff',()=>{
  const state=fixtureState(),history=state.turnHistory.history;
  history.entitiesByKey.entry.diff='diff --git a/a.txt b/a.txt\n';
  assert.deepEqual(desktopHistory(state).turnDiff,{turnId:'prior-turn',diff:'diff --git a/a.txt b/a.txt\n'});
  history.islands[0].entries.push({key:'newer',value:'newer'});
  history.entitiesByKey.newer={turnId:'newer-turn',status:'inProgress',items:[],diff:''};
  assert.deepEqual(desktopHistory(state).turnDiff,{turnId:'newer-turn',diff:''});
  assert.equal(desktopHistory(state).diff,'');
  delete history.entitiesByKey.entry.turnId;delete history.entitiesByKey.newer.turnId;
  assert.equal(desktopHistory(state).turnDiff,null);
  assert.equal(desktopHistory(state).diff,null);
});

test('Immer patch application handles arrays and rejects prototype or stale paths',()=>{
  const state={values:['a'],nested:{text:'old'}};
  applyDesktopPatches(state,[{op:'add',path:['values',1],value:'b'},{op:'replace',path:['nested','text'],value:'new'},{op:'remove',path:['values',0]}]);
  assert.deepEqual(state,{values:['b'],nested:{text:'new'}});
  assert.throws(()=>applyDesktopPatches(state,[{op:'add',path:['__proto__','polluted'],value:true}]));assert.equal({}.polluted,undefined);
  assert.throws(()=>applyDesktopPatches(state,[{op:'replace',path:['missing','text'],value:'x'}]));
});

test('official coordinator handshake, owner lookup and fragmented snapshot normalize correctly',async t=>{
  const {bridge,messages}=await mock(t);await bridge.start();assert.equal(await bridge.owner('test-thread'),'desktop-owner');
  const history=await bridge.history('test-thread');assert.equal(history.turns.length,1);assert.equal(history.turns[0].items[0].type,'userMessage');assert.equal(history.turns[0].items[1].text,'Prior reply');assert.equal(history.desktop,true);
  assert.equal(messages[0].params.clientType,'codex-mobile');assert.equal(messages.find(m=>m.method==='thread-owner-discovery').version,1);assert.equal((await bridge.modelSettings('test-thread')).model,'test-model');
});

test('verified restore notifications use the real client identity and never claim an owner or send a turn',async t=>{
  const {bridge,messages}=await mock(t),threadId='01a16fbe-cb37-7600-b52b-dd2d231dbbb2';
  bridge.noOwners.set(threadId,Date.now());assert.deepEqual(await bridge.notifyUnarchived(threadId),{notified:true});await delay(5);
  const notification=messages.find(message=>message.method==='thread-unarchived');assert.deepEqual(notification,{type:'broadcast',method:'thread-unarchived',sourceClientId:'test-client',version:1,params:{hostId:'local',conversationId:threadId}});
  assert.equal(bridge.noOwners.has(threadId),false);assert.equal(bridge.owners.has(threadId),false);assert.equal(bridge.states.has(threadId),false);assert.equal(messages.some(message=>message.method==='thread-follower-start-turn'),false);await assert.rejects(bridge.notifyUnarchived(threadId+'?prompt=send'));
});

test('desktop send forwards existing thread context, model and effort and deduplicates requestId',async t=>{
  const {bridge,messages}=await mock(t);const options={requestId:'phone-request',input:[{type:'text',text:'Test'}],model:'selected-model',effort:'high'};
  const result=await bridge.send('test-thread',options);assert.equal(result.turn.id,'new-turn');await bridge.send('test-thread',options);
  const sends=messages.filter(m=>m.method==='thread-follower-start-turn');assert.equal(sends.length,1);assert.equal(sends[0].version,2);assert.equal(sends[0].targetClientId,'desktop-owner');assert.deepEqual(sends[0].params.turnStart,{request:{threadId:'test-thread',input:[{type:'text',text:'Test',text_elements:[]}],clientUserMessageId:'phone-request',model:'selected-model',effort:'high'},context:{inheritThreadSettings:true}});
});

test('strict send refreshes stale idle cache and refuses an active native turn without invoking start-turn',async t=>{
  const f=await mock(t);await f.bridge.history('test-thread');
  f.state.turnHistory.history.entitiesByKey.entry.status='inProgress';
  await assert.rejects(f.bridge.send('test-thread',{requestId:'strict-busy',input:[{type:'text',text:'fixture'}],delivery:'startNow'}),{code:'SESSION_BUSY',statusCode:409,sent:false});
  assert.equal(f.messages.filter(m=>m.method==='thread-follower-start-turn').length,0);
});

test('strict idle send forwards selected model and effort, and replays the accepted native receipt when the turn becomes busy',async t=>{
  const f=await mock(t),options={requestId:'strict-once',input:[{type:'text',text:'fixture'}],delivery:'startNow',model:'chosen-model',effort:'low'};
  const accepted=await f.bridge.send('test-thread',options);assert.equal(accepted.turn.id,'new-turn');
  f.state.turnHistory.history.entitiesByKey.entry.status='inProgress';
  assert.deepEqual(await f.bridge.send('test-thread',options),accepted);
  const requests=f.messages.filter(m=>m.method==='thread-follower-start-turn');assert.equal(requests.length,1);
  assert.equal(requests[0].params.turnStart.request.model,'chosen-model');assert.equal(requests[0].params.turnStart.request.effort,'low');
  assert.equal('delivery' in requests[0].params.turnStart.request,false);
});

test('post-acceptance follower failure recovers only the exact real native turn without sending twice',async t=>{
  const f=await mock(t,{startError:true,materializeOnError:true}),options={requestId:'exact-start-request',input:[{type:'text',text:'fixture'}],delivery:'startNow'};
  const result=await f.bridge.send('test-thread',options);assert.equal(result.turn.id,'accepted-native-turn');assert.equal(result.turn.status,'completed');assert.equal(result.turn.items[0].id,'allocated-user-message');assert.equal(result.turn.items[0].clientUserMessageId,options.requestId);
  assert.deepEqual(await f.bridge.send('test-thread',options),result);assert.equal(f.messages.filter(message=>message.method==='thread-follower-start-turn').length,1);
});

test('a missing follower turn receipt can be confirmed by a fresh exact native snapshot',async t=>{
  const f=await mock(t,{emptySendReply:true,materializeOnError:true});const result=await f.bridge.send('test-thread',{requestId:'missing-ack',input:[{type:'text',text:'fixture'}]});assert.equal(result.turn.id,'accepted-native-turn');assert.equal(f.messages.filter(message=>message.method==='thread-follower-start-turn').length,1);
});

test('an existing exact native request replays after bridge recreation without invoking start-turn',async t=>{
  const f=await mock(t),turn=f.state.turnHistory.history.entitiesByKey.entry;turn.params.clientUserMessageId='already-accepted';turn.items.unshift({type:'userMessage',id:'native-user-id',content:turn.params.input});
  const result=await f.bridge.send('test-thread',{requestId:'already-accepted',input:turn.params.input,delivery:'startNow'});assert.equal(result.turn.id,'prior-turn');assert.equal(result.turn.items[0].clientUserMessageId,'already-accepted');assert.equal(f.messages.filter(message=>message.method==='thread-follower-start-turn').length,0);
});

test('same text with a different native request ID is not proof; a delayed result stays unknown without resending',async t=>{
  const f=await mock(t,{startError:true}),turn=f.state.turnHistory.history.entitiesByKey.entry;turn.params.clientUserMessageId='other-request';const options={requestId:'delayed-request',input:turn.params.input};
  await assert.rejects(f.bridge.send('test-thread',options),error=>error.code==='DESKTOP_REQUEST_FAILED'&&error.outcomeUnknown===true);
  turn.params.clientUserMessageId=options.requestId;turn.items.unshift({type:'userMessage',id:'native-delayed-user',content:turn.params.input});
  const updated=desktopHistory(await f.bridge.snapshot('test-thread',{fresh:true}));assert.equal(updated.turns[0].items[0].clientUserMessageId,options.requestId);
  await assert.rejects(f.bridge.send('test-thread',options),error=>error.outcomeUnknown===true);assert.equal(f.messages.filter(message=>message.method==='thread-follower-start-turn').length,1);
});

test('ambiguous or not-yet-native request records block a new start instead of guessing success',async t=>{
  const f=await mock(t),turn=f.state.turnHistory.history.entitiesByKey.entry;turn.params.clientUserMessageId='ambiguous';f.state.turnHistory.history.islands[0].entries.push({key:'second',value:'second'});f.state.turnHistory.history.entitiesByKey.second={...structuredClone(turn),turnId:'another-turn'};
  await assert.rejects(f.bridge.send('test-thread',{requestId:'ambiguous',input:turn.params.input}),error=>error.outcomeUnknown===true);
  delete f.state.turnHistory.history.entitiesByKey.second;f.state.turnHistory.history.islands[0].entries.pop();turn.params.clientUserMessageId='pending-id';turn.status='pending';delete turn.turnId;
  await assert.rejects(f.bridge.send('test-thread',{requestId:'pending-id',input:turn.params.input,delivery:'startNow'}),error=>error.outcomeUnknown===true);assert.equal(f.messages.filter(message=>message.method==='thread-follower-start-turn').length,0);
});

test('live patches emit canonical snapshot and turn lifecycle; stale revision requests a snapshot',async t=>{
  const f=await mock(t);const events=[];f.bridge.on('event',e=>events.push(e));await f.bridge.history('test-thread');await delay(10);
  f.push({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'desktop-owner',params:{hostId:'local',conversationId:'test-thread',change:{type:'patches',baseRevision:1,revision:2,patches:[{op:'replace',path:['turnHistory','history','entitiesByKey','entry','status'],value:'inProgress'}]}}});await delay(15);
  assert.equal(events.findLast(e=>e.method==='bridge/desktopSnapshot').params.history.activeTurn,'prior-turn');assert.ok(events.some(e=>e.method==='turn/started'));
  f.push({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'desktop-owner',params:{hostId:'local',conversationId:'test-thread',change:{type:'patches',baseRevision:2,revision:3,patches:[{op:'replace',path:['turnHistory','history','entitiesByKey','entry','status'],value:'completed'}]}}});await delay(15);assert.ok(events.some(e=>e.method==='turn/completed'));
  f.push({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'desktop-owner',params:{hostId:'local',conversationId:'test-thread',change:{type:'patches',baseRevision:0,revision:4,patches:[]}}});await delay(15);assert.equal(f.messages.filter(m=>m.method==='thread-stream-following-changed'&&m.params.following).length,2);
});

test('approval and interrupt target the desktop owner and preserve numeric native request ids',async t=>{
  const f=await mock(t);f.state.requests=[{id:12,method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',turnId:'prior-turn',command:'pwd'}}];
  const h=await f.bridge.history('test-thread');assert.equal(h.approvals[0].id,'desktop:12');assert.equal(h.approvals[0].method,'item/commandExecution/requestApproval');
  await f.bridge.approval('test-thread','desktop:12',{decision:'decline'});await f.bridge.interrupt('test-thread','prior-turn');
  const approval=f.messages.find(m=>m.method==='thread-follower-command-approval-decision');assert.equal(approval.params.requestId,12);assert.equal(approval.params.decision,'decline');
  const stop=f.messages.find(m=>m.method==='thread-follower-interrupt-turn');assert.equal(stop.version,4);assert.equal(stop.params.expectedTurnId,'prior-turn');assert.equal(stop.params.mode,'user-stop');
});

test('unowned threads use a short negative cache without attempting a new writer',async t=>{
  const f=await mock(t,{missingOwner:true});assert.equal(await f.bridge.owner('test-thread'),null);assert.equal(await f.bridge.owner('test-thread'),null);assert.equal(f.messages.filter(m=>m.method==='thread-owner-discovery').length,1);assert.equal(await f.bridge.history('test-thread'),null);
});

test('unknown send outcome is not replayed after socket loss',async t=>{
  const f=await mock(t,{holdSend:true});const options={input:[{type:'text',text:'Test'}],requestId:'uncertain'};const send=f.bridge.send('test-thread',options);while(!f.messages.some(m=>m.method==='thread-follower-start-turn'))await delay(2);f.disconnect();await assert.rejects(send,e=>e.outcomeUnknown===true);await assert.rejects(f.bridge.send('test-thread',options),e=>e.outcomeUnknown===true);assert.equal(f.messages.filter(m=>m.method==='thread-follower-start-turn').length,1);
});

test('symlinked coordinator endpoints are rejected',async t=>{
  const f=await mock(t);const link=join(f.directory,'alias.sock');await symlink(f.socketPath,link);const bridge=new DesktopBridge({socketPath:link});t.after(()=>bridge.stop());await assert.rejects(bridge.start(),e=>e.code==='DESKTOP_UNAVAILABLE');
});

test('steer supplies native text elements and restorable composer context',async t=>{
  const f=await mock(t);f.state.turnHistory.history.entitiesByKey.entry.status='inProgress';
  const result=await f.bridge.steer('test-thread',{requestId:'steer-request',input:[{type:'text',text:'change direction'}]});assert.equal(result.turnId,'new-turn');
  const request=f.messages.find(m=>m.method==='thread-follower-steer-turn');assert.deepEqual(request.params.input[0].text_elements,[]);assert.deepEqual(request.params.restoreMessage.context.workspaceRoots,['/tmp']);assert.deepEqual(request.params.restoreMessage.context.commentAttachments,[]);
});

test('steer preserves image input and deduplicates the native receipt by requestId',async t=>{
  const f=await mock(t);f.state.turnHistory.history.entitiesByKey.entry.status='inProgress';
  const input=[{type:'text',text:'inspect image'},{type:'image',url:'data:image/png;base64,fixture'},{type:'localImage',path:'/tmp/fixture.png'}],options={requestId:'image-steer',input};
  const results=await Promise.all([f.bridge.steer('test-thread',options),f.bridge.steer('test-thread',options)]);
  assert.deepEqual(results,[{turnId:'new-turn'},{turnId:'new-turn'}]);
  const requests=f.messages.filter(m=>m.method==='thread-follower-steer-turn');assert.equal(requests.length,1);
  assert.deepEqual(requests[0].params.input.slice(1),input.slice(1));assert.equal(requests[0].params.clientUserMessageId,options.requestId);
});

test('steer never fabricates acceptance from the active turn when its receipt is missing or malformed',async t=>{
  for(const steerReply of [{},{result:{}},{result:{turnId:''}},{result:{turnId:42}},{result:{turn:{}}}]){
    const f=await mock(t,{steerReply});f.state.turnHistory.history.entitiesByKey.entry.status='inProgress';
    const options={requestId:'missing-steer-receipt',input:[{type:'text',text:'change direction'}]};
    await assert.rejects(f.bridge.steer('test-thread',options),{code:'DESKTOP_PROTOCOL',outcomeUnknown:true});
    await assert.rejects(f.bridge.steer('test-thread',options),{code:'DESKTOP_PROTOCOL',outcomeUnknown:true});
    assert.equal(f.messages.filter(m=>m.method==='thread-follower-steer-turn').length,1);
  }
});

test('coordinator reconnect reinitializes and resubscribes without replaying requests',async t=>{
  const f=await mock(t);f.bridge.reconnectDelayMs=5;await f.bridge.history('test-thread');f.disconnect();
  const deadline=Date.now()+500;while(Date.now()<deadline&&f.messages.filter(m=>m.method==='initialize').length<2)await delay(5);
  await f.bridge.start();const h=await f.bridge.history('test-thread');assert.equal(h.thread.id,'test-thread');assert.equal(f.messages.filter(m=>m.method==='initialize').length,2);assert.equal(f.messages.filter(m=>m.method==='thread-follower-start-turn').length,0);
});

test('unfollow sends the official stop-following frame and releases idle cached state',async t=>{
  const f=await mock(t);await f.bridge.history('test-thread');f.bridge.unfollow('test-thread');await delay(10);
  assert.ok(f.messages.some(m=>m.method==='thread-stream-following-changed'&&m.params.following===false));
  assert.equal(f.bridge.followed.has('test-thread'),false);assert.equal(f.bridge.states.has('test-thread'),false);assert.equal(f.bridge.owners.has('test-thread'),false);assert.equal(f.bridge.emitTimers.has('test-thread'),false);
  f.push({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'desktop-owner',params:{hostId:'local',conversationId:'test-thread',change:{type:'snapshot',revision:2,conversationState:f.state}}});await delay(10);assert.equal(f.bridge.states.has('test-thread'),false);
  assert.equal((await f.bridge.history('test-thread')).thread.id,'test-thread');
});

test('idle subscription trimming keeps the latest 24 idle views and protects active or queued tasks',()=>{
  const access=new Map([['active',0],['queued',1],...Array.from({length:30},(_,i)=>['idle-'+i,i+2])]);
  access.delete('idle-0');access.set('idle-0',100);const released=[];
  trimIdleDesktopSubscriptions(access,id=>id==='active'||id==='queued',id=>released.push(id));
  assert.equal(access.size,26);assert.equal(access.has('active'),true);assert.equal(access.has('queued'),true);assert.equal(access.has('idle-0'),true);
  assert.deepEqual(released,['idle-1','idle-2','idle-3','idle-4','idle-5','idle-6']);
});

test('an owner disconnect marks only its followed thread unavailable and a new client can restore following',async t=>{
  const f=await mock(t);const events=[];f.bridge.on('event',e=>events.push(e));await f.bridge.history('test-thread');
  f.push({type:'broadcast',method:'client-status-changed',params:{clientId:'desktop-owner',status:'disconnected'}});await delay(10);
  assert.ok(events.some(e=>e.method==='bridge/desktopOffline'&&e.params.threadId==='test-thread'));assert.equal(f.bridge.states.has('test-thread'),false);assert.equal(f.bridge.online,true);
  f.push({type:'broadcast',method:'client-status-changed',params:{clientId:'desktop-owner',status:'connected'}});await delay(15);
  assert.equal(f.bridge.states.has('test-thread'),true);assert.equal(f.messages.filter(m=>m.method==='thread-stream-following-changed'&&m.params.following).length,2);
});


test('compact uses the official owner topic/version and does not replay a request id',async t=>{
  const f=await mock(t);assert.deepEqual(await f.bridge.compact('test-thread',{requestId:'compact-one'}),{ok:true});await f.bridge.compact('test-thread',{requestId:'compact-one'});
  const requests=f.messages.filter(m=>m.method==='thread-follower-compact-thread');assert.equal(requests.length,1);assert.equal(requests[0].version,1);assert.equal(requests[0].targetClientId,'desktop-owner');assert.deepEqual(requests[0].params,{conversationId:'test-thread'});
});
test('edit targets the exact turn and requires explicit permission before replacing later history',async t=>{
  const f=await mock(t);f.state.turnHistory.history.islands[0].entries.push({key:'second',value:'second'});f.state.turnHistory.history.entitiesByKey.second={turnId:'later-turn',status:'completed',params:{input:[{type:'text',text:'Later'}]},items:[]};
  await assert.rejects(f.bridge.editUserTurn('test-thread',{turnId:'prior-turn',message:'Changed'}),/后续对话/);assert.equal(f.messages.some(m=>m.method==='thread-follower-edit-last-user-turn'),false);
  assert.deepEqual(await f.bridge.editUserTurn('test-thread',{turnId:'prior-turn',message:'Changed',allowEarlierMessages:true,requestId:'edit-one'}),{ok:true});await f.bridge.editUserTurn('test-thread',{turnId:'prior-turn',message:'Changed',allowEarlierMessages:true,requestId:'edit-one'});
  const requests=f.messages.filter(m=>m.method==='thread-follower-edit-last-user-turn');assert.equal(requests.length,1);assert.equal(requests[0].version,2);assert.deepEqual(requests[0].params,{conversationId:'test-thread',turnId:'prior-turn',message:'Changed',allowEarlierMessages:true});
});
test('edit refuses unloaded turn boundaries and running target turns before writing',async t=>{
  const f=await mock(t);await assert.rejects(f.bridge.editUserTurn('test-thread',{turnId:'missing',message:'Changed'}),e=>e.code==='DESKTOP_TURN_NOT_FOUND');f.state.turnHistory.history.entitiesByKey.entry.status='inProgress';f.bridge.states.clear();
  await assert.rejects(f.bridge.editUserTurn('test-thread',{turnId:'prior-turn',message:'Changed'}),/正在运行/);assert.equal(f.messages.some(m=>m.method==='thread-follower-edit-last-user-turn'),false);
});
test('specific-turn fork sends an inclusive or exclusive boundary and never silently forks latest',async()=>{
  const calls=[],core={async call(method,params){calls.push({method,params});return{thread:{id:'forked'}}}};
  await assert.rejects(forkThreadAtTurn(core,'source',{}),/明确/);assert.equal(calls.length,0);
  await forkThreadAtTurn(core,'source',{turnId:'first'});await forkThreadAtTurn(core,'source',{turnId:'second',before:true});
  assert.deepEqual(calls[0],{method:'thread/fork',params:{threadId:'source',lastTurnId:'first',ephemeral:false,excludeTurns:false,deferGoalContinuation:true,threadSource:'user'}});assert.equal(calls[1].params.beforeTurnId,'second');assert.equal('lastTurnId' in calls[1].params,false);
});


test('history exposes actual collaboration mode and uses its model and effort settings',()=>{
  const state=fixtureState();state.latestCollaborationMode={mode:'plan',settings:{model:'plan-model',reasoning_effort:'medium',developer_instructions:null}};
  const h=desktopHistory(state);assert.equal(h.settings.mode,'plan');assert.equal(h.settings.model,'plan-model');assert.equal(h.settings.effort,'medium');assert.equal(h.thread.model,'plan-model');
  state.latestCollaborationMode.settings.reasoning_effort=null;assert.equal(desktopHistory(state).settings.effort,null);state.latestCollaborationMode.settings.model='';assert.equal(desktopHistory(state).settings.model,'test-model');
});
