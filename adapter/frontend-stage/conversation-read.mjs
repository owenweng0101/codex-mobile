import {createHash,randomUUID} from 'node:crypto';
import {Emitter} from '../vendor/rpc.mjs';
import {M as snapshotSchema,u as indexSnapshotSchema} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/validation-B6yV_dPD.js';
import {w as frameSchema,O as indexFrameSchema} from '../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js';
import {projectMobileHistory,resolveMobileImagePath,projectAssistantText} from '../mobile-history.mjs';
import {createImagePreview} from '../mobile-image.mjs';
const unavailable=method=>Object.assign(new Error('Codex 只读适配器未开放 '+method),{code:'CODEX_READ_ONLY_METHOD_UNAVAILABLE'});
const denied={allowed:false,reasonCode:'codex.adapter.readOnly'};
const time=v=>Number.isFinite(v)?v<1e11?Math.round(v*1000):Math.round(v):0;
function imageKey(value){
 const reference=value?.reference;
 if(reference)return JSON.stringify([reference.threadId,reference.turnId,reference.itemId,String(reference.index)]);
 const source=value?.url??value?.ref;if(typeof source!=='string'||!source.startsWith('/'))return null;
 try{const params=new URL(source,'http://codex.invalid').searchParams;if(params.has('attachmentId')||params.has('id'))return'attachment:'+(params.get('attachmentId')||params.get('id'));if(['threadId','turnId','itemId','index'].every(key=>params.has(key)))return JSON.stringify(['threadId','turnId','itemId','index'].map(key=>params.get(key)));}catch{}
 return null;
}
const text=(item,images=[])=>{const represented=new Set(images.map(imageKey).filter(Boolean));return(item.content||[]).map(x=>x.type==='text'?x.text||'':represented.has(imageKey(x))?'':['image','localImage','local_image'].includes(x.type)?'[图片]':x.type==='attachment'?'[附件：'+(x.name||'文件')+']':'').filter(Boolean).join('\n');};
function itemImages(page,turn,item){
 // Reuse the image proxy's exact native-reference validation. Rows carry only
 // a same-origin authenticated URL, never image bytes or a local file path.
 return projectMobileHistory({thread:page.thread,turns:[{id:turn.id,items:[item.phase==='commentary'?{...item,phase:undefined}:item]}]},{cursor:page.imageCursors?.[turn.id]}).messages.flatMap(message=>message.images);
}
const attachmentName=(name,index)=>typeof name==='string'&&name.split(/[\\/]/).at(-1)?.trim()?name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f]/g,'').slice(0,150):'图片 '+(index+1);
const phase=turn=>turn?.status==='inProgress'?'running':turn?.status==='failed'?'error':turn?.status==='interrupted'?'completedInterrupted':turn?.status==='completed'?'completedSuccess':'draft';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const stateKeys=new Set(Object.keys(frameSchema.shape.payload.options.find(option=>option.shape.deltas).shape.deltas.element.options.find(option=>option.shape.op.value==='state.updated').shape.patch.shape));
function conversationDeltas(previous,next){
 const before=previous.rows.window,after=next.rows.window;
 if(next.rows.firstRowId!==previous.rows.firstRowId||after.length<before.length||next.rows.totalCount-previous.rows.totalCount!==after.length-before.length)return null;
 const deltas=[],patch={};
 for(let index=0;index<before.length;index++){
  const old=before[index],row=after[index];
  if(old.rowId!==row.rowId||old.entityId!==row.entityId||old.kind!==row.kind||old.turnId!==row.turnId)return null;
  if(same(old,row))continue;
  if(typeof old.text==='string'&&typeof row.text==='string'&&row.text.startsWith(old.text)&&same({...old,text:''},{...row,text:''}))deltas.push({op:'row.delta',rowId:row.rowId,path:'text',append:row.text.slice(old.text.length)});
  else deltas.push({op:'row.upserted',row});
 }
 for(const row of after.slice(before.length))deltas.push({op:'row.appended',row});
 for(const key of new Set([...Object.keys(previous),...Object.keys(next)])){
  if(['rows','seq','revision'].includes(key)||same(previous[key],next[key]))continue;
  if(!stateKeys.has(key)||next[key]===undefined)return null;
  patch[key]=next[key];
 }
 if(!deltas.length&&!Object.keys(patch).length)return [];
 deltas.push({op:'state.updated',patch:{...patch,revision:next.revision}});
 return deltas;
}
/** Protocol translation only. Original UI, logical frame validation and replay
 * remain original ZCode code. No model/command execution is reachable here. */
export function projectConversationV4(page,{logEpoch='codex-'+hash(page),seq=0,writable=false,selection=null}={}){
 const thread=page.thread,rows=[];let rowId=0;
 for(const turn of page.turns||[]){
  const createdAt=time(turn.startedAt),state=phase(turn);
  const common=()=>({rowId:++rowId,turnId:turn.id,createdAt,createdAtSeq:0});
  if(Number.isFinite(turn.startedAt)&&turn.startedAt>0&&['running','error','completedInterrupted','completedSuccess'].includes(state)){
   const startedAt=time(turn.startedAt),endedAt=time(turn.completedAt??turn.endedAt);
   rows.push({...common(),kind:'turnHeader',entityId:'turn-header:'+turn.id,origin:(turn.items||[]).some(item=>item.type==='userMessage')?'userInput':'backgroundResult',executionKind:'agent',state:state==='error'?'failed':state,startedAt,...(state!=='running'?{...(endedAt>=startedAt?{endedAt}:{}),...(Number.isFinite(turn.durationMs)&&turn.durationMs>=0?{activeMs:turn.durationMs}:{})}:{})});
  }
  // A native turn is not necessarily a fresh user request (background turns
  // exist). Preserve only native message/item rows rather than invent headers.
  for(const item of turn.items||[]){
   if(item.type==='userMessage'){
    const images=itemImages(page,turn,item),attachments=images.map((image,index)=>({ref:image.url,fileName:attachmentName(image.name,index),mime:'image/*',bytes:0}));
    // Original V4 requires mime/bytes. A generic image MIME and zero denote
    // unknown metadata; the authenticated image response supplies its real type.
    rows.push({...common(),kind:'userInput',entityId:item.id,origin:'realUser',text:text(item,images),...(attachments.length?{attachments}:{})});
   }
   else if(item.type==='agentMessage'||item.type==='plan')rows.push({...common(),kind:'assistantText',entityId:item.id,text:projectAssistantText(item,itemImages(page,turn,item)),state:state==='running'?'streaming':state==='completedInterrupted'?'interrupted':state==='error'&&item.phase!=='commentary'?'failed':'complete',...(thread.model?{model:thread.model}:{})});
   else if(item.type==='reasoning'){
    const value=(item.summary||[]).map(x=>typeof x==='string'?x:x.text||'').filter(Boolean).join('\n');
    if(value)rows.push({...common(),kind:'reasoning',entityId:item.id,text:value,state:state==='running'?'streaming':state==='completedInterrupted'?'interrupted':'complete'});
   }else if(item.type==='imageGeneration'){
    const images=itemImages(page,turn,item);
    if(images.length)rows.push({...common(),kind:'assistantText',entityId:item.id,text:images.map(image=>'![生成的图片]('+image.url+')').join('\n\n'),state:state==='running'?'streaming':state==='completedInterrupted'?'interrupted':state==='error'?'failed':'complete'});
   }else if(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','collabAgentToolCall','contextCompaction'].includes(item.type)){
    if(!['inProgress','completed','failed','declined'].includes(item.status))continue;
    const input=item.type==='commandExecution'?{command:item.command||'',...(item.cwd?{cwd:item.cwd}:{})}:item.type==='fileChange'?{paths:(item.changes||[]).map(x=>x.path)}:item.arguments??item.input??{};
    const output=item.type==='commandExecution'?item.aggregatedOutput:item.type==='fileChange'?(item.changes||[]).map(x=>x.diff||'').join('\n'):undefined;
    rows.push({...common(),kind:'toolCall',entityId:item.id,toolCallId:item.id,toolName:item.tool||(item.type==='commandExecution'?'shell':item.type),input,inputText:JSON.stringify(input),status:item.status==='inProgress'?'running':item.status==='failed'||(item.type==='commandExecution'&&Number.isInteger(item.exitCode)&&item.exitCode!==0)?'error':item.status==='declined'?'cancelled':'success',...(typeof output==='string'?{output:{text:output}}:{})});
   }
  }
 }
 const last=page.turns?.at(-1),currentPhase=phase(last);
 const snapshot={protocolVersion:1,sessionId:thread.id,logEpoch,seq,revision:seq,
  control:{phase:currentPhase,sessionEnded:false,canStop:false,stopState:'idle',stopTargetKind:'unknown',activeWorks:[],lastError:null,apiRetry:null},
  availability:Object.fromEntries(['fork','compact','switchModelConfig','setFollowupMode','queueEdit','sendQueuedNow','pauseGoal','resumeGoal'].map(k=>[k,writable&&['switchModelConfig','queueEdit','sendQueuedNow'].includes(k)?{allowed:true}:denied])),
  inputRouting:writable?{mode:page.activeTurn?'guide':page.queue?.items?.length?'enqueue':'startNow'}:{mode:'reject',reasonCode:'codex.adapter.readOnly'},meta:{title:thread.name||thread.preview||'',titleSource:thread.name?'custom':'default'},
  config:{provider:'codex-app',model:selection?.model||page.settings?.model||thread.model||'',thought:selection?.effort||page.settings?.effort||thread.reasoningEffort||'',...((selection?.model||page.settings?.model||thread.model)?{modelSelection:{providerId:'codex-app',modelId:selection?.model||page.settings?.model||thread.model,...((selection?.effort||page.settings?.effort||thread.reasoningEffort)?{options:{reasoningLevel:selection?.effort||page.settings?.effort||thread.reasoningEffort}}:{})}}:{}),thoughtLevels:[],followupMode:'guide',mode:'build'},
  // Context use is unavailable through this bridge. These cumulative counters
  // are only adapter-local (zero); never advertise native token accounting.
  usage:{contextWindow:null,cumulative:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}},
  queue:{items:(page.queue?.items||[]).map((item,index)=>({sourceCommandId:item.requestId||item.id,queueItemId:item.id,clientId:'codex-mobile',kind:'sendText',text:item.text||'',...(item.attachments?.length?{attachments:item.attachments.map((id,index)=>({ref:'/api/attachment?id='+id,fileName:attachmentName(null,index),mime:'image/*',bytes:0}))}:{}),delivery:{requested:'auto',admitted:writable&&!page.queue?.paused&&/^zcv4_[a-f0-9]{48}$/.test(item.id||'')&&['queued','sending'].includes(item.status)?'guide':'queue'},order:{admissionSeq:index},steer:{state:'notRequested'},dispatch:{state:item.status==='sending'?'promoting':'queued'},admittedAt:time(item.createdAt)})),autoDrain:!page.queue?.paused,...(page.queue?.paused?{pauseReason:page.queue.error?'error':'manual'}:{})},pendingInteractions:[],pendingCommands:[],backgroundWorks:[],goal:null,plan:null,
  rows:{window:rows,totalCount:rows.length,firstRowId:rows[0]?.rowId??null}};
 return snapshotSchema.parse(snapshot);
}
export function createConversationReadServices({api,baseServices,maxHistoryPages=30,eventAdapter,writable=false,modelSelections,resolveAttachment,deferInitialFrame=false}={}){
 if(!api?.get||!baseServices?.project?.readTree)throw Error('Conversation read adapter needs scoped read services');
 const subscriptions=new Map(),emitters=new Map();let disposed=false;
 const getEmitter=(kind,p)=>{const key=kind+':'+p.workspacePath;if(!emitters.has(key))emitters.set(key,new Emitter());return emitters.get(key);};
 async function scope(p,session=false){
  if(!p||typeof p.workspacePath!=='string'||p.workspaceIdentity||p.remoteSessionId)throw unavailable('remote workspace');
  const tree=await baseServices.project.readTree(),known=tree.conversationWorkspacePath===p.workspacePath||tree.tasks.some(t=>t.workspacePath===p.workspacePath)||(tree.projects||[]).some(x=>(x.roots||[]).some(r=>r.rootPath===p.workspacePath));
  if(!known)throw unavailable('workspace outside Codex catalog');
  if(session&&!tree.tasks.some(t=>t.taskId===p.sessionId&&t.workspacePath===p.workspacePath)){
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.sessionId||''))throw unavailable('invalid conversation');
   const page=await api.get('/api/history?threadId='+encodeURIComponent(p.sessionId));
   if(page.thread?.id!==p.sessionId||page.thread.cwd!==p.workspacePath)throw unavailable('conversation outside selected workspace');
  }
  return tree;
 }
 // Cursor-addressed history pages are immutable once read; only the newest
 // (first) page must stay fresh. Caching older pages keeps refresh/resync from
 // re-reading the whole thread after every change event.
 const historyPages=new Map();
 async function history(p){
  await scope(p,true);const page=await api.get('/api/history?threadId='+encodeURIComponent(p.sessionId));
  if(page.thread?.id!==p.sessionId||page.thread.cwd!==p.workspacePath)throw unavailable('conversation scope mismatch');
  let store=historyPages.get(p.sessionId);
  if(!store){store=new Map();historyPages.set(p.sessionId,store);while(historyPages.size>8)historyPages.delete(historyPages.keys().next().value);}
  const verify=value=>{if(value.thread?.id!==p.sessionId||value.thread.cwd!==p.workspacePath)throw unavailable('history scope mismatch');return value;};
  const turns=[...page.turns||[]],seen=new Set(turns.map(t=>t.id)),imageCursors=Object.fromEntries(turns.map(turn=>[turn.id,null]));let cursor=page.nextCursor,reads=1;
  while(cursor){
   if(reads++>=maxHistoryPages)throw Object.assign(new Error('历史超过只读适配器分页上限'),{code:'CODEX_HISTORY_LIMIT'});
   let older=store.get(cursor);
   if(!older){older=verify(await api.get('/api/history?threadId='+encodeURIComponent(p.sessionId)+'&cursor='+encodeURIComponent(cursor)));store.set(cursor,older);}
   const fresh=(older.turns||[]).filter(t=>!seen.has(t.id));for(const t of fresh){seen.add(t.id);imageCursors[t.id]=cursor;}turns.unshift(...fresh);
   if(older.nextCursor===cursor)throw Error('Codex history cursor did not advance');cursor=older.nextCursor;
  }
  return {...page,turns,nextCursor:null,imageCursors};
 }
 // Original H5 renders user-message images through attachmentReadV4 chunked
 // reads ({dataBase64,totalBytes,mediaType,nextOffset}); it never fetches the
 // attachment ref itself. Bytes come from the same validated image proxy the
 // lightweight page uses, compressed once per ref and cached for the chunks.
 const mediaCache=new Map();
 async function attachmentResource(p){
  if(typeof p?.ref!=='string')throw unavailable('attachment ref');
  let backendPath;
  if(/^\/api\/attachment\?id=[a-f0-9]{48}$/.test(p.ref)){
   await scope(p,true);
   if(typeof resolveAttachment!=='function')throw unavailable('attachment resolver');
   const metadata=await resolveAttachment({workspacePath:p.workspacePath,sessionId:p.sessionId,ref:p.ref});
   if(metadata?.id!==p.ref.slice('/api/attachment?id='.length))throw Object.assign(new Error('附件不属于当前工作区'),{code:'CODEX_ATTACHMENT_SCOPE'});
   backendPath=p.ref;
  }else{
   let url;try{url=new URL(p.ref,'http://codex.invalid');}catch{throw unavailable('attachment ref');}
   if(url.origin!=='http://codex.invalid'||url.pathname!=='/mobile/api/image'||url.hash)throw unavailable('attachment ref');
   const params=url.searchParams,cursor=params.get('cursor');
   const expected=[...(params.has('attachmentId')?['threadId','attachmentId']:['threadId','turnId','itemId','index']),...(params.has('cursor')?['cursor']:[])];
   if([...params.keys()].length!==expected.length||!expected.every(key=>params.getAll(key).length===1))throw unavailable('attachment ref');
   if(params.get('threadId')!==p.sessionId)throw Object.assign(new Error('附件不属于当前会话'),{code:'CODEX_ATTACHMENT_SCOPE'});
   await scope(p,true);
   const cached=mediaCache.get(p.ref);if(cached)return cached;
   const page=await api.get('/api/history?threadId='+encodeURIComponent(p.sessionId)+(cursor?'&cursor='+encodeURIComponent(cursor):''));
   backendPath=resolveMobileImagePath(page,params);
  }
  // Cached uploaded bytes never bypass the per-request scope/ref authorization.
  const cached=mediaCache.get(p.ref);if(cached)return cached;
  if(!api.bearer)await api.credentials();
  const upstream=await api.fetch(api.origin+backendPath,{headers:{authorization:'Bearer '+api.bearer},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!upstream.ok)throw Object.assign(new Error('图片暂时无法读取'),{code:'CODEX_MEDIA_UNAVAILABLE'});
  const contentType=(upstream.headers.get('content-type')||'').split(';')[0].trim();
  if(!/^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(contentType))throw Object.assign(new Error('不支持此图片格式'),{code:'CODEX_MEDIA_TYPE'});
  const raw=Buffer.from(await upstream.arrayBuffer());
  const preview=raw.length>128*1024?await createImagePreview(raw,contentType):{bytes:raw,contentType};
  const entry={bytes:preview.bytes,mediaType:String(preview.contentType||contentType).split(';')[0]};
  mediaCache.set(p.ref,entry);while(mediaCache.size>16)mediaCache.delete(mediaCache.keys().next().value);
  return entry;
 }
 async function build(record){
  if(record.kind==='conversation'){const page=await history(record.params);record.fingerprint=hash({turns:page.turns,activeTurn:page.activeTurn||null});return projectConversationV4(page,{logEpoch:record.logEpoch,seq:record.seq+1,writable,selection:await modelSelections?.get(record.params.workspacePath,record.params.sessionId)});}
  const tree=await scope(record.params),tasks=tree.tasks.filter(t=>t.workspacePath===record.params.workspacePath);
  return indexSnapshotSchema.parse({protocolVersion:1,workspaceId:record.params.workspacePath,logEpoch:record.logEpoch,sessions:tasks.map(t=>({sessionId:t.taskId,workspaceId:t.workspacePath,title:t.title,titleSource:t.titleOverridden?'custom':'default',phase:t.status==='running'?'running':t.status==='error'?'error':t.status==='completed'?'completedSuccess':'draft',sessionEnded:false,hasBackgroundWork:false,createdAt:t.createdAt,lastActivityAt:t.updatedAt}))});
 }
 async function publishNow(record,forceSnapshot=false){
  const snapshot=await build(record);if(disposed||!subscriptions.has(record.id))return;
  if(record.kind==='conversation'&&record.firstRetainedRowId==null)record.firstRetainedRowId=snapshot.rows.window.slice(-60)[0]?.rowId??null;
  const visible=record.kind==='conversation'?{...snapshot,rows:{...snapshot.rows,window:record.firstRetainedRowId==null?snapshot.rows.window.slice(-60):snapshot.rows.window.filter(row=>row.rowId>=record.firstRetainedRowId)}}:snapshot;
  const deltas=!forceSnapshot&&record.sent&&record.kind==='conversation'?conversationDeltas(record.sent,visible):null;
  if(deltas?.length===0)return;
  if(record.kind==='index'&&!forceSnapshot&&same(record.sent,visible))return;
  const nextSeq=record.seq+1;
  const logical={topic:record.topic,subscriptionId:record.id,fromSeq:deltas?record.seq:0,toSeq:nextSeq,sentAt:Date.now(),payload:deltas?{kind:'deltas',deltas}:{kind:'snapshot',snapshot:visible}};
  (record.kind==='conversation'?frameSchema:indexFrameSchema).parse(logical);
  record.seq=nextSeq;record.snapshot=snapshot;record.sent=visible;record.lastPublishedAt=Date.now();
  const wire={wireVersion:3,kind:'complete',deliveryKind:record.ordinal===0?'initial':deltas?'online':'recovery',logicalFrameId:randomUUID(),logicalFrameOrdinal:++record.ordinal,topic:record.topic,subscriptionId:record.id,frame:logical};
  if(deferInitialFrame&&wire.deliveryKind==='initial'){
   record.initialTimer=setTimeout(()=>{record.initialTimer=null;if(!disposed&&subscriptions.has(record.id))getEmitter(record.kind,record.params).fire(wire);},100);
  }else getEmitter(record.kind,record.params).fire(wire);
 }
 function publish(record,forceSnapshot=false){
  const pending=(record.serial||Promise.resolve()).then(()=>publishNow(record,forceSnapshot));
  record.serial=pending.catch(()=>{});return pending;
 }
 async function subscribe(kind,p){
  await scope(p,kind==='conversation');if(eventAdapter?.pollNow)await eventAdapter.pollNow();
  const id=randomUUID(),record={id,kind,params:{...p},logEpoch:'codex-'+randomUUID(),seq:0,ordinal:0,topic:kind==='conversation'?'conversation/'+p.sessionId:'sessions-index/'+p.workspacePath};
  subscriptions.set(id,record);
  try{
   if(kind==='conversation')record.nativeListener=baseServices['zcode-task'].onDynamicTaskEvent({taskId:p.sessionId,workspacePath:p.workspacePath})(()=>refresh(record));
   else if(eventAdapter?.changes)record.nativeListener=eventAdapter.changes(()=>refresh(record));
   // Publish before ACK is supported by the original activation buffer.
   await publish(record,true);return{ack:{subscriptionId:id,mode:'snapshot',logEpoch:record.logEpoch}};
  }catch(error){record.nativeListener?.dispose();subscriptions.delete(id);throw error;}
 }
 function refresh(record){
  if(disposed||!subscriptions.has(record.id))return Promise.resolve();
  record.dirty=true;
  if(!record.refreshPromise)record.refreshPromise=new Promise(resolve=>{record.resolveRefresh=resolve;});
  scheduleRefresh(record);return record.refreshPromise;
 }
 function scheduleRefresh(record){
  if(record.timer||record.refreshing||disposed||!subscriptions.has(record.id))return;
  record.timer=setTimeout(async()=>{
   record.timer=null;record.refreshing=true;
   try{
    await record.serial;
    if(disposed||!subscriptions.has(record.id))return;
    const remaining=1000-(Date.now()-(record.lastPublishedAt||0));
    if(remaining>0)return;
    record.dirty=false;await publish(record);
   }catch{}finally{
    record.refreshing=false;
    if(record.dirty&&!disposed&&subscriptions.has(record.id))scheduleRefresh(record);
    else{record.resolveRefresh?.();record.refreshPromise=null;record.resolveRefresh=null;}
   }
  },Math.max(0,1000-(Date.now()-(record.lastPublishedAt||0))));
 }
 function cancelRefresh(record){clearTimeout(record.initialTimer);clearTimeout(record.timer);record.timer=null;record.resolveRefresh?.();record.refreshPromise=null;record.resolveRefresh=null;}
 async function owned(p,kind){const r=subscriptions.get(p.subscriptionId);if(!r||r.kind!==kind||r.params.workspacePath!==p.workspacePath)throw unavailable('subscription not owned');await scope(p);return r;}
 async function resync(kind,p){const r=await owned(p,kind);await publish(r,true);return{ack:{subscriptionId:r.id,mode:'snapshot',logEpoch:r.logEpoch}};}
 async function unsubscribe(kind,p){const r=await owned(p,kind);r.nativeListener?.dispose();cancelRefresh(r);subscriptions.delete(r.id);}
 async function validateRevision(p){
  if(p.baseRevision===undefined&&p.baseLogEpoch===undefined)return true;
  if(p.baseRevision===0&&p.baseLogEpoch===undefined&&p.sessionId){const page=await history(p);if(!page.activeTurn&&!page.turns?.length)return true;}
  const r=[...subscriptions.values()].find(r=>r.kind==='conversation'&&r.params.workspacePath===p.workspacePath&&r.params.sessionId===p.sessionId&&(!p.baseLogEpoch||r.logEpoch===p.baseLogEpoch));
  if(!r?.snapshot||p.baseRevision!==undefined&&p.baseRevision!==r.snapshot.revision)return false;
  const page=await history(r.params);
  return r.fingerprint===hash({turns:page.turns,activeTurn:page.activeTurn||null});
 }
 async function refreshWorkspace(p){
  await Promise.all([...subscriptions.values()].filter(r=>r.params.workspacePath===p.workspacePath).map(r=>refresh(r)));
 }
 const methods={
  subscribeConversationV4:p=>subscribe('conversation',p),resyncConversationV4:p=>resync('conversation',p),unsubscribeConversationV4:p=>unsubscribe('conversation',p),onDynamicConversationFrame:p=>getEmitter('conversation',p).event,
  subscribeSessionsIndexV4:p=>subscribe('index',p),resyncSessionsIndexV4:p=>resync('index',p),unsubscribeSessionsIndexV4:p=>unsubscribe('index',p),onDynamicSessionsIndexFrame:p=>getEmitter('index',p).event,
  async conversationRowsRangeV4(p){await scope(p,true);const r=[...subscriptions.values()].find(x=>x.kind==='conversation'&&x.params.workspacePath===p.workspacePath&&x.params.sessionId===p.sessionId);if(!r?.snapshot)throw unavailable('unsubscribed rows range');const all=r.snapshot.rows.window,before=p.beforeRowId===undefined?all:all.filter(x=>x.rowId<p.beforeRowId),limit=Number.isInteger(p.limit)&&p.limit>0?Math.min(200,p.limit):60;const rows=before.slice(-limit);if(rows.length)r.firstRetainedRowId=Math.min(r.firstRetainedRowId??rows[0].rowId,rows[0].rowId);return{rows,atSeq:r.snapshot.seq,atRevision:r.snapshot.revision,atLogEpoch:r.logEpoch,hasMore:before.length>limit};},
  async attachmentReadV4(p){
   const resource=await attachmentResource(p),offset=p?.offset,limit=p?.limit;
   if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>4*1024*1024)throw unavailable('attachment range');
   if(offset>resource.bytes.length)throw unavailable('attachment range');
   const chunk=resource.bytes.subarray(offset,Math.min(offset+limit,resource.bytes.length)),next=offset+chunk.length;
   return{dataBase64:chunk.toString('base64'),totalBytes:resource.bytes.length,mediaType:resource.mediaType,nextOffset:next<resource.bytes.length?next:null};
  },
  async sendConversationCommandV4(p){throw unavailable('sendConversationCommandV4 '+(p?.envelope?.type||''));},
 };
 // Original UI subscribes optional telemetry events (e.g. local TTFT facts)
 // while opening a draft; a missing handler aborts that whole flow, so unknown
 // onDynamic* methods become never-firing subscriptions instead of errors.
 const noopEvent=()=>new Emitter().event;
 const agent=new Proxy(baseServices['zcode-agent']||{},{get(target,key,receiver){if(key in methods)return methods[key];if(typeof key==='string'&&key.startsWith('onDynamic'))return noopEvent;return Reflect.get(target,key,receiver);}});
 return{channels:{...baseServices,'zcode-agent':agent},validateRevision,refreshWorkspace,capabilities:{readOnly:true,history:'native GET -> original validated V4 snapshot',updates:'native events -> snapshot reread',tokenAccounting:false,backgroundAndApprovals:false},dispose(){disposed=true;for(const r of subscriptions.values()){r.nativeListener?.dispose();cancelRefresh(r);}subscriptions.clear();for(const e of emitters.values())e.dispose();emitters.clear();}};
}
