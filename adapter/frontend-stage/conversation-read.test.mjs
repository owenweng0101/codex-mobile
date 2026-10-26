import test from 'node:test';import assert from 'node:assert/strict';
import {projectConversationV4,createConversationReadServices} from './conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';
import {k as applyDeltas,w as frameSchema,O as indexFrameSchema} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js';
import {resolveMobileImagePath} from '../mobile-history.mjs';
const id='00000000-0000-0000-0000-000000000001',params={workspacePath:'/authorized',sessionId:id};
const page={thread:{id,cwd:'/authorized',name:'Fixture only',createdAt:1},turns:[{id:'turn1',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'fixture user'}]},{id:'a',type:'agentMessage',text:'fixture answer'},{id:'tool',type:'commandExecution',status:'completed',command:'fixture command',aggregatedOutput:'fixture result'}]}]};
test('writable snapshots use native send routing and reject a revision when native state changes',async()=>{
 const current=structuredClone(page),frames=[];
 const service=createConversationReadServices({writable:true,api:{get:async()=>structuredClone(current)},baseServices:{project:{readTree:async()=>({projects:[],tasks:[{taskId:id,workspacePath:'/authorized'}]})},'zcode-task':{onDynamicTaskEvent:()=>()=>({dispose(){}})}}});
 const agent=service.channels['zcode-agent'];
 const listener=agent.onDynamicConversationFrame(params)(f=>frames.push(f));
 await agent.subscribeConversationV4(params);
 const snapshot=frames[0].frame.payload.snapshot;
 assert.equal(snapshot.inputRouting.mode,'startNow');
 assert.equal(snapshot.availability.switchModelConfig.allowed,true);
 const guard={...params,baseRevision:snapshot.revision,baseLogEpoch:snapshot.logEpoch};
 assert.equal(await service.validateRevision(guard),true);
 current.activeTurn='new-native-turn';
 assert.equal(await service.validateRevision(guard),false);
 await service.refreshWorkspace(params);
 assert.equal(applyDeltas(snapshot,frames.at(-1).frame.payload.deltas).inputRouting.mode,'guide');
 listener.dispose();service.dispose();
});
function fixture(){const native=new Emitter(),catalog=new Emitter(),gets=[];const baseServices={project:{readTree:async()=>({projects:[],tasks:[{taskId:id,workspacePath:'/authorized',title:'Fixture only',createdAt:1000,updatedAt:2000,status:'completed'}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event},'zcode-agent':{helloConversationV4:()=>({originalSupport:true})}};
 const service=createConversationReadServices({api:{get:async path=>{gets.push(path);assert.ok(path.startsWith('/api/history?'));return structuredClone(page)}},baseServices,eventAdapter:{pollNow:async()=>{},changes:catalog.event}});return{service,agent:service.channels['zcode-agent'],native,gets};}
test('native rows pass original snapshot validator without legacy message shape',()=>{const result=projectConversationV4(page);assert.equal(result.rows.totalCount,3);assert.deepEqual(result.rows.window.map(x=>x.kind),['userInput','assistantText','toolCall']);assert.equal(result.inputRouting.mode,'reject');assert.equal(result.control.canStop,false);assert.equal(result.rows.window[2].output.text,'fixture result');});
test('original logical frames, original wire complete envelope, resync, range, release and native invalidation',async()=>{const{service,agent,native,gets}=fixture(),frames=[];const listener=agent.onDynamicConversationFrame(params)(value=>frames.push(value));const subscribed=await agent.subscribeConversationV4(params);assert.equal(subscribed.ack.mode,'snapshot');assert.equal(frames.length,1);assert.equal(frames[0].deliveryKind,'initial');assert.equal(frameSchema.safeParse(frames[0].frame).success,true);assert.equal(frames[0].frame.subscriptionId,subscribed.ack.subscriptionId);const range=await agent.conversationRowsRangeV4({...params,beforeRowId:3,limit:1});assert.equal(range.rows[0].kind,'assistantText');assert.equal(range.hasMore,true);await agent.resyncConversationV4({...params,subscriptionId:subscribed.ack.subscriptionId});assert.equal(frames[1].deliveryKind,'recovery');native.fire({type:'task_snapshot_updated'});await new Promise(r=>setTimeout(r,1100));assert.equal(frames.length,2);assert.equal(gets.length,3);await agent.unsubscribeConversationV4({...params,subscriptionId:subscribed.ack.subscriptionId});native.fire({});await new Promise(r=>setTimeout(r,5));assert.equal(frames.length,2);listener.dispose();service.dispose();});
test('sessions index uses original frame schema; execution rejects and scope blocks before GET',async()=>{const{service,agent,gets}=fixture(),frames=[];const l=agent.onDynamicSessionsIndexFrame(params)(f=>frames.push(f));await agent.subscribeSessionsIndexV4(params);assert.equal(indexFrameSchema.safeParse(frames[0].frame).success,true);assert.equal(frames[0].frame.payload.snapshot.sessions[0].sessionId,id);await assert.rejects(agent.sendConversationCommandV4({...params,envelope:{type:'createSession'}}),/只读/);await assert.rejects(agent.subscribeConversationV4({...params,workspacePath:'/unrelated'}));assert.equal(gets.length,0);l.dispose();service.dispose();});

function imageFixture(){
 const value=structuredClone(page),turn=value.turns[0];
 turn.items[0].content.push({type:'image',reference:{threadId:id,turnId:turn.id,itemId:'u',index:1},url:'/api/thread-media?'+new URLSearchParams({threadId:id,turnId:turn.id,itemId:'u',index:1})});
 return value;
}

test('native user images use original attachment schema and authenticated same-origin refs without placeholder duplication',()=>{
 const value=imageFixture(),attachmentId='a'.repeat(48);
 value.turns[0].items[0].content.push({type:'attachment',kind:'image',id:attachmentId,name:'/private/source/upload.png',url:'/api/attachment?id='+attachmentId});
 const snapshot=projectConversationV4(value),row=snapshot.rows.window[0];
 assert.equal(row.text,'fixture user');assert.equal(row.attachments.length,2);
 assert.deepEqual(Object.keys(row.attachments[0]),['ref','fileName','mime','bytes']);
 assert.equal(row.attachments[0].mime,'image/*');assert.equal(row.attachments[1].fileName,'upload.png');
 for(const attachment of row.attachments){const url=new URL(attachment.ref,'http://mobile.invalid');assert.equal(url.pathname,'/mobile/api/image');assert.equal(url.searchParams.get('threadId'),id);assert.ok(resolveMobileImagePath(value,url.searchParams).startsWith('/api/'));}
 assert.equal(JSON.stringify(snapshot).includes('/private/source'),false);
 assert.equal(JSON.stringify(snapshot).includes('data:image'),false);
});

test('native generated images reuse the original assistant Markdown image renderer',()=>{
 const value=imageFixture(),turn=value.turns[0];
 turn.items.push({id:'generated',type:'imageGeneration',status:'completed',media:{type:'image',reference:{threadId:id,turnId:turn.id,itemId:'generated',index:0}}});
 const row=projectConversationV4(value).rows.window.find(row=>row.entityId==='generated');
 assert.equal(row.kind,'assistantText');assert.equal(row.state,'complete');
 const source=/!\[生成的图片\]\(([^)]+)\)/.exec(row.text)?.[1];assert.ok(source?.startsWith('/mobile/api/image?'));
 const url=new URL(source,'http://mobile.invalid');assert.equal(url.searchParams.get('itemId'),'generated');assert.equal(url.searchParams.get('index'),'0');assert.ok(resolveMobileImagePath(value,url.searchParams).includes('itemId=generated'));
});

test('unscoped image data and local paths remain unavailable rather than leaking into image refs',()=>{
 const value=structuredClone(page);
 value.turns[0].items[0].content.push({type:'image',url:'data:image/png;base64,PRIVATE_IMAGE_BYTES'},{type:'localImage',path:'/private/native-photo.png'},{type:'image',url:'https://foreign.example/photo.png'},{type:'image',reference:{threadId:'another-thread',turnId:'turn1',itemId:'u',index:3}});
 const snapshot=projectConversationV4(value),row=snapshot.rows.window[0];assert.equal(row.attachments,undefined);assert.match(row.text,/\[图片\]/);
 for(const privateValue of ['PRIVATE_IMAGE_BYTES','/private/native-photo.png','foreign.example','another-thread'])assert.equal(JSON.stringify(snapshot).includes(privateValue),false);
});

test('old native history images retain the cursor of their own authorized page',async()=>{
 const latest=structuredClone(page),older=imageFixture(),frames=[],gets=[];latest.nextCursor='rollout:older-page';latest.turns[0].id='latest-turn';latest.turns[0].items=[{id:'new-message',type:'agentMessage',text:'latest'}];older.nextCursor=null;
 const service=createConversationReadServices({api:{get:async path=>{gets.push(path);return structuredClone(path.includes('&cursor=')?older:latest);}},baseServices:{project:{readTree:async()=>({projects:[],tasks:[{taskId:id,workspacePath:'/authorized'}]})},'zcode-task':{onDynamicTaskEvent:()=>()=>({dispose(){}})}}});
 const agent=service.channels['zcode-agent'],listener=agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));
 try{await agent.subscribeConversationV4(params);const row=frames[0].frame.payload.snapshot.rows.window.find(row=>row.entityId==='u'),url=new URL(row.attachments[0].ref,'http://mobile.invalid');assert.equal(url.searchParams.get('cursor'),'rollout:older-page');assert.ok(resolveMobileImagePath(older,url.searchParams).startsWith('/api/thread-media?'));assert.equal(gets.length,2);assert.equal(frameSchema.safeParse(frames[0].frame).success,true);}finally{listener.dispose();service.dispose();}
});

test('streamed reasoning and commentary preserve only the native supplied progress text',async()=>{
 const current=structuredClone(page),native=new Emitter(),frames=[];current.turns[0].status='inProgress';current.activeTurn='turn1';current.turns[0].items=[{id:'thought',type:'reasoning',summary:['native supplied summary'],content:['HIDDEN_INTERNAL_REASONING']},{id:'progress',type:'agentMessage',phase:'commentary',text:'native supplied progress'}];
 const service=createConversationReadServices({writable:true,api:{get:async()=>structuredClone(current)},baseServices:{project:{readTree:async()=>({projects:[],tasks:[{taskId:id,workspacePath:'/authorized'}]})},'zcode-task':{onDynamicTaskEvent:()=>native.event}}}),agent=service.channels['zcode-agent'];
 const listener=agent.onDynamicConversationFrame(params)(frame=>frames.push(frame));
 try{
  await agent.subscribeConversationV4(params);const initial=frames[0].frame.payload.snapshot.rows.window;
  assert.deepEqual(initial.map(row=>[row.kind,row.text,row.state]),[['reasoning','native supplied summary','streaming'],['assistantText','native supplied progress','streaming']]);assert.equal(JSON.stringify(initial).includes('HIDDEN_INTERNAL_REASONING'),false);
  current.turns[0].items[0].summary.push({text:'next supplied summary'});current.turns[0].items.push({id:'final',type:'agentMessage',phase:'final_answer',text:'native final response'});current.turns[0].status='completed';current.activeTurn=null;
  native.fire({type:'task_snapshot_updated'});await new Promise(resolve=>setTimeout(resolve,1100));
  const updated=applyDeltas(frames[0].frame.payload.snapshot,frames.at(-1).frame.payload.deltas);
  assert.equal(updated.rows.window[0].text,'native supplied summary\nnext supplied summary');assert.ok(updated.rows.window.filter(row=>row.kind==='reasoning').every(row=>row.state==='complete'));assert.equal(updated.rows.window.at(-1).kind,'assistantText');assert.equal(updated.rows.window.at(-1).text,'native final response');assert.equal(updated.inputRouting.mode,'startNow');
 }finally{listener.dispose();service.dispose();}
});

test('running and paused native queues remain visible and allow follow-up input',()=>{
 const current={...page,activeTurn:'turn1',queue:{paused:true,items:[{id:'q1',requestId:'q1',text:'follow up',createdAt:1234,status:'queued'}]}};
 const result=projectConversationV4(current,{writable:true});assert.equal(result.inputRouting.mode,'guide');assert.equal(result.queue.items[0].text,'follow up');assert.equal(result.queue.items[0].queueItemId,'q1');assert.equal(result.queue.autoDrain,false);assert.equal(result.queue.pauseReason,'manual');assert.equal(result.availability.queueEdit.allowed,true);
});

test('queued image restores after withdrawal and retains the original ref for resend; cached chunks reauthorize',async t=>{
 const {createQueuedAttachmentResolver}=await import('../queued-attachments.mjs');
 const attachmentId='a'.repeat(48),ref='/api/attachment?id='+attachmentId,bytes=Buffer.from('fixture image');
 const current={...structuredClone(page),queue:{threadId:id,items:[{id:'queued-image',text:'',attachments:[attachmentId],createdAt:1,status:'queued'}]}};
 let fetches=0,authorizations=0;
 const api={origin:'http://fixture.invalid',bearer:'fixture',get:async()=>structuredClone(current),fetch:async url=>{fetches++;assert.equal(url,'http://fixture.invalid'+ref);return new Response(bytes,{headers:{'content-type':'image/png'}});}};
 const sharedResolver=createQueuedAttachmentResolver({api,resolveUploaded:async()=>{throw Object.assign(new Error('expired upload'),{code:'CODEX_ATTACHMENT_NOT_FOUND'});}});
 const resolveAttachment=async p=>{authorizations++;return sharedResolver(p);};
 const service=createConversationReadServices({api,resolveAttachment,baseServices:{project:{readTree:async()=>({tasks:[{taskId:id,workspacePath:params.workspacePath}],projects:[{roots:[{rootPath:'/other'}]}]})}}});
 t.after(()=>service.dispose());const agent=service.channels['zcode-agent'];
 const queued=projectConversationV4(current,{writable:true}).queue.items[0];
 assert.equal(queued.text,'');assert.deepEqual(queued.attachments,[{ref,fileName:'图片 1',mime:'image/*',bytes:0}]);
 // Writer authorizes the original queued refs before deleting the queue item.
 await resolveAttachment({...params,ref});current.queue.items=[];
 const first=await agent.attachmentReadV4({...params,ref,offset:0,limit:4});
 const rest=await agent.attachmentReadV4({...params,ref,offset:4,limit:100});
 assert.deepEqual(Buffer.concat([Buffer.from(first.dataBase64,'base64'),Buffer.from(rest.dataBase64,'base64')]),bytes);
 assert.equal(rest.mediaType,'image/png');assert.equal(rest.nextOffset,null);assert.equal(fetches,1);assert.equal(authorizations,3);
 assert.deepEqual(await resolveAttachment({...params,ref:queued.attachments[0].ref}),{id:attachmentId});
 current.thread.cwd='/other';
 await assert.rejects(agent.attachmentReadV4({...params,ref,offset:0,limit:4}),/工作区/);
 await assert.rejects(agent.attachmentReadV4({...params,workspacePath:'/other',ref,offset:0,limit:4}),/队列/);
 assert.equal(fetches,1);
 for(const invalid of [ref+'&path=/private/image',ref+'#hash',ref+'&id='+attachmentId,'http://codex.invalid'+ref,'/api/attachment?id='+attachmentId.toUpperCase(),'/private/image']){
  await assert.rejects(agent.attachmentReadV4({...params,ref:invalid,offset:0,limit:4}));
 }
 assert.equal(fetches,1);
});

test('agent commentary and plan remain visible assistant text while native reasoning stays reasoning',()=>{
 const current=structuredClone(page);current.turns[0].status='inProgress';current.turns[0].items=[
  {id:'commentary',type:'agentMessage',phase:'commentary',text:'运行中上翻历史也验到了'},
  {id:'plan',type:'plan',phase:'commentary',text:'下一步验证'},
  {id:'reasoning',type:'reasoning',summary:['native summary']},
 ];
 assert.deepEqual(projectConversationV4(current).rows.window.map(row=>[row.kind,row.text]),[['assistantText','运行中上翻历史也验到了'],['assistantText','下一步验证'],['reasoning','native summary']]);
});

// Native automatic append briefly enters the queue before sendNow acknowledges it.
// Present that intermediate state in the timeline, without hiding failures.
test('automatic appends use pending timeline messages and retain failed or external queue controls',()=>{
 const id='zcv4_'+'a'.repeat(48);
 const current=status=>({...page,activeTurn:'turn1',queue:{paused:false,items:[{id,requestId:id,text:'追加说明',status,createdAt:1234}]}});
 for(const status of ['queued','sending']){
  const snapshot=projectConversationV4(current(status),{writable:true});
  assert.equal(snapshot.queue.items[0].delivery.admitted,'guide');
  assert.equal(snapshot.queue.items[0].text,'追加说明');
  assert.equal(snapshot.rows.window.filter(row=>row.text==='追加说明').length,0);
 }
 for(const status of ['failed','uncertain'])assert.equal(projectConversationV4(current(status),{writable:true}).queue.items[0].delivery.admitted,'queue');
 const paused=current('queued');paused.queue.paused=true;
 assert.equal(projectConversationV4(paused,{writable:true}).queue.items[0].delivery.admitted,'queue');
 const external=current('queued');external.queue.items[0].id='desktop-queued';
 assert.equal(projectConversationV4(external,{writable:true}).queue.items[0].delivery.admitted,'queue');
 const complete=current('sending');complete.queue.items=[];
 assert.equal(projectConversationV4(complete,{writable:true}).queue.items.length,0);
});
test('Codex renderer keeps every delivery state inline while other hosts retain queue controls',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {runInNewContext}=await import('node:vm');
 const bundle=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
 const start=bundle.indexOf('function Y8t('),end=bundle.indexOf('var X8t=',start);
 assert(start>=0&&end>start);
 const split=runInNewContext(bundle.slice(start,end)+';Y8t',{__codexIsMobile:()=>true});
 const requestId='zcv4_'+'b'.repeat(48);
 const snapshot=projectConversationV4({...page,activeTurn:'turn1',queue:{items:[{id:requestId,status:'sending',text:'追加正文',createdAt:1234}]}},{writable:true});
 const view=split(snapshot.queue);
 assert.equal(view.visibleQueue.items.length,0);
 assert.equal(view.pendingGuides.length,1);
 assert.equal(view.pendingGuides[0].text,'追加正文');
 const waiting={...snapshot.queue,autoDrain:false,items:[{...snapshot.queue.items[0],delivery:{requested:'auto',admitted:'queue'}}]};
 assert.equal(split(waiting).visibleQueue.items.length,0);
 assert.equal(split(waiting).pendingGuides.length,1);
 const original=runInNewContext(bundle.slice(start,end)+';Y8t',{__codexIsMobile:()=>false});
 assert.equal(original(waiting).visibleQueue.items.length,1);
});
