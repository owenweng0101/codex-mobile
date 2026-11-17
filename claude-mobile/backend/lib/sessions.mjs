import {readDesktopUnread} from './desktop-unread.mjs';
import {visiblePeerText} from './peer-envelope.mjs';
import {NativePlanReducer} from './native-plan.mjs';
import {open,readFile,readdir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/**
 * 读取 Claude Code 自己保存的会话：~/.claude/projects/<项目>/<sessionId>.jsonl。
 * 会话归属、标题、cwd 与模型都从记录里取，不猜测目录编码。
 */

const HOME=homedir();
const PROJECTS=join(HOME,'.claude/projects');
const SESSIONS=join(HOME,'.claude/sessions');

function textOf(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return'';
  return content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n');
}

function bootstrapLocalCommand(record){
  const text=textOf(record.message?.content).trim();
  const bridgeControl=record.type==='user'&&record.origin?.kind==='plugin'&&/^mobile-native-bridge(?:@[^\s]+)?$/.test(record.origin.name??'')&&record.origin.asUser!==true;
  // Historical plugin control commands and their startup notes are not human
  // chat bubbles. Keep this read compatibility after withdrawing the Goal UI;
  // ordinary asUser text is never filtered this way.
  if(bridgeControl&&(record.isMeta===true||text.startsWith('<command-name>/goal</command-name>')))return true;
  return text.startsWith('<local-command-caveat>')||text.startsWith('<command-name>/model</command-name>')||text.startsWith('<command-name>/rename</command-name>')||text.startsWith('<local-command-stdout>Set model to')||text.startsWith('<local-command-stdout>Session renamed to:');
}

const PHONE_ATTACHMENT_NOTE=/\n\n（手机(?:上传的图片，请用 Read 工具查看后回答：[\s\S]*|随此消息附上了 \d+ 张图片，请用 Read 查看随附路径中的图片后回答。|图片，请用 Read 查看：[\s\S]*)）$/;

// The desktop may prepend one or more native upload mentions (@"path") when
// it materializes peer file_attachments. Strip only those leading mentions;
// ordinary text that merely contains an @ is left alone.
function stripUploadMentions(text){
  let value=text.trim();
  for(;;){
    const match=/^@"([^"\n]+)"\s+/.exec(value);
    if(!match||!match[1].includes('/uploads/'))break;
    value=value.slice(match[0].length);
  }
  return value;
}

function visibleUserText(record){
  let text=textOf(record.message?.content).trim();
  if(record.origin?.kind==='peer'){
    text=visiblePeerText(text);
  }
  return stripUploadMentions(text.replace(PHONE_ATTACHMENT_NOTE,''));
}

function cleanTitle(text){
  const line=String(text||'').replace(/\s+/g,' ').trim();
  if(!line)return'';
  return line.length>72?line.slice(0,72)+'…':line;
}

async function walkSessions(){
  const found=[];
  let projects=[];
  try{projects=await readdir(PROJECTS,{withFileTypes:true});}catch{return found;}
  for(const project of projects){
    if(!project.isDirectory())continue;
    const dir=join(PROJECTS,project.name);
    let files=[];
    try{files=await readdir(dir,{withFileTypes:true});}catch{continue;}
    for(const file of files){
      if(!file.isFile()||!file.name.endsWith('.jsonl'))continue;
      const id=file.name.slice(0,-6);
      if(!/^[0-9a-f-]{36}$/i.test(id))continue;
      const path=join(dir,file.name);
      try{
        const info=await stat(path);
        found.push({id,path,size:info.size,mtimeMs:info.mtimeMs,ino:info.ino});
      }catch{}
    }
  }
  return found.sort((a,b)=>b.mtimeMs-a.mtimeMs);
}

/** 桌面 App 正在运行的会话（用途：避免直接续写正在运行的那条记录）。 */
export async function runningSessions({directory=SESSIONS,isPidAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}}={}){
  const map=new Map();
  let files=[];
  try{files=await readdir(directory,{withFileTypes:true});}catch{return map;}
  for(const file of files){
    if(!file.isFile()||!file.name.endsWith('.json')||file.name.endsWith('.key'))continue;
    try{
      const value=JSON.parse(await readFile(join(directory,file.name),'utf8'));
      if(typeof value?.sessionId!=='string'||!['claude-desktop','claude-desktop-3p'].includes(value.entrypoint)||!isPidAlive(value.pid))continue;
      map.set(value.sessionId,{status:value.status??'unknown',name:value.name??null,pid:value.pid??null,hostSessionId:value.hostSessionId??null,waitingFor:value.waitingFor??null});
    }catch{}
  }
  return map;
}

const META_TAIL_BYTES=64;

function freshMetaState(){
  return {title:'',cwd:null,model:null,messageCount:0};
}

function applyMetaRecord(record,state){
  if(!record||typeof record!=='object')return;
  if(record.isSidechain===true||record.isMeta===true&&record.turnCompanion===true||bootstrapLocalCommand(record))return;
  if(state.cwd===null&&typeof record.cwd==='string')state.cwd=record.cwd;
  if(record.type==='attachment'){
    const queued=record.attachment;
    if(queued?.type==='queued_command'&&(queued.humanTurn===true||queued.origin?.kind==='human')&&!textOf(queued.prompt).trim().startsWith('<system-reminder>'))state.messageCount+=1;
    return;
  }
  if((record.type==='user'||record.type==='assistant')&&record.message){
    if(record.type==='user'&&/^\[Request interrupted by user(?: for tool use)?\]$/.test(visibleUserText(record)))return;
    state.messageCount+=1;
    if(record.type==='user'&&!state.title){
      const text=cleanTitle(visibleUserText(record));
      if(text&&text!=='[Request interrupted by user]')state.title=text;
    }
    if(record.type==='assistant'&&typeof record.message.model==='string')state.model=record.message.model;
  }
}

function scanMetaLines(text,state){
  for(const line of text.split('\n')){
    if(!line)continue;
    let record;
    try{record=JSON.parse(line);}catch{continue;}
    applyMetaRecord(record,state);
  }
}

function metaSnapshot(entry,state){
  return {id:entry.id,title:state.title||'未命名会话',cwd:state.cwd??null,model:state.model,messageCount:state.messageCount,updatedAt:Math.round(entry.mtimeMs),path:entry.path};
}

function tailOf(buffer){
  return buffer.length>META_TAIL_BYTES?buffer.subarray(buffer.length-META_TAIL_BYTES):buffer;
}

function readWholeFile(path){return readFile(path);}

async function readFileRange(path,start,length){
  const handle=await open(path,'r');
  try{
    const buffer=Buffer.alloc(length);
    const {bytesRead}=await handle.read(buffer,0,length,start);
    return buffer.subarray(0,bytesRead);
  }finally{
    await handle.close().catch(()=>{});
  }
}

/**
 * 列表轮询的元数据缓存：path+size+mtime 未变直接复用；文件只追加时从已消费
 * 游标读新增字节、只解析新增行。JSONL 可能被重写或轮转，size 变小、游标
 * 回退、inode 变化或已消费前缀对不上时整份重建，避免拼出错误的计数。
 */
export function createSessionMetaCache({readWhole=readWholeFile,readRange=readFileRange}={}){
  const cache=new Map();

  async function rebuild(entry){
    let raw;
    try{raw=await readWhole(entry.path);}catch{return null;}
    const newline=raw.lastIndexOf(10),end=newline<0?0:newline+1;
    const state=freshMetaState();
    if(end)scanMetaLines(raw.subarray(0,end).toString('utf8'),state);
    let cursor=end;
    // 末尾没有换行的完整记录也算数；解析不了的半行留在游标之后，等写完再读。
    const fragment=raw.subarray(end);
    if(fragment.length){
      try{applyMetaRecord(JSON.parse(fragment.toString('utf8')),state);cursor=raw.length;}catch{}
    }
    const meta=metaSnapshot(entry,state);
    cache.set(entry.path,{size:raw.length,mtimeMs:entry.mtimeMs,ino:entry.ino,cursor,state,tail:tailOf(raw.subarray(0,cursor)),meta});
    return meta;
  }

  async function append(entry,cached){
    // 文件被截断/重写（size 变小）或换成另一个文件时不能只追加，必须重建。
    if(entry.size<cached.size||entry.size<cached.cursor)return null;
    if(cached.ino!==undefined&&entry.ino!==undefined&&cached.ino!==entry.ino)return null;
    const tail=cached.tail,start=cached.cursor-tail.length;
    let chunk;
    try{chunk=await readRange(entry.path,start,entry.size-start);}catch{return null;}
    // 覆写可能保持甚至增大 size；先核对上次游标前的字节，对不上就整读。
    if(chunk.length<tail.length||!chunk.subarray(0,tail.length).equals(tail))return null;
    const appended=chunk.subarray(tail.length);
    const newline=appended.lastIndexOf(10),end=newline<0?0:newline+1;
    const state={...cached.state};
    if(end)scanMetaLines(appended.subarray(0,end).toString('utf8'),state);
    let cursor=cached.cursor+end;
    const fragment=appended.subarray(end);
    if(fragment.length){
      try{applyMetaRecord(JSON.parse(fragment.toString('utf8')),state);cursor=cached.cursor+appended.length;}catch{}
    }
    const meta=metaSnapshot(entry,state);
    cache.set(entry.path,{size:start+chunk.length,mtimeMs:entry.mtimeMs,ino:entry.ino??cached.ino,cursor,state,
      tail:tailOf(Buffer.concat([tail,appended.subarray(0,cursor-cached.cursor)])),meta});
    return meta;
  }

  const sameIdentity=(cached,entry)=>cached.ino===undefined||entry.ino===undefined||cached.ino===entry.ino;

  return async function metaFor(entry){
    const cached=cache.get(entry.path);
    if(cached&&cached.size===entry.size&&cached.mtimeMs===entry.mtimeMs&&sameIdentity(cached,entry))return cached.meta;
    return (cached?await append(entry,cached):null)??await rebuild(entry);
  };
}

const sessionMetaCache=createSessionMetaCache();
async function readMeta(entry){
  return sessionMetaCache(entry);
}

/** Read the App catalog, not the CLI transcript inventory. A missing catalog
 * must never expose archived, terminal-only or side sessions as a fallback. */
export async function desktopCatalog({directories=['Claude-3p','Claude'].map(profile=>join(HOME,'Library/Application Support',profile,'claude-code-sessions'))}={}){
  async function collect(directory,depth=0){
    let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const out=[];
    for(const entry of entries){
      const path=join(directory,entry.name);
      if(entry.isDirectory()&&depth<5){out.push(...(await collect(path,depth+1)??[]));continue;}
      if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
      let value;try{value=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)continue;throw error;}
      if(typeof value.sessionId==='string'&&/^[0-9a-f-]{36}$/i.test(value.cliSessionId??''))out.push(value);
    }
    return out;
  }
  for(const directory of directories){
    const values=await collect(directory);if(values===null)continue;
    // One desktop profile owns the sidebar. Do not merge other profiles.
    const unique=new Map();
    for(const value of values)if(!unique.has(value.cliSessionId)||Number(value.lastActivityAt)>Number(unique.get(value.cliSessionId).lastActivityAt))unique.set(value.cliSessionId,value);
    return [...unique.values()].filter(value=>value.isArchived!==true&&value.spawnedFrom?.sideSession!==true);
  }
  return [];
}

/** Same visible desktop sessions, titles, folder membership and activity order.
 * `unread` stays a boolean for older clients; `unreadKnown:false` means the
 * native store could not be read and `unread:false` is not proof of read. */
export async function listSessions({catalog=desktopCatalog,entries=walkSessions,running=runningSessions,unread=()=>readDesktopUnread({withRevision:true})}={}){
  const [desktop,files,live,dots]=await Promise.all([catalog(),entries(),running(),unread()]);
  const byId=new Map();
  for(const entry of files){const prior=byId.get(entry.id);if(!prior||(entry.mtimeMs??0)>(prior.mtimeMs??0))byId.set(entry.id,entry);}
  const out=[];
  for(const item of desktop){
    const entry=byId.get(item.cliSessionId),meta=entry?await readMeta(entry):null;
    const candidate=live.get(item.cliSessionId),state=candidate?.hostSessionId===item.sessionId?candidate:null,marker=readMarker(item,dots);
    out.push({id:item.cliSessionId,desktopSessionId:item.sessionId,title:item.title||meta?.title||'未命名会话',
      cwd:item.folderPlace?.cwd??item.originCwd??item.cwd??meta?.cwd??null,
      model:item.model??meta?.model??null,messageCount:meta?.messageCount??0,
      updatedAt:Number(item.lastActivityAt)||Number(item.createdAt)||meta?.updatedAt||0,
      unread:marker.unread,unreadKnown:marker.unreadKnown,unreadVersion:marker.unreadVersion,
      attached:Boolean(state),running:state?.status==='busy',runningState:state?.status??null,runningName:state?.name??null,nativePid:state?.pid??null,waitingFor:state?.waitingFor??null});
  }
  return out.sort((a,b)=>b.updatedAt-a.updatedAt);
}

export function readMarker(item,dots){
  const known=Boolean(dots?.known),unread=known&&(dots.unreadIds?.has(item.sessionId)||dots.explicitUnreadIds?.has(item.sessionId));
  return {id:item.cliSessionId,desktopSessionId:item.sessionId,replyId:item.lastAssistantUuid??null,known,unreadKnown:known,unread,
    unreadVersion:String(item.lastAssistantUuid??item.lastTurnEdgeAt??item.createdAt??0)+(dots?.explicitUnreadIds?.has(item.sessionId)?':manual':':reply')+(dots?.revision?':'+dots.revision:'')};
}
export async function sessionReadMarker(id){
  const [items,dots]=await Promise.all([desktopCatalog(),readDesktopUnread({withRevision:true})]);
  const item=items.find(item=>item.cliSessionId===id);return item?readMarker(item,dots):null;
}

export async function sessionFile(id){
  if(!/^[0-9a-f-]{36}$/i.test(String(id)))return null;
  const entries=await walkSessions();
  return entries.find(entry=>entry.id===id)??null;
}

/** 只读开头几行拿 cwd，避免为了续聊解析整份会话。 */
export async function sessionCwd(id){
  const entry=await sessionFile(id);
  if(!entry)return null;
  const raw=await readFile(entry.path,'utf8');
  for(const line of raw.slice(0,200000).split('\n')){
    if(!line)continue;
    try{
      const record=JSON.parse(line);
      if(typeof record.cwd==='string'&&record.cwd)return record.cwd;
    }catch{}
  }
  return null;
}

const PLAN_TOOLS=new Set(['TodoWrite','mcp__ccd_turn__update_plan']);

/** 工具的简短描述，用于手机上的活动行。 */
export function toolDetail(name,input){
  const value=['file_path','path','pattern','command','url','query'].map(key=>input?.[key]).find(item=>typeof item==='string');
  const text=typeof value==='string'?value.replace(/\s+/g,' ').trim():'';
  return text.length>100?text.slice(0,100)+'…':text;
}

const planStatus=value=>value==='completed'?'done':['done','in_progress','pending'].includes(value)?value:'pending';
export function planItems(name,input){
  if(name==='TodoWrite'&&Array.isArray(input?.todos)){
    return input.todos.map(item=>({content:String(item?.content??''),status:planStatus(item?.status)}));
  }
  if(name==='mcp__ccd_turn__update_plan'&&Array.isArray(input?.items)){
    return input.items.map(item=>({content:String(item?.content??''),status:planStatus(item?.status)}));
  }
  return null;
}

export function resultText(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return'';
  return content.map(part=>{
    if(part?.type==='text')return String(part.text??'');
    if(part?.type==='image')return'［图片］';
    return'';
  }).filter(Boolean).join('\n');
}

/**
 * 手机会话正文：用户/助手文本、思考、工具与待办。
 * 结果按 tool_use_id 回填到对应的工具行，渲染时不用再找。
 * sinceSeq>0 只回增量（超过 400 条时以 truncated/sinceTruncated 显式标记缺口）；
 * beforeSeq>0 时回一页更早的历史（最多 80 条）。
 */
const transcriptCache=new Map();

export async function readTranscript(id,sinceSeq=0,beforeSeq=0,sinceAnchor=null){
  const entry=await sessionFile(id);
  if(!entry)return null;
  // One parse per native file version; the prefix anchor also detects equal-
  // length/longer rewrites without relying on timestamps as message cursors.
  const cached=transcriptCache.get(entry.path);
  if(cached&&cached.size===entry.size&&cached.ino===entry.ino&&cached.mtimeMs===entry.mtimeMs)return viewTranscript(cached.parsed,id,sinceSeq,beforeSeq,sinceAnchor);
  const raw=await readFile(entry.path,'utf8');
  const parsed=parseAll(raw,id);
  transcriptCache.set(entry.path,{size:entry.size,ino:entry.ino,mtimeMs:entry.mtimeMs,parsed});
  if(transcriptCache.size>8)transcriptCache.delete(transcriptCache.keys().next().value);
  return viewTranscript(parsed,id,sinceSeq,beforeSeq,sinceAnchor);
}

/**
 * 会话 JSON 里内联图片的上限：长会话的 base64 可以到几百 MB，手机端会卡死。
 * 手机截图常见 1-3MB，所以单张放宽到 3MB；为避免一次响应过大，单条消息 6MB、
 * 整份 transcript 12MB。超过任一预算的图片只回占位信息（placeholder:true + size），
 * 由手机端渲染成“图片过大”的占位而不是真正的图片。
 */
const MAX_INLINE_IMAGE_BYTES=3*1024*1024;
const MAX_INLINE_TRANSCRIPT_IMAGE_BYTES=12*1024*1024;
const MAX_INLINE_MESSAGE_IMAGE_BYTES=6*1024*1024;
const IMAGE_PLACEHOLDER_NOTE='图片过大，未在手机上内联';

function phoneImageAttachments(content,budget=MAX_INLINE_TRANSCRIPT_IMAGE_BYTES){
  const attachments=[];
  let inlined=0,placeholders=0;
  if(!Array.isArray(content))return {attachments,inlinedBytes:0,placeholders};
  for(const part of content){
    if(part?.type!=='image'||part.source?.type!=='base64')continue;
    const data=typeof part.source.data==='string'?part.source.data:'';
    const mediaType=typeof part.source.media_type==='string'?part.source.media_type:'image/png';
    const size=Buffer.byteLength(data,'utf8');
    if(!data||size>MAX_INLINE_IMAGE_BYTES||inlined+size>MAX_INLINE_MESSAGE_IMAGE_BYTES||inlined+size>budget){
      attachments.push({placeholder:true,name:'图片',mediaType,size});
      placeholders+=1;
      continue;
    }
    inlined+=size;
    attachments.push({url:'data:'+mediaType+';base64,'+data,name:'图片',size});
  }
  return {attachments,inlinedBytes:inlined,placeholders};
}

function parseAll(raw,id){
  let inlineBudget=MAX_INLINE_TRANSCRIPT_IMAGE_BYTES;
  const messages=[],toolUpdates=[];
  let cursor=0,title='',cwd=null,model=null,currentUserId=null;
  const toolIndex=new Map(),queuedById=new Map(),nativeUsers=new Set(),superseded=new Set();
  const plans=new NativePlanReducer();
  const prefix=createHash('sha256'),anchors=[prefix.copy().digest('hex').slice(0,32)];
  for(const line of raw.split('\n')){
    if(!line)continue;
    let record;
    try{record=JSON.parse(line);}catch{continue;}
    const seq=++cursor;
    prefix.update(line).update('\n');anchors[seq]=prefix.copy().digest('hex').slice(0,32);
    if(record.isSidechain===true||record.isMeta===true&&record.turnCompanion===true||bootstrapLocalCommand(record))continue;
    if(cwd===null&&typeof record.cwd==='string')cwd=record.cwd;
    if(record.type==='assistant'&&typeof record.message?.model==='string')model=record.message.model;
    if(record.type==='attachment'){
      const queued=record.attachment;
      if(queued?.type==='queued_command'&&(queued.humanTurn===true||queued.origin?.kind==='human')){
        const messageId=typeof queued.source_uuid==='string'?queued.source_uuid:record.uuid||id+':queued:'+seq;
        if(nativeUsers.has(messageId)||queuedById.has(messageId))continue;
        const text=stripUploadMentions(textOf(queued.prompt).replace(/^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/,'').replace(PHONE_ATTACHMENT_NOTE,'')).trim();
        const image=phoneImageAttachments(queued.prompt,inlineBudget);
        if(text||image.attachments.length){
          inlineBudget-=image.inlinedBytes;
          const message={id:messageId,seq,role:'user',queued:true,text,rawText:text,attachments:image.attachments,ts:record.timestamp??null};
          queuedById.set(messageId,{message,inlinedBytes:image.inlinedBytes});
          if(!title)title=cleanTitle(text);
          // A reserved source UUID is not a confirmed user-turn boundary yet.
          messages.push(message);
        }
      }
      continue;
    }
    if(record.type!=='user'&&record.type!=='assistant')continue;
    const content=record.message?.content,ts=record.timestamp??null;
    const messageId=record.uuid||id+':'+messages.length+':'+ts;
    const rawText=record.type==='user'?textOf(content).trim():null;
    let text=record.type==='user'?visibleUserText(record):textOf(content).trim();
    const ownInput=!record.isMeta&&(record.origin?.kind==='human'||record.origin?.kind==='plugin'&&record.origin.asUser===true);
    if(record.type==='user'&&!ownInput&&/^\s*<(?:task-notification|side-sessions-event|ci-monitor-event|system-reminder)/.test(text))continue;
    if(record.type==='user'&&!ownInput&&/^\[Request interrupted by user(?: for tool use)?\]$/.test(text)){
      messages.push({id:messageId,seq,role:'assistant',text:'',thinking:'',tools:[],blocks:[],terminal:true,interrupted:true,ts});continue;
    }
    if(record.type==='user'){
      if(Array.isArray(content))for(const part of content){
        if(part?.type!=='tool_result')continue;
        plans.result(part.tool_use_id,{isError:part.is_error===true,content:part.content});
        const tool=toolIndex.get(part.tool_use_id),result=resultText(part.content).slice(0,12000);
        if(tool){tool.result=result;tool.isError=part.is_error===true;}
        toolUpdates.push({id:part.tool_use_id,text:result,isError:part.is_error===true,seq,ts});
      }
      const queued=queuedById.get(messageId);
      const image=phoneImageAttachments(content,inlineBudget+(queued?.inlinedBytes??0));
      if(!text&&!image.attachments.length)continue;
      if(queued){inlineBudget+=queued.inlinedBytes;superseded.add(queued.message);queuedById.delete(messageId);}
      inlineBudget-=image.inlinedBytes;
      if(!title)title=cleanTitle(text);
      if(image.placeholders)text=text?text+'\n'+IMAGE_PLACEHOLDER_NOTE:IMAGE_PLACEHOLDER_NOTE;
      nativeUsers.add(messageId);currentUserId=messageId;
      messages.push({id:messageId,seq,role:'user',text,rawText,attachments:image.attachments,ts});continue;
    }
    let thinking='';
    const tools=[],blocks=typeof content==='string'?[{type:'text',text:content}]:[];
    if(Array.isArray(content))for(const part of content){
      if(part?.type==='text'&&typeof part.text==='string')blocks.push({type:'text',text:part.text});
      if(part?.type==='thinking'&&typeof part.thinking==='string'){thinking+=part.thinking;blocks.push({type:'thinking',text:part.thinking});}
      if(part?.type==='tool_use'){
        plans.call(part.id,part.name,part.input);
        const tool={id:part.id,name:part.name,detail:toolDetail(part.name,part.input),result:null};
        toolIndex.set(part.id,tool);tools.push(tool);blocks.push({type:'tool',id:part.id});
      }
    }
    if(text||tools.length||thinking.trim()||record.message?.stop_reason==='end_turn')messages.push({id:messageId,seq,role:'assistant',text,thinking:thinking.trim(),tools,blocks,terminal:record.message?.stop_reason==='end_turn',ts});
  }
  return {id,title:title||'未命名会话',cwd,model,messages:messages.filter(message=>!superseded.has(message)),toolUpdates,cursor,anchors,plan:plans.plan,currentUserId};
}

function viewTranscript(parsed,id,sinceSeq=0,beforeSeq=0,sinceAnchor=null){
  const {title,cwd,model,messages,toolUpdates,cursor,plan,currentUserId,anchors=[]}=parsed;
  const anchor=anchors[cursor]??null;
  if(beforeSeq>0){
    const older=messages.filter(message=>message.seq<beforeSeq),page=older.slice(-80);
    return {id,title,cwd,model,messages:page,toolUpdates:[],cursor,anchor,plan,currentUserId,
      before:page[0]?.seq??null,hasMore:older.length>page.length,truncated:false};
  }
  // Compare the entire consumed prefix, not just its length, inode or last row.
  // Appends retain the anchor at `since`; rewrites explicitly request a reset.
  const reset=sinceSeq>0&&(sinceSeq>cursor||typeof sinceAnchor==='string'&&sinceAnchor!==anchors[sinceSeq]);
  const fresh=reset?messages:sinceSeq>0?messages.filter(message=>message.seq>sinceSeq):messages;
  const tail=fresh.slice(-400),truncated=fresh.length>tail.length;
  const sinceTruncated=!reset&&sinceSeq>0&&truncated;
  return {id,title,cwd,model,messages:tail,
    toolUpdates:sinceSeq>0&&!reset?toolUpdates.filter(update=>update.seq>sinceSeq):toolUpdates,
    cursor,anchor,plan,currentUserId,truncated,sinceTruncated,dropped:truncated?fresh.length-tail.length:0,
    ...(reset?{reset:true}:{}),before:tail[0]?.seq??null,hasMore:truncated};
}

export function parseTranscript(raw,id,sinceSeq=0,beforeSeq=0,sinceAnchor=null){
  return viewTranscript(parseAll(raw,id),id,sinceSeq,beforeSeq,sinceAnchor);
}
