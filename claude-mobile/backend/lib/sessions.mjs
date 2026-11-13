import {readDesktopUnread} from './desktop-unread.mjs';
import {visiblePeerText} from './peer-envelope.mjs';
import {readFile,readdir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * 读取 Claude Code 自己保存的会话：~/.claude/projects/<项目>/<sessionId>.jsonl。
 * 会话归属、标题、cwd 与模型都从记录里取，不猜测目录编码。
 */

const HOME=homedir();
const PROJECTS=join(HOME,'.claude/projects');
const SESSIONS=join(HOME,'.claude/sessions');

const metaCache=new Map();

function textOf(content){
  if(typeof content==='string')return content;
  if(!Array.isArray(content))return'';
  return content.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n');
}

function bootstrapLocalCommand(record){
  const text=textOf(record.message?.content).trim();
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
        found.push({id,path,size:info.size,mtimeMs:info.mtimeMs});
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
      map.set(value.sessionId,{status:value.status??'unknown',name:value.name??null,pid:value.pid??null});
    }catch{}
  }
  return map;
}

async function readMeta(entry){
  const cached=metaCache.get(entry.path);
  if(cached&&cached.mtimeMs===entry.mtimeMs&&cached.size===entry.size)return cached.meta;
  let raw='';
  try{raw=await readFile(entry.path,'utf8');}catch{return null;}
  let title='';
  let cwd=null;
  let model=null;
  let messages=0;
  for(const line of raw.split('\n')){
    if(!line)continue;
    let record;
    try{record=JSON.parse(line);}catch{continue;}
    if(record.isSidechain===true||record.isMeta===true&&record.turnCompanion===true||bootstrapLocalCommand(record))continue;
    if(cwd===null&&typeof record.cwd==='string')cwd=record.cwd;
    if((record.type==='user'||record.type==='assistant')&&record.message){
      if(record.type==='user'&&/^\[Request interrupted by user(?: for tool use)?\]$/.test(visibleUserText(record)))continue;
      messages+=1;
      if(record.type==='user'&&!title){
        const text=cleanTitle(visibleUserText(record));
        if(text&&text!=='[Request interrupted by user]')title=text;
      }
      if(record.type==='assistant'&&typeof record.message.model==='string')model=record.message.model;
    }
  }
  const meta={id:entry.id,title:title||'未命名会话',cwd:cwd??null,model,messageCount:messages,updatedAt:Math.round(entry.mtimeMs),path:entry.path};
  metaCache.set(entry.path,{mtimeMs:entry.mtimeMs,size:entry.size,meta});
  return meta;
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

/** Same visible desktop sessions, titles, folder membership and activity order. */
export async function listSessions({catalog=desktopCatalog,entries=walkSessions,running=runningSessions,unread=()=>readDesktopUnread({withRevision:true})}={}){
  const [desktop,files,live,dots]=await Promise.all([catalog(),entries(),running(),unread()]);
  const byId=new Map(files.map(entry=>[entry.id,entry]));
  const out=[];
  for(const item of desktop){
    const entry=byId.get(item.cliSessionId),meta=entry?await readMeta(entry):null;
    const state=live.get(item.cliSessionId);
    out.push({id:item.cliSessionId,desktopSessionId:item.sessionId,title:item.title||meta?.title||'未命名会话',
      cwd:item.folderPlace?.cwd??item.originCwd??item.cwd??meta?.cwd??null,
      model:item.model??meta?.model??null,messageCount:meta?.messageCount??0,
      updatedAt:Number(item.lastActivityAt)||Number(item.createdAt)||meta?.updatedAt||0,
      unread:dots.known&&(dots.unreadIds.has(item.sessionId)||dots.explicitUnreadIds.has(item.sessionId)),unreadVersion:readMarker(item,dots).unreadVersion,
      running:Boolean(state),runningState:state?.status??null,runningName:state?.name??null});
  }
  return out.sort((a,b)=>b.updatedAt-a.updatedAt);
}

export function readMarker(item,dots){
  return {id:item.cliSessionId,desktopSessionId:item.sessionId,replyId:item.lastAssistantUuid??null,known:dots.known,unread:dots.known&&(dots.unreadIds.has(item.sessionId)||dots.explicitUnreadIds.has(item.sessionId)),
    unreadVersion:String(item.lastAssistantUuid??item.lastTurnEdgeAt??item.createdAt??0)+(dots.explicitUnreadIds?.has(item.sessionId)?':manual':':reply')+(dots.revision?':'+dots.revision:'')};
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
    return input.items.map(item=>({content:String(item?.content??''),status:String(item?.status??'pending')}));
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
 */
export async function readTranscript(id,sinceSeq=0){
  const entry=await sessionFile(id);
  if(!entry)return null;
  const raw=await readFile(entry.path,'utf8');
  return parseTranscript(raw,id,sinceSeq);
}

export function parseTranscript(raw,id,sinceSeq=0){
  const messages=[];
  const toolUpdates=[];
  let cursor=0;
  const toolIndex=new Map();
  let title='';
  let cwd=null;
  let model=null;
  let plan=null;
  let currentUserId=null;
  for(const line of raw.split('\n')){
    if(!line)continue;
    const seq=++cursor;
    let record;
    try{record=JSON.parse(line);}catch{continue;}
    if(record.isSidechain===true||record.isMeta===true&&record.turnCompanion===true||bootstrapLocalCommand(record))continue;
    if(cwd===null&&typeof record.cwd==='string')cwd=record.cwd;
    if(record.type==='assistant'&&typeof record.message?.model==='string')model=record.message.model;
    if(record.type!=='user'&&record.type!=='assistant')continue;
    const content=record.message?.content;
    const ts=record.timestamp??null;
    const stamp=Date.parse(ts)||0;
    const messageId=record.uuid||id+':'+messages.length+':'+ts;
    const rawText=record.type==='user'?textOf(content).trim():null;
    let text=record.type==='user'?visibleUserText(record):textOf(content).trim();
    if(record.type==='user'&&/^\[Request interrupted by user(?: for tool use)?\]$/.test(text)){
      messages.push({id:messageId,seq,role:'assistant',text:'',thinking:'',tools:[],blocks:[],terminal:true,interrupted:true,ts});
      continue;
    }
    if(record.type==='user'){
      if(Array.isArray(content)){
        for(const part of content){
          if(part?.type!=='tool_result')continue;
          const tool=toolIndex.get(part.tool_use_id);
          const result=resultText(part.content).slice(0,12000);
          if(tool){tool.result=result;tool.isError=part.is_error===true;}
          if(seq>sinceSeq)toolUpdates.push({id:part.tool_use_id,text:result,isError:part.is_error===true,seq,ts});
        }
      }
      const attachments=Array.isArray(content)?content.filter(part=>part?.type==='image'&&part.source?.type==='base64').map(part=>({url:'data:'+part.source.media_type+';base64,'+part.source.data,name:'图片'})):[];
      if(!text&&!attachments.length)continue;
      if(!title)title=cleanTitle(text);
      currentUserId=messageId;
      messages.push({id:messageId,seq,role:'user',text,rawText,attachments,ts});
      continue;
    }
    let thinking='';
    const tools=[];const blocks=typeof content==='string'?[{type:'text',text:content}]:[];
    if(Array.isArray(content)){
      for(const part of content){
        if(part?.type==='text'&&typeof part.text==='string')blocks.push({type:'text',text:part.text});
        if(part?.type==='thinking'&&typeof part.thinking==='string'){thinking+=part.thinking;blocks.push({type:'thinking',text:part.thinking});}
        if(part?.type==='tool_use'){
          const items=PLAN_TOOLS.has(part.name)?planItems(part.name,part.input):null;
          if(items)plan=items;
          const tool={id:part.id,name:part.name,detail:toolDetail(part.name,part.input),result:null};
          toolIndex.set(part.id,tool);
          tools.push(tool);blocks.push({type:'tool',id:part.id});
        }
      }
    }
    if(text||tools.length||thinking.trim()||record.message?.stop_reason==='end_turn'){
      messages.push({id:messageId,seq,role:'assistant',text,thinking:thinking.trim(),tools,blocks,terminal:record.message?.stop_reason==='end_turn',ts});
    }
  }
  const fresh=sinceSeq>0?messages.filter(message=>message.seq>sinceSeq):messages;
  const tail=fresh.slice(-400);
  return {id,title:title||'未命名会话',cwd,model,messages:tail,toolUpdates,cursor,plan,currentUserId,truncated:fresh.length>tail.length};
}
