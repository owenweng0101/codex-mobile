import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {digest} from './write-services/ledger.mjs';
import {createImagePreview} from './mobile-image.mjs';
import {createWriteServices} from './write-services/index.mjs';
import {projectMobileHistory,resolveMobileImagePath} from './mobile-history.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fault=(message,statusCode=400,code='INVALID_INPUT')=>Object.assign(Error(message),{statusCode,code,sent:false});
const threadId=value=>{if(!uuid.test(value||''))throw fault('请选择真实 Codex 会话');return value;};
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req,limit=160*1024){
 const chunks=[];let length=0;
 for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length<=limit)chunks.push(bytes);}
 if(length>limit)throw fault('请求内容过大',413,'INPUT_TOO_LARGE');
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fault('请求格式无效');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw fault('请求必须是对象');return value;
}
const requestId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(value))throw fault('操作缺少稳定编号');return value;};
const workspacePath=value=>{if(typeof value!=='string'||!value.startsWith('/')||value.includes('\0')||value.length>4096)throw fault('请选择项目目录');return value;};
const unknown=id=>Object.assign(Error('原操作的结果正在核对，请查看该会话，不要重复新建或发送。'),{statusCode:409,code:'NATIVE_OUTCOME_UNKNOWN',outcomeUnknown:true,...(id?{threadId:id}:{})});
const queueTypes={sendNow:'sendQueuedNow',delete:'deleteQueueItem',edit:'editQueueItem',resume:'setAutoDrain',pause:'setAutoDrain'};

export function createMobileApi({api,baseServices,ledgerDir,uploads,resolveAttachment,modelSelections,conversationWorkspacePath,imagePreview=createImagePreview,imageTimeoutMs=18000,imageIdleTimeoutMs=20000}={}){
 // Finish before the ingress's 20-second inactive-upstream timeout.
 if(!Number.isSafeInteger(imageTimeoutMs)||imageTimeoutMs<1||imageTimeoutMs>19000)throw Error('Image timeout exceeds its budget');
 if(!Number.isSafeInteger(imageIdleTimeoutMs)||imageIdleTimeoutMs<1||imageIdleTimeoutMs>20000)throw Error('Image idle timeout exceeds its budget');
 const writes=createWriteServices({api,baseServices,ledgerDir,resolveAttachment,modelSelections,autoSteerActive:true});
 // Images on one page share only the in-flight history authorization read.
 // Each response can cancel independently; the last consumer aborts native work.
 const imageHistoryReads=new Map();
 function imageHistory(path,signal){
  signal.throwIfAborted();let entry=imageHistoryReads.get(path);
  if(!entry){
   const controller=new AbortController();entry={controller,consumers:0,pending:true};
   entry.promise=Promise.resolve().then(()=>{controller.signal.throwIfAborted();return api.get(path,{signal:controller.signal});});
   if(imageHistoryReads.size<32)imageHistoryReads.set(path,entry);
   const done=()=>{entry.pending=false;if(imageHistoryReads.get(path)===entry)imageHistoryReads.delete(path);};entry.promise.then(done,done);
  }
  entry.consumers++;
  let cancelled;const aborted=new Promise((_,reject)=>{cancelled=()=>reject(signal.reason);signal.addEventListener('abort',cancelled,{once:true});});
  return Promise.race([entry.promise,aborted]).finally(()=>{
   signal.removeEventListener('abort',cancelled);entry.consumers--;
   if(!entry.consumers&&entry.pending){if(imageHistoryReads.get(path)===entry)imageHistoryReads.delete(path);entry.controller.abort();}
  });
 }
 // Cache whole projected pages, never shortened messages or a truncated timeline.
 const snapshots=new Map();let snapshotBytes=0;
 function historyResponse(page,{cursor,since}){
  const projection=projectMobileHistory(page,{cursor}),revision=digest(projection),full={...projection,revision};
  if(cursor)return full;
  const id=page.thread.id,now=Date.now();
  for(const [key,versions]of snapshots){const live=versions.filter(v=>now-v.at<300000);snapshotBytes-=versions.filter(v=>!live.includes(v)).reduce((sum,v)=>sum+v.bytes,0);if(live.length)snapshots.set(key,live);else snapshots.delete(key);}
  const versions=snapshots.get(id)||[],previous=versions.find(v=>v.revision===since)?.projection;
  snapshots.delete(id);
  if(!versions.some(v=>v.revision===revision)){
   const bytes=Buffer.byteLength(JSON.stringify(projection));
   if(bytes<=8*1024*1024){versions.push({revision,projection,bytes,at:now});snapshotBytes+=bytes;}
  }
  while(versions.length>4)snapshotBytes-=versions.shift().bytes;
  if(versions.length)snapshots.set(id,versions);
  while(snapshots.size>16||snapshotBytes>8*1024*1024){const key=snapshots.keys().next().value;snapshotBytes-=snapshots.get(key).reduce((sum,v)=>sum+v.bytes,0);snapshots.delete(key);}
  if(!previous||previous.nextCursor!==projection.nextCursor)return full;
  const old=new Map(previous.messages.map(m=>[m.id,m])),current=new Map(projection.messages.map(m=>[m.id,m]));
  if(old.size!==previous.messages.length||current.size!==projection.messages.length)return full;
  // A client can append new rows; insertion/reordering needs the complete page.
  const retained=previous.messages.filter(m=>current.has(m.id)).map(m=>m.id),expected=[...retained,...projection.messages.filter(m=>!old.has(m.id)).map(m=>m.id)];
  if(JSON.stringify(expected)!==JSON.stringify(projection.messages.map(m=>m.id)))return full;
  const messages=[],appends=[];
  for(const message of projection.messages){const before=old.get(message.id);if(before&&digest(before)===digest(message))continue;
   if(before&&typeof before.text==='string'&&typeof message.text==='string'&&message.text.startsWith(before.text)&&digest({...before,text:null})===digest({...message,text:null}))appends.push({id:message.id,text:message.text.slice(before.text.length)});
   else messages.push(message);
  }
  return{...full,delta:true,messages,removedIds:previous.messages.filter(m=>!current.has(m.id)).map(m=>m.id),appends};
 }
 async function authorizeWorkspace(cwd){
  workspacePath(cwd);const tree=await baseServices.project.readTree({refresh:true});
  if(tree.conversationWorkspacePath!==cwd&&!(tree.tasks||[]).some(t=>t.workspacePath===cwd)&&!(tree.projects||[]).some(p=>(p.roots||[]).some(r=>r.rootPath===cwd)))throw fault('工作目录未授权',403,'WORKSPACE_SCOPE');
  return tree;
 }
 async function historyForThread(id){
  const page=await api.get('/api/history?threadId='+encodeURIComponent(threadId(id)));
  if(page.thread?.id!==id)throw fault('会话编号不一致',403,'THREAD_SCOPE');
  await authorizeWorkspace(page.thread.cwd);return page;
 }
 function nativeQueue(page){
  const queue=page.queue||{threadId:page.thread.id,items:[],paused:false};
  if(queue.threadId!==page.thread.id||!Array.isArray(queue.items))throw fault('队列所属会话不一致',403,'QUEUE_SCOPE');return queue;
 }
 async function attachmentDescriptor(page,id){
  if(!/^[a-f0-9]{48}$/.test(id||''))throw fault('队列附件标识无效',409,'INVALID_ATTACHMENT');
  if(typeof resolveAttachment!=='function')throw fault('附件恢复尚未就绪',503,'ATTACHMENT_UNAVAILABLE');
  const ref='/api/attachment?id='+id,metadata=await resolveAttachment({workspacePath:page.thread.cwd,sessionId:page.thread.id,ref});
  if(metadata?.id!==id)throw fault('附件授权信息不匹配',403,'INVALID_ATTACHMENT');
  let value=metadata;
  if(typeof value.name!=='string'||typeof value.mime!=='string'||!Number.isSafeInteger(value.size)){
   if(!api.bearer)await api.credentials();
   const response=await api.fetch(api.origin+ref+'&meta=1',{headers:{authorization:'Bearer '+api.bearer},redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw fault('无法读取队列附件信息，请稍后重试',response.status,'ATTACHMENT_UNAVAILABLE');value=await response.json();
  }
  if(value?.id!==id||typeof value.name!=='string'||!value.name||!/^image\/(png|jpeg|gif|webp)$/.test(value.mime||'')||!Number.isSafeInteger(value.size)||value.size<1||value.size>8*1024*1024)throw fault('队列附件信息不完整，无法退回编辑',409,'INVALID_ATTACHMENT');
  return{ref,fileName:value.name,mime:value.mime,bytes:value.size};
 }
 async function restoredItem(page,item){
  if(item.files?.length||item.fileCount>0)throw fault('此消息包含文件引用，手机端暂不能完整恢复编辑，请在电脑端处理',409,'QUEUE_FILES_UNSUPPORTED');
  return{text:item.text||'',attachments:await Promise.all((item.attachments||[]).map(id=>attachmentDescriptor(page,id)))};
 }
 async function queueResponse(page){
  const queue=nativeQueue(page),items=[];
  for(const item of queue.items)items.push({...Object.fromEntries(['id','requestId','status','createdAt','updatedAt','error','model','effort'].filter(k=>item[k]!==undefined).map(k=>[k,item[k]])),text:item.text||'',attachments:await Promise.all((item.attachments||[]).map(id=>attachmentDescriptor(page,id))),fileCount:Math.max(Array.isArray(item.files)?item.files.length:0,Number.isSafeInteger(item.fileCount)?item.fileCount:0)});
  return{threadId:queue.threadId,items,paused:queue.paused===true,error:queue.error||null};
 }
 let threadsPending,threadsAt=0;
 async function threads(force=false){
  if(!force&&threadsPending&&Date.now()-threadsAt<1500)return threadsPending;
  threadsAt=Date.now();const pending=(async()=>{
   const data=[],seen=new Set();let cursor;
   for(let i=0;i<200;i++){
    const page=await api.get('/api/threads'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
    for(const thread of page.data||[])if(!seen.has(thread.id)){seen.add(thread.id);data.push(thread);}
    if(!page.nextCursor)return data;
    if(page.nextCursor===cursor)throw fault('会话列表游标异常',503);
    cursor=page.nextCursor;
   }
   throw fault('会话列表过长，请缩小范围',503);
  })();threadsPending=pending;pending.catch(()=>{if(threadsPending===pending)threadsPending=null;});return pending;
 }
 async function workspaceForThread(id){const page=await historyForThread(id);if(page.thread.archived)throw fault('会话已归档',409,'THREAD_ARCHIVED');return page.thread.cwd;}
 async function write(type,data){
  requestId(data.requestId);
  const cwd=type==='createSession'?(data.cwd??conversationWorkspacePath):await workspaceForThread(data.threadId);
  workspacePath(cwd);
  if(data.model!==undefined&&typeof data.model!=='string'||data.effort!==undefined&&typeof data.effort!=='string')throw fault('模型选择无效');
  const selection=data.model?{providerId:'codex-app',modelId:data.model,...(data.effort?{options:{reasoningLevel:data.effort}}:{})}:undefined;
  const request={workspacePath:cwd,...(type==='createSession'&&data.projectId?{projectId:data.projectId}:{}),envelope:{commandId:'mobile_'+data.requestId,clientId:'codex-light-phone',issuedAt:0,sessionId:type==='createSession'?null:data.threadId,type,
   ...(type==='createSession'&&typeof data.name==='string'?{mobileTitle:data.name.trim().slice(0,80)}:{}),
   payload:Object.values(queueTypes).includes(type)?(type==='setAutoDrain'?{autoDrain:data.action==='resume'}:{queueItemId:data.id,...(type==='editQueueItem'?{newText:data.text}:{})}):type==='createSession'?{workspaceId:cwd,config:{...(selection?{modelSelection:selection}:{}),mode:'build'}}:{text:data.text??'',...(data.attachments!==undefined?{attachments:data.attachments}:{}),...(selection?{modelSelection:selection}:{})}}};
  const result=await writes.channels['zcode-agent'].sendConversationCommandV4(request);
  if(result==='unknown'){
   const record=await writes.ledger.status({workspacePath:cwd,commandId:request.envelope.commandId});
   throw unknown(record?.nativeId);
  }
  if(!['accepted','duplicate'].includes(result.status))throw Object.assign(Error(result.message||'操作未完成，请刷新会话后重试'),{statusCode:409,code:result.reasonCode||result.status,sent:false});
  threadsPending=null;
  const nativeId=type==='createSession'?result.result?.sessionId:data.threadId;
  const record=await writes.ledger.status({workspacePath:cwd,commandId:request.envelope.commandId});
  return type==='createSession'?{thread:{id:nativeId,cwd,name:data.name||'新会话'}}:{turn:{id:record?.nativeTurnId||undefined},accepted:true,delivery:result.result?.delivery,inputId:result.result?.inputId};
 }
 async function queueWrite(data){
  requestId(data.requestId);const type=Object.hasOwn(queueTypes,data.action)?queueTypes[data.action]:null;
  if(!type)throw fault('不支持的队列操作');
  if(!['resume','pause'].includes(data.action)&&(typeof data.id!=='string'||!data.id||data.id.length>256))throw fault('缺少队列消息编号');
  if(data.action==='edit'&&(typeof data.text!=='string'||Buffer.byteLength(data.text)>128*1024))throw fault('队列文本无效');
  const page=await historyForThread(data.threadId),queue=nativeQueue(page);
  if(page.thread.archived)throw fault('会话已归档',409,'THREAD_ARCHIVED');
  let restored;
  if(data.action==='delete'){
   // Persist recovery before removal. Read/metadata failures do not reserve the
   // mutation ID; a corrected transient failure remains safe to retry.
   const identity={workspacePath:page.thread.cwd,commandId:'mobile:restore:'+data.requestId},payload={threadId:data.threadId,id:data.id};
   let record=await writes.ledger.status(identity);
   if(record&&record.fingerprint!==digest(payload))throw fault('同一操作编号不能更换队列消息',409,'COMMAND_ID_COLLISION');
   if(!record){
    const item=queue.items.find(item=>item.id===data.id);
    if(!item)throw fault('队列消息不存在或已发送',404,'QUEUE_ITEM_MISSING');
    const value=await restoredItem(page,item);
    record=(await writes.ledger.execute(identity,payload,async({checkpoint})=>{await checkpoint({state:'complete',restored:value,sourceDigest:digest({text:item.text||'',attachments:item.attachments||[],files:item.files||[]})});})).record;
   }
   if(record.state!=='complete')throw fault('附件退回结果待核对',409,'ATTACHMENT_UNAVAILABLE');
   const current=queue.items.find(item=>item.id===data.id);
   if(current&&record.sourceDigest!==digest({text:current.text||'',attachments:current.attachments||[],files:current.files||[]}))throw fault('队列内容已变化，请刷新后重新操作',409,'QUEUE_ITEM_CHANGED');
   restored=record.restored;
  }
  const result=await write(type,data);return{...result,...(restored?{restored}:{})};
 }
 async function archive(data){
  requestId(data.requestId);const page=await historyForThread(data.threadId),identity={workspacePath:page.thread.cwd,commandId:'mobile:archive:'+data.requestId};
  const prior=await writes.ledger.status(identity);
  if(prior&&prior.fingerprint!==digest({threadId:data.threadId}))throw fault('同一操作编号不能更换会话',409,'COMMAND_ID_COLLISION');
  if(prior?.state==='complete'&&prior.result?.archived&&prior.result?.verified)return prior.result;
  const verify=value=>{if(value?.threadId!==data.threadId||value.requestId!==data.requestId)throw unknown(data.threadId);return value;};
  if(prior){
   const result=verify(await api.get('/api/thread/archive/status?'+new URLSearchParams({threadId:data.threadId,requestId:data.requestId})));
   if(result.archived&&result.verified)await writes.ledger.save({...prior,state:'complete',result});return result;
  }
  if(page.activeTurn||['active','running','inProgress'].includes(page.thread.status?.type)||nativeQueue(page).items.length)throw fault('请先停止任务并清空发送队列再归档',409,'THREAD_BUSY');
  try{
   const result=await writes.ledger.execute(identity,{threadId:data.threadId},async({checkpoint})=>{
    await checkpoint({state:'dispatched'});const result=verify(await api.post('/api/thread/archive',{threadId:data.threadId,requestId:data.requestId}));await checkpoint({state:'complete',result});
   });
   if(!result.record.result)throw unknown(data.threadId);threadsPending=null;return result.record.result;
  }catch(error){if(error.sent===false)throw error;throw unknown(data.threadId);}
 }
 return async function handle(req,res,url){
  try{
   const path=url.pathname;
   if(req.method==='GET'&&path==='/mobile/api/bootstrap'){
    const [projects,models,status]=await Promise.all([api.get('/api/projects'),api.get('/api/models'),api.get('/api/status')]);
    return json(res,200,{projects:projects.projects||[],models:models.data||[],cwd:conversationWorkspacePath||status.cwd,status:{online:status.online===true,desktopOnline:status.desktopOnline===true}});
   }
   if(req.method==='GET'&&path==='/mobile/api/skills'){
    const cwd=url.searchParams.get('cwd')||conversationWorkspacePath;await authorizeWorkspace(cwd);
    const result=await api.get('/api/skills?cwd='+encodeURIComponent(cwd));
    return json(res,200,{data:(result.data||[]).filter(s=>s.enabled!==false&&typeof s.name==='string'&&typeof s.path==='string').map(s=>({name:s.name,path:s.path,description:typeof s.description==='string'?s.description:''}))});
   }
   if(req.method==='GET'&&path==='/mobile/api/queue')return json(res,200,await queueResponse(await historyForThread(url.searchParams.get('threadId'))));
   if(req.method==='POST'&&path==='/mobile/api/queue')return json(res,200,await queueWrite(await body(req)));
   if(req.method==='POST'&&path==='/mobile/api/upload'){
    const {action,...params}=await body(req,800*1024),methods={begin:'attachmentBeginV4',chunk:'attachmentChunkV4',commit:'attachmentCommitV4',abort:'attachmentAbortV4'};
    if(!Object.hasOwn(methods,action))throw fault('不支持的上传操作');
    if(typeof uploads?.[methods[action]]!=='function')throw fault('上传服务尚未就绪',503,'ATTACHMENT_UNAVAILABLE');
    return json(res,200,await uploads[methods[action]](params));
   }
   if(req.method==='POST'&&path==='/mobile/api/archive'){
    const result=await archive(await body(req));
    const verified=result.archived===true&&result.verified===true,status=verified?200:result.pending===true?202:409;
    return json(res,status,{...result,...(!verified&&!result.pending?{error:result.message||'归档结果尚未确认，请沿用原操作编号核对',code:result.blocked||result.status==='blocked'?'ARCHIVE_BLOCKED':'ARCHIVE_UNVERIFIED'}:{})});
   }
   if(req.method==='GET'&&path==='/mobile/api/threads'){
    const cwd=url.searchParams.get('cwd'),data=await threads(url.searchParams.has('refresh'));
    return json(res,200,{data:data.filter(t=>!cwd||t.cwd===cwd).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)),nextCursor:null});
   }
   if(req.method==='GET'&&path==='/mobile/api/changes'){
    const id=threadId(url.searchParams.get('threadId')),since=Number(url.searchParams.get('since')||0);
    if(!Number.isSafeInteger(since)||since<0)throw fault('事件游标无效');
    const controller=new AbortController(),closed=()=>controller.abort();res.once('close',closed);
    let page;try{page=await api.get('/api/events?since='+since+'&wait=1',{signal:controller.signal});}finally{res.off('close',closed);}
    if(res.destroyed)return;
    const changed=!!page.reset||(page.events||[]).some(event=>event.params?.threadId===id||['bridge/desktopOnline','bridge/desktopOffline'].includes(event.method));
    return json(res,200,{sequence:page.sequence,epoch:page.epoch,changed});
   }
   if(req.method==='GET'&&path==='/mobile/api/history'){
    const id=threadId(url.searchParams.get('threadId')),cursor=url.searchParams.get('cursor');
    if(cursor&&cursor.length>4000)throw fault('历史游标无效');
    const page=await api.get('/api/history?threadId='+encodeURIComponent(id)+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    if(page.thread?.id!==id)throw fault('会话编号不一致',403);
    const since=url.searchParams.get('since');if(since&&since.length>160)throw fault('历史版本无效');
    return json(res,200,historyResponse(page,{cursor,since}));
   }
   if(req.method==='GET'&&path==='/mobile/api/image'){
    const controller=new AbortController(),closed=()=>{if(!res.writableFinished)controller.abort(fault('图片请求已结束',499,'IMAGE_CANCELLED'));};
    const timer=setTimeout(()=>controller.abort(fault('图片读取超时，请重试',504,'MOBILE_IMAGE_TIMEOUT')),imageTimeoutMs);
    let rejectAbort,stopIdle=()=>{};const aborted=new Promise((_,reject)=>{rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true});});
    res.once('close',closed);
    try{return await Promise.race([aborted,(async()=>{
     const signal=controller.signal,id=threadId(url.searchParams.get('threadId')),cursor=url.searchParams.get('cursor');
     if(cursor&&cursor.length>4000)throw fault('历史游标无效');
     const page=await imageHistory('/api/history?threadId='+encodeURIComponent(id)+(cursor?'&cursor='+encodeURIComponent(cursor):''),signal);signal.throwIfAborted();
     const query=new URLSearchParams(url.searchParams);const preview=query.get('preview')==='1';if(query.has('preview')&&(query.getAll('preview').length!==1||!preview))throw fault('图片预览参数无效');query.delete('preview');
     const resource=resolveMobileImagePath(page,query);
     if(!api.bearer)await api.credentials();signal.throwIfAborted();
     const upstream=await api.fetch(api.origin+resource,{headers:{authorization:'Bearer '+api.bearer},redirect:'error',signal});signal.throwIfAborted();
     if(!upstream.ok)throw fault('图片暂时无法读取',upstream.status);
     const contentType=upstream.headers.get('content-type')||'';
     if(!/^image\/(png|jpeg|gif|webp|avif|bmp)(?:;|$)/i.test(contentType))throw fault('不支持此图片格式',415);
     const length=Number(upstream.headers.get('content-length'));
     if(preview&&length<=20*1024*1024){
      // Chunked responses have no Content-Length. Still produce their preview,
      // with a strict buffer budget rather than silently forwarding the original.
      const chunks=[];let bytes=0;
      for await(const chunk of upstream.body){signal.throwIfAborted();bytes+=chunk.length;if(bytes>20*1024*1024)throw fault('图片超过预览大小限制',413,'MOBILE_IMAGE_TOO_LARGE');chunks.push(chunk);}
      signal.throwIfAborted();const value=await imagePreview(Buffer.concat(chunks,bytes),contentType);signal.throwIfAborted();
      res.writeHead(200,{'content-type':value.contentType,'content-length':value.bytes.length,'cache-control':'private, max-age=300','x-content-type-options':'nosniff'});res.end(value.bytes);return;
     }
     // Original-image delivery can legitimately take longer on a slow phone.
     // Bound idle time after headers, rather than the total download duration.
     clearTimeout(timer);
     // Node's socket idle timer also observes native write-queue progress, so
     // even one large write can keep progressing under downstream backpressure.
     const idle=()=>controller.abort(fault('图片传输暂时中断，请重试',504,'MOBILE_IMAGE_IDLE_TIMEOUT'));
     res.setTimeout(imageIdleTimeoutMs,idle);
     // HTTP owns the socket's keepalive timeout after finish; do not reset it.
     stopIdle=()=>res.off('timeout',idle);
     res.writeHead(200,{'content-type':contentType,'cache-control':'private, max-age=300','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
     try{await pipeline(Readable.fromWeb(upstream.body),res,{signal});}finally{stopIdle();}
    })()]);}finally{clearTimeout(timer);stopIdle();res.off('close',closed);controller.signal.removeEventListener('abort',rejectAbort);if(!res.writableEnded&&!controller.signal.aborted)controller.abort();}
   }
   if(req.method==='POST'&&['/mobile/api/create','/mobile/api/message'].includes(path))return json(res,200,await write(path.endsWith('/create')?'createSession':'sendText',await body(req)));
   return json(res,404,{error:'没有这个手机接口'});
  }catch(error){
   if(res.destroyed||res.writableEnded)return;
   if(res.headersSent){res.destroy();return;}
   const status=error.statusCode||(error.outcomeUnknown||['NATIVE_OUTCOME_UNKNOWN','COMMAND_ID_COLLISION','COMMAND_LOCKED','CODEX_ATTACHMENT_CONFLICT'].includes(error.code)?409:error.code==='CODEX_ATTACHMENT_SCOPE'?403:error.code==='CODEX_ATTACHMENT_NOT_FOUND'||error.code==='QUEUE_ITEM_MISSING'?404:error.code==='CODEX_ATTACHMENT_BUSY'?429:400);
   return json(res,status,{error:error.message,code:error.code||'MOBILE_OPERATION_FAILED',...(error.sent===false?{sent:false}:{}),...(error.outcomeUnknown?{outcomeUnknown:true}:{}),...((error.threadId||error.nativeId)?{threadId:error.threadId||error.nativeId,recoverable:true}:{})});
  }
 };
}
