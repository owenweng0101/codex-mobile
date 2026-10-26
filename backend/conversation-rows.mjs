import {projectMobileHistory,projectAssistantText} from './mobile-history-shared.mjs';
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

export {phase,attachmentName};
export function projectConversationRows(page,{rowOffset=0,includeTurnHeader=true}={}){
 const thread=page.thread,rows=[];let rowId=rowOffset;
 for(const turn of page.turns||[]){
  const createdAt=time(turn.startedAt),state=phase(turn);
  const common=()=>({rowId:++rowId,turnId:turn.id,createdAt,createdAtSeq:0});
  if(includeTurnHeader&&Number.isFinite(turn.startedAt)&&turn.startedAt>0&&['running','error','completedInterrupted','completedSuccess'].includes(state)){
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
    rows.push({...common(),kind:'userInput',entityId:item.id,origin:'realUser',text:text(item,images),...(/^zcv4_[a-f0-9]{48}(?:_input)?$/.test(item.clientUserMessageId||'')?{sourceCommandId:item.clientUserMessageId}:{}),...(attachments.length?{attachments}:{})});
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
 return rows;
}
