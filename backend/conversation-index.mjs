import {open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {rolloutItem} from './core.mjs';
import {displayItem,displayTurn} from './view.mjs';
import {projectConversationRows} from './conversation-rows.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,code='HISTORY_WINDOW_UNSUPPORTED',statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const sameKeys=(a,b)=>a.length===b.length&&a.every((key,index)=>key===b[index]);
const prefixKeys=(a,b)=>a.length<=b.length&&a.every((key,index)=>key===b[index]);
const rowKey=row=>row.kind+'\0'+row.entityId;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;

// The index retains identities, counts and byte positions, never historical
// message bodies. The cold scan is local; subsequent scans consume only append.
export class RolloutConversationIndex{
 constructor({maxEntries=8,maxBytes=256*1024*1024}={}){this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.files=new Map();}
 async ensure(filePath,threadId){
  let entry=this.files.get(filePath);
  if(entry?.threadId!==threadId)entry=null;
  if(!entry){entry={threadId,generation:randomUUID(),scanOffset:0,turns:[],byId:new Map(),layout:null,layoutGeneration:0};this.files.set(filePath,entry);while(this.files.size>this.maxEntries)this.files.delete(this.files.keys().next().value);}
  if(entry.pending)return entry.pending;
  const pending=this.scan(filePath,entry);entry.pending=pending;
  try{return await pending;}finally{if(entry.pending===pending)entry.pending=null;}
 }
 async scan(filePath,entry){
  const file=await open(filePath,'r');
  try{
   const info=await file.stat();if(!info.isFile()||info.size>this.maxBytes)throw fail('此历史源暂不支持索引窗口');
   const identity=String(info.dev)+':'+String(info.ino),mtime=info.mtimeMs;
   let reset=entry.identity&&entry.identity!==identity||info.size<entry.scanOffset||entry.size===info.size&&entry.mtime!==undefined&&entry.mtime!==mtime;
   if(entry.head&&info.size>=entry.headLength){const head=Buffer.alloc(entry.headLength);await file.read(head,0,head.length,0);if(digest(head)!==entry.head)reset=true;}
   if(entry.tail&&info.size>=entry.scanOffset){const tail=Buffer.alloc(entry.tailLength);await file.read(tail,0,tail.length,entry.scanOffset-tail.length);if(digest(tail)!==entry.tail)reset=true;}
   if(reset){entry.generation=randomUUID();entry.scanOffset=0;entry.turns=[];entry.byId.clear();entry.layout=null;entry.layoutGeneration=0;entry.unsupported=null;entry.settings=undefined;entry.head=null;entry.tail=null;}
   let position=entry.scanOffset,pending=Buffer.alloc(0),pendingOffset=position,scannedBytes=0;
   while(position<info.size){
    const length=Math.min(256*1024,info.size-position),chunk=Buffer.alloc(length);const {bytesRead}=await file.read(chunk,0,length,position);if(!bytesRead)break;
    position+=bytesRead;scannedBytes+=bytesRead;
    const bytes=pending.length?Buffer.concat([pending,chunk.subarray(0,bytesRead)]):chunk.subarray(0,bytesRead);let start=0;
    for(let index=0;index<bytes.length;index++)if(bytes[index]===10){this.accept(entry,bytes.subarray(start,index),pendingOffset+start,pendingOffset+index+1);start=index+1;}
    pending=bytes.subarray(start);pendingOffset+=start;
   }
   entry.scanOffset=pendingOffset;entry.identity=identity;entry.size=info.size;entry.mtime=mtime;
   entry.headLength=Math.min(4096,entry.scanOffset);if(entry.headLength){const head=Buffer.alloc(entry.headLength);await file.read(head,0,head.length,0);entry.head=digest(head);}
   entry.tailLength=Math.min(4096,entry.scanOffset);if(entry.tailLength){const tail=Buffer.alloc(entry.tailLength);await file.read(tail,0,tail.length,entry.scanOffset-tail.length);entry.tail=digest(tail);}
   if(!entry.turns.length||entry.turns.some(turn=>turn.start==null)||entry.unsupported)throw fail('此历史源暂不支持稳定窗口索引');
   return{entry,scannedBytes};
  }finally{await file.close();}
 }
 accept(entry,line,start,end){
  const prefix=line.subarray(0,180).toString('utf8');if(!/"type":\s*"(?:event_msg|turn_context)"/.test(prefix))return;
  let record;try{record=JSON.parse(line.toString('utf8'));}catch{return;}
  const p=record.payload;if(record.type==='turn_context'){entry.settings={...(typeof p?.model==='string'?{model:p.model}:{}),...(typeof p?.effort==='string'?{effort:p.effort}:{})};return;}
  if(!p||!['task_started','task_complete','turn_aborted','turn_failed','item_completed'].includes(p.type)||typeof p.turn_id!=='string')return;
  let turn=entry.byId.get(p.turn_id);
  if(!turn){turn={id:p.turn_id,status:'inProgress',items:new Map(),start:null};entry.byId.set(turn.id,turn);entry.turns.push(turn);}
  if(p.type==='task_started'){
   if(turn.start!=null&&turn.start!==start)entry.unsupported='duplicate-turn-start';
   turn.start=start;if(p.started_at!=null)turn.startedAt=p.started_at;
  }
  if(p.type==='task_complete'){turn.status='completed';turn.completedAt=p.completed_at;turn.durationMs=p.duration_ms;if(p.started_at!=null)turn.startedAt=p.started_at;}
  if(p.type==='turn_aborted')turn.status='interrupted';
  if(p.type==='turn_failed'){turn.status='failed';turn.errorDigest=digest(String(p.message||''));}
  if(p.type==='item_completed'){
   const raw=rolloutItem(p.item||{});if(!raw)return;
   const item=displayItem(raw,{threadId:entry.threadId,turnId:turn.id});
   const rows=item?projectConversationRows({thread:{id:entry.threadId},turns:[{id:turn.id,status:turn.status,items:[item]}]}):[];
   turn.items.set(raw.id,{id:raw.id,kind:rows[0]?.kind||null,stateHash:item?digest(JSON.stringify(item)):null,start,end,hash:digest(line)});
  }
 }
 layout(entry,{thread,nativeTurns=[]}){
  const tail=entry.turns.slice(-4),tailIds=new Set(tail.map(turn=>turn.id)),last=entry.turns.at(-1)?.id;
  const overlays=new Map();
  for(const turn of nativeTurns)if(tailIds.has(turn.id))overlays.set(turn.id,displayTurn(turn,{threadId:thread.id}));
  const nativeLast=nativeTurns.findIndex(turn=>turn.id===last);
  const appended=nativeLast>=0?nativeTurns.slice(nativeLast+1):[];
  const descriptors=entry.turns.map((turn,index)=>{
   const native=overlays.get(turn.id);if(native){const rows=projectConversationRows({thread,turns:[native]});return{id:turn.id,turn:native,rows,keys:rows.map(rowKey),count:rows.length,stateRevision:digest(JSON.stringify(native))};}
   const header=projectConversationRows({thread,turns:[{...turn,items:[]}]}).length>0;
   const items=[...turn.items.values()].filter(item=>item.kind);
   const keys=[...(header?['turnHeader\0turn-header:'+turn.id]:[]),...items.map(item=>item.kind+'\0'+item.id)];
   return{id:turn.id,turn:Object.fromEntries(['id','status','startedAt','completedAt','durationMs'].filter(key=>turn[key]!==undefined).map(key=>[key,turn[key]])),header,items,keys,count:keys.length,stateRevision:digest(JSON.stringify([Object.fromEntries(['id','status','startedAt','completedAt','durationMs','errorDigest'].map(key=>[key,turn[key]??null])),[...turn.items.values()].filter(item=>item.stateHash).map(item=>[item.id,item.stateHash])])),cursor:'rollout:'+(entry.turns[index+1]?.start??entry.scanOffset)};
  });
  for(const raw of appended)if(!entry.byId.has(raw.id)){const turn=displayTurn(raw,{threadId:thread.id}),rows=projectConversationRows({thread,turns:[turn]});descriptors.push({id:turn.id,turn,rows,keys:rows.map(rowKey),count:rows.length,stateRevision:digest(JSON.stringify(turn))});}
  let changed=false;const previous=entry.layout;
  if(previous){
   if(descriptors.length<previous.length)changed=true;
   for(let index=0;index<previous.length&&!changed;index++){
    const old=previous[index],next=descriptors[index];
    if(!next||old.id!==next.id||(index===previous.length-1?!prefixKeys(old.keys,next.keys):!sameKeys(old.keys,next.keys)))changed=true;
   }
  }
  if(changed)entry.layoutGeneration++;
  entry.layout=descriptors.map(turn=>({id:turn.id,keys:turn.keys}));
  let total=0;for(const turn of descriptors){turn.offset=total;total+=turn.count;}
  return{descriptors,total,sourceEpoch:entry.generation+':'+entry.layoutGeneration,stateRevision:digest(JSON.stringify(descriptors.map(turn=>[turn.id,turn.stateRevision])))};
 }
 async read(filePath,{threadId,thread={id:threadId},nativeTurns=[],activeTurn=null,beforeRowId,fromRowId,limit=60,sourceEpoch,metadataOnly=false}={}){
  if(typeof threadId!=='string'||thread.id!==threadId)throw fail('历史编号无效','HISTORY_WINDOW_INVALID',400);
  if(!integer(limit,1,200)||beforeRowId!==undefined&&!integer(beforeRowId,1,Number.MAX_SAFE_INTEGER)||fromRowId!==undefined&&!integer(fromRowId,1,Number.MAX_SAFE_INTEGER)||beforeRowId!==undefined&&fromRowId!==undefined)throw fail('历史窗口参数无效','HISTORY_WINDOW_INVALID',400);
  const {entry,scannedBytes}=await this.ensure(filePath,threadId),layout=this.layout(entry,{thread,nativeTurns});
  if(sourceEpoch!==undefined&&sourceEpoch!==layout.sourceEpoch)throw fail('历史索引已更新，请重新读取','HISTORY_WINDOW_CHANGED');
  if(beforeRowId!==undefined&&beforeRowId>layout.total+1||fromRowId!==undefined&&fromRowId>Math.max(1,layout.total))throw fail('历史窗口已更新，请重新读取','HISTORY_WINDOW_CHANGED');
  const end=beforeRowId===undefined?layout.total:beforeRowId-1,start=metadataOnly?end:fromRowId===undefined?Math.max(0,end-limit):fromRowId-1;
  const generation=entry.generation,layoutGeneration=entry.layoutGeneration;
  const revision=digest(entry.generation+'\0'+layout.stateRevision+'\0'+String(activeTurn||''));
  const rows=[];let bodyReadBytes=0;
  if(!metadataOnly&&start<end){
   const file=await open(filePath,'r');
   try{
    const info=await file.stat();if(String(info.dev)+':'+String(info.ino)!==entry.identity||info.size<entry.scanOffset)throw fail('历史索引已更新，请重新读取','HISTORY_WINDOW_CHANGED');
    for(const descriptor of layout.descriptors){
     if(descriptor.offset>=end||descriptor.offset+descriptor.count<=start)continue;
     if(descriptor.rows){for(const [index,row]of descriptor.rows.entries())if(descriptor.offset+index>=start&&descriptor.offset+index<end)rows.push({...row,rowId:descriptor.offset+index+1});continue;}
     const turn=descriptor.turn;let ordinal=descriptor.offset;
     if(descriptor.header){
      if(ordinal>=start&&ordinal<end){const hasUser=descriptor.items.find(item=>item.kind==='userInput');const header=projectConversationRows({thread,turns:[{...turn,items:hasUser?[{type:'userMessage',id:hasUser.id,content:[]}]:[]} ]},{rowOffset:ordinal})[0];rows.push(header);}
      ordinal++;
     }
     for(const item of descriptor.items){
      if(ordinal>=start&&ordinal<end){
       const length=item.end-item.start,bytes=Buffer.alloc(length);const {bytesRead}=await file.read(bytes,0,length,item.start);bodyReadBytes+=bytesRead;
       if(bytesRead!==length||digest(bytes.subarray(0,length-1))!==item.hash)throw fail('历史索引已更新，请重新读取','HISTORY_WINDOW_CHANGED');
       const record=JSON.parse(bytes.toString('utf8')),raw=rolloutItem(record.payload.item),displayed=displayItem(raw,{threadId,turnId:turn.id});
       const projected=projectConversationRows({thread,turns:[{...turn,items:[displayed]}],imageCursors:{[turn.id]:'rollout:'+item.end}},{rowOffset:ordinal,includeTurnHeader:false});
       if(projected.length!==1||rowKey(projected[0])!==descriptor.keys[ordinal-descriptor.offset])throw fail('历史显示索引已更新','HISTORY_WINDOW_CHANGED');
       rows.push(projected[0]);
      }
      ordinal++;
     }
    }
   }finally{await file.close();}
  }
  if(entry.generation!==generation||entry.layoutGeneration!==layoutGeneration)throw fail('历史索引已更新，请重新读取','HISTORY_WINDOW_CHANGED');
  const last=layout.descriptors.at(-1)?.turn;
  const lastTurn=last?Object.fromEntries(['id','status','startedAt','completedAt','durationMs'].filter(key=>last[key]!==undefined).map(key=>[key,last[key]])):null;
  return{lastTurn,rows:{window:rows,totalCount:layout.total,firstRowId:layout.total?1:null},sourceEpoch:layout.sourceEpoch,revision,hasMore:start>0,diagnostics:{scannedBytes,bodyReadBytes,indexedTurns:entry.turns.length},settings:entry.settings};
 }
 clear(){this.files.clear();}
}
