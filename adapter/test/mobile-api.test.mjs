import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {createAttachmentUploadServices} from '../attachment-upload.mjs';
import {createQueuedAttachmentResolver} from '../queued-attachments.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMobileApi} from '../mobile-api.mjs';

const id='00000000-0000-0000-0000-000000000001',fresh='00000000-0000-0000-0000-000000000002';
async function fixture(t,{post,get,history=()=>({}),options={},configure,tree,fetch:apiFetch}={}){
 const directory=await mkdtemp(join(tmpdir(),'cm-api-'));const posts=[],threads=new Set([id]);
 const api={origin:'http://127.0.0.1:8787',bearer:'private-never-in-response',async get(path){
  if(get){const value=await get(path);if(value!==undefined)return value;}
  if(path==='/api/status')return{online:true,desktopOnline:true,cwd:'/workspace'};
  if(path==='/api/models')return{data:[{model:'native-model',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
  if(path.startsWith('/api/events'))return{sequence:9,epoch:'test-epoch',events:[{method:'item/agentMessage/delta',params:{threadId:id,delta:'must-not-leave-events'}}]};
  if(path==='/api/projects')return{projects:[{id:'project',name:'project',roots:['/workspace']}]};
  if(path.startsWith('/api/threads'))return{data:[...threads].map(id=>({id,cwd:'/workspace'})),nextCursor:null};
  const target=new URL(path,api.origin).searchParams.get('threadId');
  return{thread:{id:target,cwd:'/workspace'},attached:true,turns:[],activeTurn:null,...await history(target,path)};
 },async post(path,body){posts.push({path,body});if(post)return post(path,body);if(path==='/api/thread'){threads.add(fresh);return{thread:{id:fresh},desktop:{attached:true}};}return{turn:{id:'native-turn'}};},async fetch(...args){if(apiFetch)return apiFetch(...args);throw Error('image fetch must not happen');}};
 const baseServices={project:{readTree:async()=>tree||({projects:[{id:'project',roots:[{rootPath:'/workspace'}]}],tasks:[...threads].map(taskId=>({taskId,workspacePath:'/workspace'}))})}};
 const config={api,baseServices,ledgerDir:directory,...options,...await configure?.(api,baseServices)};const handler=createMobileApi(config);
 const server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://test')));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 return{posts,handler,config,async get(path){const r=await fetch(origin+path);return{status:r.status,value:await r.json()};},async post(path,body){const r=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,value:await r.json()};}};
}

test('light bootstrap exposes actual models and projects without local credentials',async t=>{
 const f=await fixture(t),r=await f.get('/mobile/api/bootstrap');assert.equal(r.status,200);assert.equal(r.value.models[0].model,'native-model');assert.equal(r.value.projects[0].roots[0],'/workspace');assert(!JSON.stringify(r).includes('private-never'));
 assert.equal((await f.get('/mobile/api/proxy?url=http://external')).status,404);
});

test('light creation and send are durable and selected native model travels on automatic delivery',async t=>{
 const f=await fixture(t),data={cwd:'/workspace',projectId:'project',name:'Phone test',requestId:'create-request-1',model:'native-model',effort:'low'};
 const a=await f.post('/mobile/api/create',data),b=await f.post('/mobile/api/create',data);
 assert.equal(a.value.thread.id,fresh);assert.equal(b.value.thread.id,fresh);assert.equal(f.posts.length,1);assert.equal(f.posts[0].body.name,'Phone test');
 const collision=await f.post('/mobile/api/create',{...data,name:'Different title'});assert.equal(collision.value.code,'COMMAND_ID_COLLISION');assert.equal(f.posts.length,1);
 const sent=await f.post('/mobile/api/message',{threadId:fresh,text:'isolated fixture',requestId:'send-request-1',model:'native-model',effort:'low'});
 assert.equal(sent.value.turn.id,'native-turn');assert.equal(f.posts[1].body.delivery,undefined);assert.equal(sent.value.delivery,'startNow');assert.equal(sent.value.inputId,f.posts[1].body.requestId);assert.equal(f.posts[1].body.model,'native-model');assert.equal(f.posts[1].body.effort,'low');
});

test('unknown creates retain a native ID and replay never allocates a second thread',async t=>{
 const f=await fixture(t,{post:async()=>{throw Object.assign(Error('attach pending'),{threadId:fresh,outcomeUnknown:true});}});
 const input={cwd:'/workspace',requestId:'unknown-create-1'};
 const a=await f.post('/mobile/api/create',input),b=await f.post('/mobile/api/create',input);
 assert.equal(a.value.threadId,fresh);assert.equal(a.value.outcomeUnknown,true);assert.equal(b.value.threadId||b.value.thread?.id,fresh);assert.equal(f.posts.length,1);
});

test('foreign workspace, forged images and unsupported operations cannot dispatch writes',async t=>{
 const f=await fixture(t);
 assert.equal((await f.post('/mobile/api/create',{cwd:'/outside',requestId:'create-outside-1'})).status,400);
 assert.equal((await f.get('/mobile/api/image?threadId='+id+'&attachmentId='+'a'.repeat(48))).status,403);
 assert.equal((await f.post('/mobile/api/interrupt',{threadId:id})).status,404);
 assert.equal(f.posts.length,0);
});

 test('phone JSON preserves Chinese characters split across network buffers',async t=>{
 const f=await fixture(t);const bytes=Buffer.from(JSON.stringify({threadId:id,text:'中文',requestId:'split-chinese-1'})),split=bytes.indexOf(Buffer.from('中'))+1;
 const req=Readable.from([bytes.subarray(0,split),bytes.subarray(split)]);req.method='POST';let output;
 await f.handler(req,{writeHead(){},end(value){output=JSON.parse(value);}},new URL('http://test/mobile/api/message'));
 assert.equal(output.accepted,true);assert.equal(f.posts[0].body.text,'中文');
 });
 test('change notifications contain no message content and filter unrelated native threads',async t=>{
 const f=await fixture(t),a=await f.get('/mobile/api/changes?threadId='+id+'&since=0'),b=await f.get('/mobile/api/changes?threadId='+fresh+'&since=0');
 assert.deepEqual(a.value,{sequence:9,epoch:'test-epoch',changed:true});assert.equal(b.value.changed,false);assert(!JSON.stringify(a).includes('must-not-leave-events'));
 assert.equal((await f.get('/mobile/api/changes?threadId='+id+'&since=-1')).status,400);
 });

const attachmentId='a'.repeat(48),descriptor={ref:'/api/attachment?id='+attachmentId,fileName:'原图.png',mime:'image/png',bytes:32};
const queueItem={id:'native-queue-1',requestId:'native-queue-1',text:'原文',attachments:[attachmentId],status:'queued'};
const queueOf=items=>({threadId:id,items,paused:false});
const turn=(text,extra={})=>({id:'turn-one',items:[{id:'assistant-one',type:'agentMessage',text,...extra}]});
const historyUrl='/mobile/api/history?threadId='+id;

test('bootstrap and projectless creation use the registered conversation workspace',async t=>{
 const cwd='/conversations';const f=await fixture(t,{options:{conversationWorkspacePath:cwd},tree:{projects:[],tasks:[],conversationWorkspacePath:cwd},history:target=>({thread:{id:target,cwd}})});
 assert.equal((await f.get('/mobile/api/bootstrap')).value.cwd,cwd);
 const created=await f.post('/mobile/api/create',{requestId:'global-create-1'});
 assert.equal(created.status,200);assert.equal(created.value.thread.cwd,cwd);assert.equal(f.posts[0].body.cwd,cwd);assert.equal(f.posts[0].body.projectId,undefined);
});

test('skills come from the real scoped catalog and dollar skill text stays intact',async t=>{
 let catalog;
 const f=await fixture(t,{get:path=>{if(path.startsWith('/api/skills?')){catalog=path;return{data:[{name:'draw',path:'/skills/draw/SKILL.md',description:'绘图',enabled:true,secret:'omit'},{name:'disabled',path:'/skills/disabled',enabled:false}]};}}});
 assert.deepEqual((await f.get('/mobile/api/skills?cwd=%2Fworkspace')).value,{data:[{name:'draw',path:'/skills/draw/SKILL.md',description:'绘图'}]});
 assert.equal(catalog,'/api/skills?cwd=%2Fworkspace');assert.equal((await f.get('/mobile/api/skills?cwd=%2Foutside')).status,403);
 assert.equal((await f.post('/mobile/api/message',{threadId:id,requestId:'skill-message-1',text:'[$draw](/skills/draw/SKILL.md) 请画图'})).value.accepted,true);
 assert.equal(f.posts[0].body.text,'[$draw](/skills/draw/SKILL.md) 请画图');
});

test('active send guides once, returns stable inputId and accepts without a new turn',async t=>{
 const f=await fixture(t,{history:()=>({activeTurn:'running'}),post:async(path,body)=>path==='/api/message'?{queued:true,queue:queueOf([{id:body.requestId,requestId:body.requestId,status:'queued'}])}:queueOf([])});
 const data={threadId:id,requestId:'guide-message-1',text:'继续'},a=await f.post('/mobile/api/message',data),b=await f.post('/mobile/api/message',data);
 assert.equal(a.status,200);assert.equal(a.value.accepted,true);assert.equal(a.value.delivery,'guide');assert.deepEqual(a.value.turn,{});assert.equal(a.value.inputId,f.posts[0].body.requestId);assert.deepEqual(a,b);
 assert.deepEqual(f.posts.map(p=>p.path),['/api/message','/api/queue']);assert.equal(f.posts[1].body.id,a.value.inputId);assert.equal(f.posts[0].body.delivery,undefined);
});

test('unknown send never retries the native mutation and preserves recoverable status',async t=>{
 const f=await fixture(t,{post:async()=>{throw Error('lost response');}}),data={threadId:id,requestId:'unknown-send-1',text:'only once'};
 const a=await f.post('/mobile/api/message',data),b=await f.post('/mobile/api/message',data);
 assert.equal(a.status,409);assert.equal(a.value.outcomeUnknown,true);assert.equal(b.value.outcomeUnknown,true);assert.equal(f.posts.length,1);
});

test('persisted model selection and authorized attachment descriptors reach the native writer',async t=>{
 const resolved=[];const f=await fixture(t,{options:{modelSelections:{get:async()=>({model:'native-model',effort:'low'})},resolveAttachment:async p=>{resolved.push(p);return{id:attachmentId};}}});
 const sent=await f.post('/mobile/api/message',{threadId:id,requestId:'attachment-send-1',text:'',attachments:[descriptor]});
 assert.equal(sent.status,200);assert.deepEqual(f.posts[0].body.attachments,[attachmentId]);assert.equal(f.posts[0].body.model,'native-model');assert.equal(f.posts[0].body.effort,'low');
 assert.deepEqual(resolved,[{workspacePath:'/workspace',sessionId:id,ref:descriptor.ref}]);
 const bad=await f.post('/mobile/api/message',{threadId:id,requestId:'attachment-send-2',text:'',attachments:[{...descriptor,ref:'file:///secret.png'}]});assert.equal(bad.status,400);assert.equal(f.posts.length,1);
});

test('HTTP upload reuses real V4 staging, commit retry and authorization with 800 KiB bound',async t=>{
 const bytes=Buffer.alloc(384*1024,7),identity={workspacePath:'/workspace',sessionId:'draft:'+id,uploadId:'fixture-upload-1'};
 let uploads;
 const f=await fixture(t,{configure:api=>{uploads=createAttachmentUploadServices({api,scope:async p=>p.workspacePath==='/workspace'});return{uploads,resolveAttachment:uploads.resolveAttachment};},post:async(path)=>{assert.equal(path,'/api/upload');return{id:attachmentId,url:descriptor.ref,mime:'image/png',name:'fixture.png',size:bytes.length};}});t.after(()=>uploads.dispose());
 const call=data=>f.post('/mobile/api/upload',{...identity,...data});
 assert.equal((await call({action:'begin',fileName:'fixture.png',mime:'image/png',totalBytes:bytes.length,totalChunks:1,checksum:'sha256:'+createHash('sha256').update(bytes).digest('hex')})).status,200);
 assert.equal((await call({action:'chunk',chunkIndex:0,dataBase64:bytes.toString('base64')})).status,200);
 assert.deepEqual((await call({action:'commit'})).value,{ref:descriptor.ref});assert.deepEqual((await call({action:'commit'})).value,{ref:descriptor.ref});assert.equal(f.posts.length,1);
 assert.equal((await call({action:'abort'})).status,200);
 assert.equal((await call({action:'abort',workspacePath:'/foreign'})).status,403);
 assert.equal((await call({action:'chunk',dataBase64:'a'.repeat(800*1024)})).status,413);
 assert.equal((await call({action:'__proto__'})).status,400);
});

test('queue GET and delete return trusted metadata; deleted attachment remains parseable on resend',async t=>{
 let items=[queueItem],metaReads=0;
 const f=await fixture(t,{history:()=>({queue:queueOf(items)}),configure:api=>({resolveAttachment:createQueuedAttachmentResolver({api,resolveUploaded:async()=>{throw Object.assign(Error('expired'),{code:'CODEX_ATTACHMENT_NOT_FOUND'});}})}),fetch:async(url,init)=>{metaReads++;assert.match(url,/\/api\/attachment\?id=a{48}&meta=1$/);assert.equal(init.headers.authorization,'Bearer private-never-in-response');return Response.json({id:attachmentId,name:descriptor.fileName,mime:descriptor.mime,size:descriptor.bytes});},post:async(path,body)=>{if(path==='/api/queue'){assert.equal(body.action,'remove');items=[];return queueOf(items);}return{turn:{id:'native-resend-turn'}};}});
 const listed=await f.get('/mobile/api/queue?threadId='+id);assert.deepEqual(listed.value.items[0].attachments,[descriptor]);
 const data={threadId:id,requestId:'queue-delete-1',action:'delete',id:queueItem.id};
 const removed=await f.post('/mobile/api/queue',data);assert.equal(removed.status,200);assert.deepEqual(removed.value.restored,{text:queueItem.text,attachments:[descriptor]});
 assert.deepEqual(await f.post('/mobile/api/queue',data),removed);assert.equal(f.posts.length,1);
 const resent=await f.post('/mobile/api/message',{threadId:id,requestId:'queue-resend-1',...removed.value.restored});assert.equal(resent.value.accepted,true);assert.deepEqual(f.posts[1].body.attachments,[attachmentId]);assert.equal(metaReads,2);
});

test('missing or mismatched attachment metadata blocks queue removal',async t=>{
 for(const metadata of [{id:attachmentId},{id:'b'.repeat(48),name:'x.png',mime:'image/png',size:32}]){
  const f=await fixture(t,{history:()=>({queue:queueOf([queueItem])}),options:{resolveAttachment:async()=>({id:attachmentId})},fetch:async()=>Response.json(metadata)});
  const r=await f.post('/mobile/api/queue',{threadId:id,requestId:'queue-safe-delete',action:'delete',id:queueItem.id});assert.equal(r.status,409);assert.equal(f.posts.length,0);
 }
});

test('queue actions map to existing scoped commands and reject forged queues',async t=>{
 const f=await fixture(t,{history:()=>({queue:queueOf([{...queueItem,attachments:[]}])}),post:async()=>queueOf([])});
 for(const [action,native]of [['sendNow','sendNow'],['edit','edit'],['resume','resume'],['pause','pause']]){
  const r=await f.post('/mobile/api/queue',{threadId:id,requestId:'queue-action-'+action,action,id:queueItem.id,text:'changed'});assert.equal(r.status,200);assert.equal(f.posts.at(-1).body.action,native);
 }
 assert.equal(f.posts[1].body.text,'changed');assert.equal((await f.post('/mobile/api/queue',{threadId:id,requestId:'queue-action-bad',action:'__proto__'})).status,400);
 const foreign=await fixture(t,{history:()=>({queue:{...queueOf([]),threadId:fresh}})});assert.equal((await foreign.get('/mobile/api/queue?threadId='+id)).status,403);
});

test('archive blocks active, pending-queue and foreign workspaces before any native post',async t=>{
 for(const page of [{activeTurn:'running'},{thread:{id,cwd:'/workspace',status:{type:'active'}}},{queue:queueOf([queueItem])},{thread:{id,cwd:'/outside'}}]){
  const f=await fixture(t,{history:()=>page});const r=await f.post('/mobile/api/archive',{threadId:id,requestId:'archive-blocked-1'});assert.ok([403,409].includes(r.status));assert.equal(f.posts.length,0);
 }
});

test('archive pending and unknown results only reconcile using the same native request',async t=>{
 let statusReads=0;
 const f=await fixture(t,{post:async(path,body)=>{assert.equal(path,'/api/thread/archive');return{...body,pending:true,archived:false,status:'pending'};},get:path=>{if(path.startsWith('/api/thread/archive/status?')){statusReads++;return{threadId:id,requestId:'archive-request-1',archived:true,verified:true,pending:false};}}});
 const data={threadId:id,requestId:'archive-request-1'};
 assert.equal((await f.post('/mobile/api/archive',data)).status,202);assert.equal((await f.post('/mobile/api/archive',data)).value.verified,true);assert.equal((await f.post('/mobile/api/archive',data)).value.verified,true);assert.equal(f.posts.length,1);assert.equal(statusReads,1);
 const unknown=await fixture(t,{post:async()=>{throw Error('lost');},get:path=>path.startsWith('/api/thread/archive/status?')?{threadId:id,requestId:data.requestId,pending:true,archived:false,outcomeUnknown:true}:undefined});
 assert.equal((await unknown.post('/mobile/api/archive',data)).status,409);assert.equal((await unknown.post('/mobile/api/archive',data)).status,202);assert.equal(unknown.posts.length,1);
});

test('archive mismatched receipts remain unknown and never claim success',async t=>{
 const f=await fixture(t,{post:async()=>({threadId:fresh,requestId:'archive-mismatch-1',archived:true,verified:true})});const r=await f.post('/mobile/api/archive',{threadId:id,requestId:'archive-mismatch-1'});assert.equal(r.status,409);assert.equal(r.value.outcomeUnknown,true);
});

test('history delta appends only prefix growth with identical metadata and keeps new/changed/deleted rows',async t=>{
 let turns=[turn('你')];const f=await fixture(t,{history:()=>({turns})});const first=(await f.get(historyUrl)).value;assert.ok(first.revision);assert.equal(first.delta,undefined);
 turns=[turn('你好')];const appended=(await f.get(historyUrl+'&since='+first.revision)).value;assert.equal(appended.delta,true);assert.deepEqual(appended.messages,[]);assert.deepEqual(appended.appends,[{id:'assistant-one',text:'好'}]);
 const unchanged=(await f.get(historyUrl+'&since='+appended.revision)).value;assert.deepEqual(unchanged.appends,[]);assert.deepEqual(unchanged.messages,[]);
 turns=[turn('改写'),{id:'turn-two',items:[{id:'user-two',type:'userMessage',content:[{type:'text',text:'问题'}]}]}];
 const changed=(await f.get(historyUrl+'&since='+appended.revision)).value;assert.deepEqual(changed.messages.map(m=>m.text),['改写','问题']);assert.deepEqual(changed.appends,[]);
 turns=turns.slice(1);const removed=(await f.get(historyUrl+'&since='+changed.revision)).value;assert.deepEqual(removed.removedIds,['assistant-one']);
});

test('history metadata changes, cursor pages and paging boundaries never use text-only appends',async t=>{
 let turns=[turn('one')],nextCursor='older-1';const f=await fixture(t,{history:()=>({turns,nextCursor})});const first=(await f.get(historyUrl)).value;
 turns=[{...turn('one two'),id:'different-turn'}];const changed=(await f.get(historyUrl+'&since='+first.revision)).value;assert.equal(changed.messages[0].turnId,'different-turn');assert.deepEqual(changed.appends,[]);
 assert.equal((await f.get(historyUrl+'&cursor=older-1&since='+changed.revision)).value.delta,undefined);
 nextCursor='older-2';assert.equal((await f.get(historyUrl+'&since='+changed.revision)).value.delta,undefined);
 assert.equal((await f.get(historyUrl+'&since=expired')).value.messages[0].text,'one two');
});

test('history cache bounds revisions and threads while retaining complete long messages',async t=>{
 let text='v0';const f=await fixture(t,{history:()=>({turns:[turn(text)]})});const first=(await f.get(historyUrl)).value;
 for(let n=1;n<=5;n++){text='v'+n;await f.get(historyUrl);}
 assert.equal((await f.get(historyUrl+'&since='+first.revision)).value.delta,undefined);
 const current=(await f.get(historyUrl)).value;
 for(let n=2;n<=18;n++)await f.get('/mobile/api/history?threadId=00000000-0000-0000-0000-'+String(n).padStart(12,'0'));
 assert.equal((await f.get(historyUrl+'&since='+current.revision)).value.delta,undefined);
 text='长'.repeat(150000);const long=(await f.get(historyUrl)).value;assert.equal(long.messages[0].text,text);text+='结束';const delta=(await f.get(historyUrl+'&since='+long.revision)).value;assert.deepEqual(delta.appends,[{id:'assistant-one',text:'结束'}]);
});

test('history cache total byte budget evicts snapshots instead of truncating the response',async t=>{
 let text='x'.repeat(3*1024*1024);const f=await fixture(t,{history:()=>({turns:[turn(text)]})});const first=(await f.get(historyUrl)).value;
 text='y'.repeat(3*1024*1024);await f.get(historyUrl);text='z'.repeat(3*1024*1024);await f.get(historyUrl);
 const result=(await f.get(historyUrl+'&since='+first.revision)).value;assert.equal(result.delta,undefined);assert.equal(result.messages[0].text.length,3*1024*1024);
});

test('invalid JSON shapes and unavailable uploads have explicit statuses',async t=>{
 const f=await fixture(t);assert.equal((await f.post('/mobile/api/message',null)).status,400);assert.equal((await f.post('/mobile/api/message',[])).status,400);assert.equal((await f.post('/mobile/api/upload',{action:'begin'})).status,503);assert.equal((await f.post('/mobile/api/message',{threadId:id,text:'x'.repeat(160*1024),requestId:'too-large-request'})).status,413);assert.equal(f.posts.length,0);
});

test('archive cannot return success for unverified or inconclusive native states',async t=>{
 for(const result of [{archived:true,verified:false},{archived:false,verified:false,status:'notArchived'},{outcomeUnknown:true}]){
  const f=await fixture(t,{post:async(_path,body)=>({...body,...result})});const r=await f.post('/mobile/api/archive',{threadId:id,requestId:'archive-unverified'});assert.equal(r.status,409);assert.equal(r.value.code,'ARCHIVE_UNVERIFIED');
 }
});

test('queue metadata can recover from a temporary read failure without deleting or poisoning requestId',async t=>{
 let reads=0;
 const f=await fixture(t,{history:()=>({queue:queueOf([queueItem])}),options:{resolveAttachment:async()=>({id:attachmentId})},fetch:async()=>++reads===1?new Response('',{status:503}):Response.json({id:attachmentId,name:descriptor.fileName,mime:descriptor.mime,size:descriptor.bytes}),post:async()=>queueOf([])});
 const data={threadId:id,requestId:'queue-retry-metadata',action:'delete',id:queueItem.id};assert.equal((await f.post('/mobile/api/queue',data)).status,503);assert.equal(f.posts.length,0);assert.equal((await f.post('/mobile/api/queue',data)).value.accepted,true);assert.equal(f.posts.length,1);
});

test('foreign queue and cross-thread stable restore IDs cannot dispatch removal',async t=>{
 const f=await fixture(t,{history:()=>({queue:{...queueOf([{...queueItem,attachments:[]}]),threadId:fresh}})});
 assert.equal((await f.post('/mobile/api/queue',{threadId:id,requestId:'queue-foreign-id',action:'sendNow',id:queueItem.id})).status,403);assert.equal(f.posts.length,0);
});

test('queue exposes fileCount and rejects incomplete file restoration before native deletion',async t=>{
 for(const fields of [{files:['/workspace/private-notes.md','/workspace/input.csv']},{fileCount:2},{files:[],fileCount:2}]){
  const item={...queueItem,attachments:[],...fields};
  const f=await fixture(t,{history:()=>({queue:queueOf([item,{...queueItem,id:'plain-item',attachments:[]}])}),post:async()=>queueOf([])});
  const listed=await f.get('/mobile/api/queue?threadId='+id);
  assert.equal(listed.status,200);assert.equal(listed.value.items[0].fileCount,2);assert.equal(listed.value.items[1].fileCount,0);
  assert.equal(JSON.stringify(listed.value).includes('/workspace/private-notes.md'),false);
  const data={threadId:id,requestId:'queue-files-delete',action:'delete',id:item.id};
  const rejected=await f.post('/mobile/api/queue',data);
  assert.equal(rejected.status,409);assert.equal(rejected.value.code,'QUEUE_FILES_UNSUPPORTED');assert.equal(rejected.value.sent,false);assert.equal(f.posts.length,0);
  assert.equal((await f.post('/mobile/api/queue',data)).status,409);assert.equal(f.posts.length,0);
 }
});
