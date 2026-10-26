import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWriteServices} from './index.mjs';
import {ModelSelections} from './model-selections.mjs';
import {CodexWriteClient} from '../write-client.mjs';
import {MessageQueue} from '../../backend/queue.mjs';
import {deliverMessage} from '../../backend/message-delivery.mjs';

const id='00000000-0000-0000-0000-000000000001';
const cmd=(type,payload,commandId)=>({workspacePath:'/workspace',envelope:{commandId,clientId:'phone-test',sessionId:id,type,payload,issuedAt:1}});
async function fixture(t,{post=async()=>({turn:{id:'native-turn'}}),history=()=>({}),resolveAttachment}={}){
 const directory=await mkdtemp(join(tmpdir(),'cm-write-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const modelSelections=new ModelSelections(directory),posts=[];
 const api={async get(path){if(path==='/api/models')return{data:[{model:'native-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]};return{thread:{id,cwd:'/workspace'},turns:[],activeTurn:null,attached:false,...await history(path)};},async post(path,body){posts.push({path,body});return post(path,body);}};
 const options={api,baseServices:{project:{readTree:async()=>({projects:[],tasks:[{taskId:id,workspacePath:'/workspace'}]})}},modelSelections,resolveAttachment,ledgerDir:join(directory,'commands')};
 const service=createWriteServices(options);
 return{agent:service.channels['zcode-agent'],posts,modelSelections,directory,options,service};
}

test('phone text uses automatic delivery with the selected native model and durable choice',async t=>{
 const f=await fixture(t);
 const selection=await f.agent.sendConversationCommandV4(cmd('switchModelConfig',{provider:'codex-app',model:'native-model',thought:'low'},'select-1'));
 assert.equal(selection.status,'accepted');assert.equal(f.posts.length,0);
 assert.equal((await new ModelSelections(f.directory).get('/workspace',id)).effort,'low');
 const send=await f.agent.sendConversationCommandV4(cmd('sendText',{text:'isolated test'},'send-1'));
 assert.equal(send.status,'accepted');assert.equal(send.result.delivery,'startNow');assert.equal(Object.hasOwn(f.posts[0].body,'delivery'),false);
 assert.equal(f.posts[0].body.model,'native-model');assert.equal(f.posts[0].body.effort,'low');
});

test('a definitive busy rejection remains rejected on replay and never repeats POST',async t=>{
 const f=await fixture(t,{post:async()=>{throw Object.assign(Error('正在运行'),{code:'SESSION_BUSY',sent:false});}});
 const input=cmd('sendText',{text:'test busy'},'busy-1');
 const a=await f.agent.sendConversationCommandV4(input),b=await f.agent.sendConversationCommandV4(input);
 assert.equal(a.status,'rejected');assert.equal(a.reasonCode,'SESSION_BUSY');assert.deepEqual(b,a);assert.equal(f.posts.length,1);
});

test('writer never retries a mutation after losing the native response',async()=>{
 let posts=0;
 const api=new CodexWriteClient({fetchImpl:async(url,options)=>{
  if(!options?.method)return new Response(JSON.stringify({localUrl:'http://127.0.0.1:8787/#'+'a'.repeat(43)}));
  posts++;throw Error('connection lost');
 }});
 await assert.rejects(api.post('/api/message',{threadId:id,text:'test',requestId:'test-only',delivery:'startNow'}),e=>e.outcomeUnknown===true);
 assert.equal(posts,1);
 await assert.rejects(api.post('/api/interrupt',{threadId:id}),e=>e.sent===false);
 assert.equal(posts,1);
});

test('original draft queue initialization is acknowledged without sending or enabling guide',async t=>{
 const f=await fixture(t),request=cmd('setFollowupMode',{mode:'queue'},'init-queue-1');request.envelope.baseRevision=0;
 assert.equal((await f.agent.sendConversationCommandV4(request)).status,'accepted');assert.equal(f.posts.length,0);
 await assert.rejects(f.agent.sendConversationCommandV4(cmd('setFollowupMode',{mode:'guide'},'init-guide-1')),e=>e.code==='FOLLOWUP_UNAVAILABLE');
});

test('a new native conversation can send before it appears in the native list',async t=>{
 const f=await fixture(t);
 const api={get:async path=>path==='/api/models'?{data:[]}:{thread:{id,cwd:'/workspace'},turns:[],activeTurn:null,attached:true},post:async(_path,value)=>{f.posts.push(value);return{turn:{id:'first-turn'}};}};
 const service=createWriteServices({api,baseServices:{project:{readTree:async()=>({projects:[{roots:[{rootPath:'/workspace'}]}],tasks:[]})}},ledgerDir:join(f.directory,'fresh-commands')});
 assert.equal((await service.channels['zcode-agent'].sendConversationCommandV4(cmd('sendText',{text:'new native draft'},'fresh-send-1'))).status,'accepted');
 assert.equal(f.posts.length,1);
 });

test('registered projectless workspace can create its first thread, while arbitrary directories cannot',async t=>{
 const f=await fixture(t),posts=[];
 const api={get:async()=>({thread:{id,cwd:'/conversations'},turns:[],attached:true}),post:async(path,body)=>{posts.push({path,body});return{thread:{id},desktop:{attached:true}};}};
 const service=createWriteServices({api,baseServices:{project:{readTree:async()=>({projects:[],tasks:[],conversationWorkspacePath:'/conversations'})}},ledgerDir:join(f.directory,'projectless')});
 const request={workspacePath:'/conversations',envelope:{commandId:'projectless-first',clientId:'phone-test',sessionId:null,type:'createSession',issuedAt:1,payload:{workspaceId:'/conversations',config:{mode:'build'}}}};
 const result=await service.channels['zcode-agent'].sendConversationCommandV4(request);
 assert.equal(result.status,'accepted');assert.equal(result.result.sessionId,id);
 assert.equal(posts.length,1);assert.equal(posts[0].body.cwd,'/conversations');assert.equal(posts[0].body.projectId,undefined);
 assert.deepEqual(await service.channels['zcode-agent'].sendConversationCommandV4(request),result);
 assert.equal(posts.length,1);
 await assert.rejects(service.channels['zcode-agent'].sendConversationCommandV4({...request,workspacePath:'/arbitrary'}),/工作目录不在/);
});

const attachmentId='a'.repeat(48);
const attachment={ref:'/api/attachment?id='+attachmentId,fileName:'phone.png',mime:'image/png',bytes:32};
const queuedReceipt=(body,{paused=false,status='queued',items=true}={})=>{
 const item={id:body.requestId,requestId:body.requestId,text:body.text,attachments:body.attachments||[],createdAt:1,status,error:null};
 return{queued:true,item,queue:{threadId:body.threadId,items:items?[item]:[],paused,error:null}};
};
const queryFor=request=>({workspacePath:request.workspacePath,commands:[{sessionId:request.envelope.sessionId,commandId:request.envelope.commandId}]});

test('running text accepts a stable queue receipt and concurrent replay never enqueues twice',async t=>{
 let changes=0;
 const f=await fixture(t,{history:()=>({activeTurn:'running'}),post:async(_path,body)=>queuedReceipt(body)});
 const service=createWriteServices({...f.options,onChanged:async()=>{changes++;}}),agent=service.channels['zcode-agent'];
 const request=cmd('sendText',{text:'next step',requestedDelivery:'queue'},'queued-1');
 const replies=await Promise.all([agent.sendConversationCommandV4(request),agent.sendConversationCommandV4(request)]);
 assert.ok(replies.every(reply=>reply==='unknown'||reply.result.delivery==='queue'));
 const result=(await agent.queryConversationCommandsV4(queryFor(request))).results[0].result;
 assert.equal(result.status,'accepted');assert.equal(result.result.delivery,'queue');assert.equal(result.result.inputId,f.posts[0].body.requestId);assert.match(result.message,/已加入发送队列/);
 assert.equal(Object.hasOwn(f.posts[0].body,'delivery'),false);assert.equal(f.posts.length,1);assert.ok(changes>0);
 const restarted=createWriteServices(f.options).channels['zcode-agent'];
 assert.deepEqual(await restarted.sendConversationCommandV4(request),result);assert.equal(f.posts.length,1);
 await assert.rejects(restarted.sendConversationCommandV4({...request,envelope:{...request.envelope,payload:{...request.envelope.payload,text:'changed'}}}),e=>e.code==='COMMAND_ID_COLLISION');
});

test('automatic delivery tolerates the idle-to-busy race, paused queues, and an already drained receipt item',async t=>{
 for(const options of [{},{paused:true,status:'failed'},{items:false}]){
  const f=await fixture(t,{post:async(_path,body)=>queuedReceipt(body,options)});
  const result=await f.agent.sendConversationCommandV4(cmd('sendText',{text:'race'},'race'));
  assert.equal(result.result.delivery,'queue');if(options.paused)assert.match(result.message,/暂停/);
  assert.equal(f.posts.length,1);
 }
});

test('lost queue responses reconcile by scoped stable request ID only and never repeat POST',async t=>{
 let receipt,prove=false;
 const f=await fixture(t,{history:()=>({activeTurn:'running',queue:prove?receipt?.queue:{threadId:id,items:[{id:'other',requestId:'other',text:'same',status:'queued'}]}}),post:async(_path,body)=>{receipt=queuedReceipt(body);throw Error('connection lost');}});
 const request=cmd('sendText',{text:'same'},'lost-queue');
 await assert.rejects(f.agent.sendConversationCommandV4(request),e=>e.code==='NATIVE_OUTCOME_UNKNOWN');
 const restarted=createWriteServices(f.options).channels['zcode-agent'];
 assert.equal(await restarted.sendConversationCommandV4(request),'unknown');assert.equal((await restarted.queryConversationCommandsV4(queryFor(request))).results[0].result,'unknown');
 prove=true;const result=(await restarted.queryConversationCommandsV4(queryFor(request))).results[0].result;
 assert.equal(result.result.delivery,'queue');assert.deepEqual(await restarted.sendConversationCommandV4(request),result);assert.equal(f.posts.length,1);
});

test('malformed queue receipts and foreign queue snapshots remain unknown without retry',async t=>{
 for(const corrupt of [r=>({...r,queue:{...r.queue,threadId:'other'}}),r=>({...r,item:null,queue:{...r.queue,items:[]}}),r=>({...r,item:{...r.item,requestId:'other'},queue:{...r.queue,items:[]}})]){
  let receipt;
  const f=await fixture(t,{history:()=>({queue:receipt?.queue}),post:async(_path,body)=>{receipt=corrupt(queuedReceipt(body));return receipt;}});
  const request=cmd('sendText',{text:'unknown'},'malformed');
  await assert.rejects(f.agent.sendConversationCommandV4(request),e=>e.outcomeUnknown===true);
  assert.equal(await f.agent.sendConversationCommandV4(request),'unknown');assert.equal((await f.agent.queryConversationCommandsV4(queryFor(request))).results[0].result,'unknown');assert.equal(f.posts.length,1);
 }
});

test('startNow is forwarded even while busy and cannot accept or reconcile a queue receipt',async t=>{
 let receipt;
 const f=await fixture(t,{history:()=>({activeTurn:'running',queue:receipt?.queue,turns:receipt?[{id:'later',items:[{type:'userMessage',id:receipt.item.requestId}]}]:[]}),post:async(_path,body)=>{receipt=queuedReceipt(body);return receipt;}});
 const request=cmd('sendText',{text:'strict',requestedDelivery:'startNow'},'strict');
 await assert.rejects(f.agent.sendConversationCommandV4(request),e=>e.outcomeUnknown===true);
 assert.equal(f.posts[0].body.delivery,'startNow');assert.equal(await f.agent.sendConversationCommandV4(request),'unknown');
 assert.equal((await f.agent.queryConversationCommandsV4(queryFor(request))).results[0].result,'unknown');assert.equal(f.posts.length,1);
});

test('busy startNow rejection is durable, and explicit queue can race to immediate delivery',async t=>{
 const busy=await fixture(t,{history:()=>({activeTurn:'running'}),post:async(_path,body)=>{assert.equal(body.delivery,'startNow');throw Object.assign(Error('busy'),{sent:false,code:'SESSION_BUSY'});}});
 const request=cmd('sendText',{text:'strict',requestedDelivery:'startNow'},'strict-busy');
 const result=await busy.agent.sendConversationCommandV4(request);assert.equal(result.status,'rejected');assert.deepEqual(await busy.agent.sendConversationCommandV4(request),result);assert.equal(busy.posts.length,1);
 const idle=await fixture(t);assert.equal((await idle.agent.sendConversationCommandV4(cmd('sendText',{text:'finished',requestedDelivery:'queue'},'queue-idle'))).result.delivery,'startNow');
});

test('image-only and mixed attachment inputs resolve metadata in validated scope and send IDs only',async t=>{
 const resolved=[];
 const f=await fixture(t,{resolveAttachment:async params=>{resolved.push(params);return{id:attachmentId,name:'trusted.png',mime:'image/png',size:32};},post:async(_path,body)=>queuedReceipt(body)});
 assert.equal(f.service.capabilities.attachments,true);assert.equal(f.service.capabilities.implicitQueue,true);
 for(const [index,text] of ['', ' explain image '].entries()){
  const request=cmd('sendText',{text,attachments:[attachment]},'image-'+index);
  const result=await f.agent.sendConversationCommandV4(request);assert.equal(result.result.delivery,'queue');
  assert.equal(f.posts[index].body.text,text.trim());assert.deepEqual(f.posts[index].body.attachments,[attachmentId]);assert.equal(f.posts[index].body.files,undefined);
  assert.deepEqual(resolved[index],{workspacePath:'/workspace',sessionId:id,ref:attachment.ref});
  assert.deepEqual(await f.agent.sendConversationCommandV4(request),result);
 }
 assert.equal(resolved.length,2);assert.equal(f.posts.length,2);
});

test('attachments reject paths, URL variants, duplicates, over-limit lists, and missing metadata before POST',async t=>{
 let resolves=0;
 const f=await fixture(t,{resolveAttachment:async()=>{resolves++;return{id:attachmentId};}});
 const invalidRefs=['/tmp/secret.png','file:///tmp/secret.png','https://evil.invalid'+attachment.ref,attachment.ref+'&meta=1',attachment.ref+'#fragment','/api/attachment?id='+attachmentId.toUpperCase(),'/api/attachment?id=%61'+attachmentId.slice(1),attachment.ref+'&id='+attachmentId];
 for(const [index,ref] of invalidRefs.entries())await assert.rejects(f.agent.sendConversationCommandV4(cmd('sendText',{text:'',attachments:[{...attachment,ref}]},'bad-ref-'+index)),e=>e.code==='INVALID_ATTACHMENT');
 for(const attachments of [[attachment,attachment],Array.from({length:7},(_,i)=>({...attachment,ref:'/api/attachment?id='+String(i).repeat(48)}))])await assert.rejects(f.agent.sendConversationCommandV4(cmd('sendText',{text:'',attachments},'bad-list')),e=>e.code==='INVALID_ATTACHMENT');
 await assert.rejects(f.agent.sendConversationCommandV4(cmd('sendText',{text:'   '},'blank')),e=>e.code==='INVALID_INPUT');
 await assert.rejects(f.agent.sendConversationCommandV4({...cmd('sendText',{text:'',attachments:[attachment]},'foreign-workspace'),workspacePath:'/foreign'}),/工作目录不在/);
 assert.equal(resolves,0);assert.equal(f.posts.length,0);
 const missing=await fixture(t);await assert.rejects(missing.agent.sendConversationCommandV4(cmd('sendText',{text:'',attachments:[attachment]},'no-resolver')),e=>e.code==='ATTACHMENT_UNAVAILABLE');assert.equal(missing.posts.length,0);
 const mismatched=await fixture(t,{resolveAttachment:async()=>({id:'b'.repeat(48)})});await assert.rejects(mismatched.agent.sendConversationCommandV4(cmd('sendText',{text:'',attachments:[attachment]},'wrong-meta')),e=>e.code==='INVALID_ATTACHMENT');assert.equal(mismatched.posts.length,0);
});

test('metadata scope rejection and attachment guide never reach native dispatch',async t=>{
 const foreign=await fixture(t,{resolveAttachment:async()=>{throw Object.assign(Error('foreign upload scope'),{code:'ATTACHMENT_SCOPE'});}});
 await assert.rejects(foreign.agent.sendConversationCommandV4(cmd('sendText',{text:'',attachments:[attachment]},'foreign-image')),e=>e.code==='ATTACHMENT_SCOPE');assert.equal(foreign.posts.length,0);
 let steers=0;
 const f=await fixture(t,{resolveAttachment:async()=>({id:attachmentId}),history:()=>({activeTurn:'running'})});
 const service=createWriteServices({...f.options,native:{steerExpected:async()=>{steers++;}}});
 await assert.rejects(service.channels['zcode-agent'].sendConversationCommandV4(cmd('sendText',{text:'',attachments:[attachment],requestedDelivery:'guide'},'guide-image')),e=>e.code==='STEER_UNAVAILABLE');assert.equal(steers,0);assert.equal(f.posts.length,0);
});

test('image-only first input preserves native creation and strict first delivery with durable replay',async t=>{
 const resolved=[];
 const f=await fixture(t,{history:()=>({attached:true}),resolveAttachment:async params=>{resolved.push(params);return{id:attachmentId};},post:async path=>path==='/api/thread'?{thread:{id},desktop:{attached:true}}:{turn:{id:'first'}}});
 const request=cmd('createSession',{workspaceId:'/workspace',firstInput:{text:'',attachments:[attachment]}},'create-image');request.envelope.sessionId=null;
 const result=await f.agent.sendConversationCommandV4(request);
 assert.equal(result.result.sessionId,id);assert.equal(result.result.input.delivery,'startNow');assert.deepEqual(f.posts.map(p=>p.path),['/api/thread','/api/message']);
 assert.equal(f.posts[0].body.initialText,undefined);assert.equal(f.posts[1].body.text,'');assert.deepEqual(f.posts[1].body.attachments,[attachmentId]);assert.equal(f.posts[1].body.delivery,'startNow');
 assert.deepEqual(resolved,[{workspacePath:'/workspace',sessionId:null,ref:attachment.ref}]);assert.deepEqual(await f.agent.sendConversationCommandV4(request),result);assert.equal(f.posts.length,2);
});

test('real backend queue persists one image input after a lost receipt and adapter restart',async t=>{
 let queue,active=true,deliveries=[];
 const f=await fixture(t,{resolveAttachment:async()=>({id:attachmentId}),history:()=>({activeTurn:active?'running':null,queue:queue.get(id)}),post:async(_path,body)=>{
  const result=await deliverMessage(body,{receipt:()=>undefined,prepare:async()=>{},isBusy:()=>active,enqueue:value=>queue.enqueue(value.threadId,value),dispatch:async()=>assert.fail('busy message cannot dispatch')});
  assert.equal(result.queued,true);throw Error('lost queue response');
 }});
 queue=await new MessageQueue({stateDir:join(f.directory,'backend'),isActive:()=>active,send:async body=>{deliveries.push(body);}}).init();
 const request=cmd('sendText',{text:'',attachments:[attachment]},'persisted-image');
 await assert.rejects(f.agent.sendConversationCommandV4(request),e=>e.outcomeUnknown===true);
 assert.equal(queue.get(id).items.length,1);
 const restarted=createWriteServices(f.options).channels['zcode-agent'];
 const result=(await restarted.queryConversationCommandsV4(queryFor(request))).results[0].result;
 assert.equal(result.result.delivery,'queue');assert.equal(result.result.inputId,queue.get(id).items[0].id);
 assert.deepEqual(await restarted.sendConversationCommandV4(request),result);assert.equal(queue.get(id).items.length,1);assert.equal(f.posts.length,1);
 active=false;await queue.drain(id);
 assert.equal(deliveries.length,1);assert.equal(deliveries[0].text,'');assert.deepEqual(deliveries[0].attachments,[attachmentId]);assert.equal(queue.get(id).items.length,0);
 assert.deepEqual(await restarted.sendConversationCommandV4(request),result);assert.equal(f.posts.length,1);
});

test('append auto/queue ignores streamed historical revision while startNow/guide retain the guard',async t=>{
 let guarded=0;
 const f=await fixture(t,{history:()=>({activeTurn:'streaming'}),post:async(_path,body)=>queuedReceipt(body)});
 const agent=createWriteServices({...f.options,revisionGuard:async()=>{guarded++;return false;}}).channels['zcode-agent'];
 for(const delivery of [undefined,'queue','startNow','guide']){
  const request=cmd('sendText',{text:'append',...(delivery?{requestedDelivery:delivery}:{})},'revision-'+(delivery||'auto'));
  Object.assign(request.envelope,{baseRevision:1,baseLogEpoch:'old-stream-snapshot'});
  const result=await agent.sendConversationCommandV4(request);
  if(delivery===undefined||delivery==='queue'){assert.equal(result.status,'accepted');assert.equal(result.result.delivery,'queue');assert.deepEqual(await agent.sendConversationCommandV4(request),result);}
  else assert.equal(result.status,'stale');
 }
 assert.equal(guarded,2);assert.equal(f.posts.length,2);
 const noGuard=cmd('sendText',{text:'append without native revision',requestedDelivery:'queue'},'revision-no-guard');
 noGuard.envelope.baseRevision=1;
 assert.equal((await f.agent.sendConversationCommandV4(noGuard)).result.delivery,'queue');
});

test('queue immediate dispatch uses original item ID and replays without duplicate delivery',async t=>{
 const f=await fixture(t,{history:()=>({queue:{threadId:id,items:[{id:'q-image',requestId:'q-image',attachments:['image-id'],status:'queued'}]}}),post:async()=>({threadId:id,items:[]})});
 const request=cmd('sendQueuedNow',{queueItemId:'q-image'},'immediate-1');request.envelope.baseRevision=999;
 const result=await f.agent.sendConversationCommandV4(request);assert.equal(result.status,'accepted');assert.deepEqual(await f.agent.sendConversationCommandV4(request),result);
 assert.deepEqual(f.posts,[{path:'/api/queue',body:{threadId:id,action:'sendNow',id:'q-image'}}]);
});
test('queue immediate failure remains visible and never reports accepted',async t=>{
 const f=await fixture(t,{history:()=>({queue:{threadId:id,items:[{id:'q1',status:'queued'}]}}),post:async()=>({threadId:id,items:[{id:'q1',status:'failed',error:'native rejected image'}]})});
 const result=await f.agent.sendConversationCommandV4(cmd('sendQueuedNow',{queueItemId:'q1'},'immediate-failure'));
 assert.equal(result.status,'rejected');assert.match(result.message,/native rejected image/);
});
test('queue editing deletion and pause map to scoped backend mutations',async t=>{
 const f=await fixture(t,{history:()=>({queue:{threadId:id,items:[{id:'q1',status:'queued'}]}}),post:async()=>({threadId:id,items:[]})});
 for(const [type,payload] of [['editQueueItem',{queueItemId:'q1',newText:'edited'}],['deleteQueueItem',{queueItemId:'q1'}],['setAutoDrain',{autoDrain:true}]])assert.equal((await f.agent.sendConversationCommandV4(cmd(type,payload,type))).status,'accepted');
 assert.deepEqual(f.posts.map(x=>x.body),[{threadId:id,action:'edit',id:'q1',text:'edited'},{threadId:id,action:'remove',id:'q1'},{threadId:id,action:'resume'}]);
});

test('active mobile send inserts immediately even when the old composer requests queue',async t=>{
 const f=await fixture(t,{history:()=>({activeTurn:'running'}),post:async(path,body)=>path==='/api/queue'?{threadId:id,items:[]}:{queued:true,queue:{threadId:id,items:[{id:body.requestId,requestId:body.requestId,status:'queued'}]}}});
 const agent=createWriteServices({...f.options,autoSteerActive:true}).channels['zcode-agent'];
 const r=cmd('sendText',{text:'follow up'},'one-tap');assert.equal((await agent.sendConversationCommandV4(r)).result.delivery,'guide');assert.deepEqual(f.posts.map(x=>x.path),['/api/message','/api/queue']);await agent.sendConversationCommandV4(r);assert.equal(f.posts.length,2);
 const q=await agent.sendConversationCommandV4(cmd('sendText',{text:'later',requestedDelivery:'queue'},'explicit-later'));assert.equal(q.result.delivery,'guide');assert.equal(f.posts.length,4);
});
test('native acceptance is returned without waiting for slow sidebar and history refresh',async t=>{
 const f=await fixture(t);let release;const refresh=new Promise(r=>release=r);t.after(()=>release());
 const agent=createWriteServices({...f.options,onChanged:()=>refresh}).channels['zcode-agent'];
 const result=await Promise.race([agent.sendConversationCommandV4(cmd('sendText',{text:'quick ack'},'quick-ack')),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('ACK blocked on refresh')),1000);timer.unref();})]);assert.equal(result.status,'accepted');release();
});

for(const activeTurn of [null,'running'])for(const requestedDelivery of [undefined,'queue','guide'])test(`one-tap append bypasses paused queue and stale activity (active=${activeTurn}, delivery=${requestedDelivery})`,async t=>{
 const f=await fixture(t,{history:()=>({activeTurn,queue:{threadId:id,paused:true,items:[]}}),post:async(path,body)=>path==='/api/queue'?{threadId:id,paused:true,items:[]}:queuedReceipt(body,{paused:true})});
 const agent=createWriteServices({...f.options,autoSteerActive:true}).channels['zcode-agent'];
 const request=cmd('sendText',{text:'append',...(requestedDelivery?{requestedDelivery}:{})},'direct');request.envelope.baseRevision=999;
 const result=await agent.sendConversationCommandV4(request);
 assert.equal(result.status,'accepted');assert.equal(result.result.delivery,'guide');
 assert.deepEqual(f.posts.map(x=>x.path),['/api/message','/api/queue']);
 assert.equal(f.posts[1].body.id,f.posts[0].body.requestId);
 await agent.sendConversationCommandV4(request);assert.equal(f.posts.length,2);
});
test('lost one-tap response does not mistake a queued item for delivered input or resend',async t=>{
 let receipt;
 const f=await fixture(t,{history:()=>({activeTurn:'running',queue:receipt?.queue}),post:async(_path,body)=>{receipt=queuedReceipt(body);throw Error('connection lost');}});
 const agent=createWriteServices({...f.options,autoSteerActive:true}).channels['zcode-agent'];
 const request=cmd('sendText',{text:'append'},'lost-direct');
 await assert.rejects(agent.sendConversationCommandV4(request));
 const restarted=createWriteServices({...f.options,autoSteerActive:true}).channels['zcode-agent'];
 assert.equal(await restarted.sendConversationCommandV4(request),'unknown');assert.equal(f.posts.length,1);
});
test('one-tap insertion failure is reported instead of claiming the queued text was delivered',async t=>{
 let receipt;
 const f=await fixture(t,{history:()=>({activeTurn:'running'}),post:async(path,body)=>{if(path==='/api/message')return receipt=queuedReceipt(body);return{threadId:id,items:[{...receipt.item,status:'failed',error:'native insert failed'}]};}});
 const agent=createWriteServices({...f.options,autoSteerActive:true}).channels['zcode-agent'];
 const request=cmd('sendText',{text:'append'},'failed-direct');
 const result=await agent.sendConversationCommandV4(request);assert.equal(result.status,'rejected');assert.match(result.message,/native insert failed/);
 assert.deepEqual(await agent.sendConversationCommandV4(request),result);assert.equal(f.posts.length,2);
});

for(const active of [false,true])test(`one click reaches real queue dispatch without a second command (active=${active})`,async t=>{
 let queue;const delivered=[];
 const f=await fixture(t,{history:()=>({activeTurn:active?'native-running':null,queue:queue.get(id)}),post:async(path,body)=>path==='/api/queue'?queue.handle(body.threadId,body):deliverMessage(body,{receipt:()=>undefined,prepare:async()=>{},isBusy:()=>active||queue.hasPending(id),enqueue:value=>queue.enqueue(id,value),dispatch:async value=>{delivered.push({value,steer:false});return{turn:{id:'next-turn'}};}})});
 queue=await new MessageQueue({stateDir:join(f.directory,'real-queue'),isActive:()=>active,send:async(value,{steer})=>{delivered.push({value,steer});return{turnId:active?'native-running':'next-turn'};}}).init();
 await queue.handle(id,{action:'pause'});
 const agent=createWriteServices({...f.options,autoSteerActive:true}).channels['zcode-agent'];
 const request=cmd('sendText',{text:'one click',requestedDelivery:'queue'},'real-one-click');
 assert.equal((await agent.sendConversationCommandV4(request)).status,'accepted');
 assert.equal(delivered.length,1);assert.equal(delivered[0].steer,active);assert.equal(delivered[0].value.text,'one click');assert.equal(queue.get(id).items.length,0);
 await agent.sendConversationCommandV4(request);assert.equal(delivered.length,1);
});
