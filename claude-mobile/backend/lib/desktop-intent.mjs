import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,readFile,readdir,rename,unlink,realpath,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resolveCli,readMagpieLaunch,buildTurnEnv,startTurn as runTurn,PERMISSION_MODES} from './claude-cli.mjs';
import {sessionFile} from './sessions.mjs';

const execute=promisify(execFile), UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nativeEntry=new Set(['claude-desktop-3p','claude-desktop']);
const locks=new Map();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(code,message,fields={})=>Object.assign(new Error(message),{code,status:409,statusCode:409,...fields});
const pending=(id,stage)=>fail('DESKTOP_PENDING','桌面接管尚待确认，请恢复同一会话',{sessionId:id,stage,pendingDesktop:true,recoverable:true});
const validId=id=>{if(!UUID.test(id??''))throw fail('INVALID_SESSION_ID','需要稳定的 UUID 会话编号');return id.toLowerCase();};
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};

async function* jsonFiles(dir,depth=0){
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const entry of entries){
    const path=join(dir,entry.name);
    if(entry.isDirectory()&&depth<5)yield* jsonFiles(path,depth+1);
    else if(entry.isFile()&&entry.name.endsWith('.json'))yield path;
  }
}

/** Reads only registration JSON, never the adjacent authentication key files. */
export async function readDesktopOwners(id,{directory=join(homedir(),'.claude/sessions')}={}){
  const owners=[];
  let names;try{names=await readdir(directory);}catch(e){if(e.code==='ENOENT')return owners;throw e;}
  for(const name of names){
    if(!/^\d+\.json$/.test(name))continue;
    let value;try{value=JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)continue;throw e;}
    if(value.sessionId!==id)continue;
    const {pid,sessionId,hostSessionId,entrypoint,status,cwd,waitingFor}=value;
    owners.push({pid,sessionId,hostSessionId,entrypoint,status,cwd,waitingFor});
  }
  return owners;
}

export async function readDesktopMetadata(id,{directories=['Claude-3p','Claude'].map(profile=>join(homedir(),'Library/Application Support',profile,'claude-code-sessions'))}={}){
  const matches=[];
  for(const directory of directories)for await(const file of jsonFiles(directory)){
    let value;try{value=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)continue;throw e;}
    if(value.cliSessionId!==id||typeof value.sessionId!=='string'||!value.sessionId)continue;
    const {cliSessionId,sessionId,cwd}=value;
    matches.push({cliSessionId,sessionId,cwd,...desktopFields(value)});
  }
  if(new Set(matches.map(v=>v.sessionId)).size>1)throw fail('DESKTOP_METADATA_AMBIGUOUS','桌面会话映射不唯一');
  return matches[0]??null;
}

async function transcript(id){
  const entry=await sessionFile(id);if(!entry)return null;
  return {path:entry.path,raw:await readFile(entry.path,'utf8')};
}
function recordsOf(value){
  if(!value)return null;
  if(Array.isArray(value.records))return value.records;
  if(typeof value.raw!=='string')throw fail('SEED_UNVERIFIED','无法核验 bootstrap 记录');
  try{return value.raw.split('\n').filter(v=>v.trim()).map(line=>JSON.parse(line));}catch{throw fail('SEED_UNVERIFIED','bootstrap 记录尚不完整');}
}
function textOf(record){const c=record.message?.content;return typeof c==='string'?c:Array.isArray(c)?c.filter(v=>v.type==='text').map(v=>v.text).join('\n'):'';}
const modelReply=model=>`Set model to \`${model}\` for this session only`;
const localOutput=model=>`<local-command-stdout>${modelReply(model)}</local-command-stdout>`;
const renameReply=title=>`Session renamed to: ${title}`;
const renameOutput=title=>`<local-command-stdout>${renameReply(title)}</local-command-stdout>`;
export function normalizeDesktopTitle(value){
  if(value===undefined||value===null)return '';
  if(typeof value!=='string')throw fail('INVALID_TITLE','会话标题必须是文本');
  const single=value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,' ').replace(/\s+/gu,' ').trim();
  return Array.from(single).slice(0,72).join('').trimEnd();
}
function desktopFields(meta){
  const model=typeof meta?.model==='string'&&meta.model?meta.model:null;
  return {model,actualModel:model,permissionMode:typeof meta?.permissionMode==='string'?meta.permissionMode:null,title:typeof meta?.title==='string'?meta.title:null};
}
function hasUsage(value){
  if(typeof value==='number')return value!==0;
  return value&&typeof value==='object'?Object.values(value).some(hasUsage):false;
}
function localSynthetic(record,args,command='model'){
  const message=record.message,usage=message?.usage,content=message?.content;
  const reply=command==='rename'?renameReply(args):modelReply(args),output=command==='rename'?renameOutput(args):localOutput(args);
  return typeof args==='string'&&message?.model==='<synthetic>'&&message.stop_reason==='end_turn'
    &&['input_tokens','output_tokens','cache_creation_input_tokens','cache_read_input_tokens'].every(key=>usage?.[key]===0)
    &&record.local_command_run?.command===command&&record.local_command_run.args===args
    &&record.local_command_source===output
    &&Array.isArray(content)&&content.length>0&&content.every(part=>part.type==='text'&&typeof part.text==='string')
    &&[reply,output].includes(textOf(record));
}
function unsafeRecord(record,{model,title,command='model',allowSynthetic=false}={}){
  if(record.type==='tool'||record.type==='tool_use'||record.type==='tool_result')return true;
  // Only the SDK's fully identified local-command echo is permitted. Durable
  // JSONL assistant records remain forbidden even when labeled synthetic.
  if(record.type==='assistant'&&!(allowSynthetic&&localSynthetic(record,command==='rename'?title:model,command))||record.type==='stream_event')return true;
  if(Array.isArray(record.message?.content)&&record.message.content.some(v=>v.type!=='text'))return true;
  if(record.is_error===true||record.type==='error')return true;
  for(const key of ['total_cost_usd','cost_usd','costUsd','totalCostUSD'])if(record[key]!==undefined&&record[key]!==0)return true;
  if(record.type==='cost-state'&&(record.hasUnknownModelCost===true||['totalAPIDuration','totalAPIDurationWithoutRetries','totalToolDuration'].some(key=>hasUsage(record[key]))))return true;
  if(hasUsage(record.usage)||hasUsage(record.message?.usage)||hasUsage(record.modelUsage))return true;
  return false;
}
function localMarker({records,events,model,title}){
  const texts=records.map(textOf).filter(Boolean);
  return texts.some(v=>v.includes('<command-name>/model</command-name>')&&v.includes(`<command-args>${model}</command-args>`))
    &&texts.every(v=>v.includes('<command-name>/model</command-name>')||v.includes('<local-command-stdout>')||v.includes('<local-command-caveat>')
      ||title&&v.includes('<command-name>/rename</command-name>')&&v.includes(`<command-args>${title}</command-args>`))
    &&events.filter(v=>v.type==='result').every(v=>!v.result||[`Set model to ${model}`,modelReply(model),localOutput(model)].includes(v.result));
}
function renameMarker(records,id,title){
  const titles=records.filter(v=>v.type==='custom-title');
  return titles.length>0&&titles.every(v=>v.sessionId===id&&v.customTitle===title)
    &&records.some(v=>v.type==='user'&&textOf(v).includes('<command-name>/rename</command-name>')&&textOf(v).includes(`<command-args>${title}</command-args>`));
}

/** Subscribe before consuming stdout: end-of-stream alone never proves writer release. */
function watchExit(child,timeoutMs){
  if(!child||typeof child.once!=='function')throw fail('WRITER_UNVERIFIED','bootstrap 未提供可确认退出的子进程');
  let timer,onExit,onError;
  const promise=new Promise((resolve,reject)=>{
    const finish=(error,code,signal)=>{clearTimeout(timer);child.off('exit',onExit);child.off('error',onError);error?reject(error):resolve({code,signal});};
    onExit=(code,signal)=>finish(null,code,signal);
    onError=()=>finish(fail('SEED_FAILED','bootstrap 子进程启动失败'));
    child.once('exit',onExit);child.once('error',onError);
    timer=setTimeout(()=>finish(fail('WRITER_PENDING','bootstrap writer 尚未确认退出')),timeoutMs);
    if(child.exitCode!==null&&child.exitCode!==undefined)finish(null,child.exitCode,child.signalCode);
    else if(child.signalCode)finish(null,null,child.signalCode);
  });
  promise.catch(()=>{});
  return promise;
}

/**
 * Native desktop ownership only. CLI input is /model plus optional literal
 * /rename, never a user task. metadata(id) => {cliSessionId,sessionId,cwd?,model?,permissionMode?,title?}; liveSession(id) =>
 * owner or owner[]. checkLocalModelMarker({records,events,prompt,model}) may adapt
 * a verified CLI marker format; cost/tool/real-assistant checks cannot be overridden.
 * Import may reset the seed model: model/actualModel always come from native
 * metadata, never the request. The peer carrier cannot perform SDK interrupt.
 */
export class DesktopIntent{
  constructor({stateDir,readiness=async()=>({cli:await resolveCli()}),getLaunch=readMagpieLaunch,startTurn=runTurn,
    openSession=id=>execute('/usr/bin/open',['-g','-b','com.anthropic.claudefordesktop',`claude://resume?session=${id}`],{timeout:10000}),
    liveSession=readDesktopOwners,metadata=readDesktopMetadata,readTranscript=transcript,isPidAlive=alive,
    checkLocalModelMarker=localMarker,buildEnv=buildTurnEnv,attachTimeoutMs=15000,seedTimeoutMs=30000,pollMs=100,sleep=delay}={}){
    if(!stateDir)throw new Error('DesktopIntent requires stateDir');
    Object.assign(this,{directory:join(stateDir,'desktop-intents'),readiness,getLaunch,startTurn,openSession,liveSession,metadata,readTranscript,isPidAlive,checkLocalModelMarker,buildEnv,attachTimeoutMs,seedTimeoutMs,pollMs,sleep});
  }
  async load(id){try{return JSON.parse(await readFile(join(this.directory,id+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async save(record){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const target=join(this.directory,record.sessionId+'.json'),temporary=target+'.'+randomUUID()+'.tmp';
    let file;try{file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(record));await file.sync();await file.close();file=null;await rename(temporary,target);const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}finally{await file?.close();await unlink(temporary).catch(()=>{});}
  }
  async exclusive(id,operation){
    const key=join(this.directory,id),prior=locks.get(key)??Promise.resolve();
    const work=prior.catch(()=>{}).then(async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      let lock;
      try{lock=await open(key+'.lock','wx',0o600);}catch(e){
        if(e.code!=='EEXIST')throw e;
        // Reclaim only a positively dead process's lock. A separate guard stops
        // competing reclaimers from removing a newly acquired live lock.
        let guard;
        try{
          guard=await open(key+'.reaping','wx',0o600);
          let owner;try{owner=JSON.parse(await readFile(key+'.lock','utf8'));}catch{throw pending(id,'locked');}
          if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||alive(owner.pid))throw pending(id,'locked');
          await unlink(key+'.lock');
          try{lock=await open(key+'.lock','wx',0o600);}catch(error){if(error.code==='EEXIST')throw pending(id,'locked');throw error;}
        }catch(error){if(error.code==='EEXIST')throw pending(id,'locked');throw error;}
        finally{if(guard){await guard.close();await unlink(key+'.reaping');}}
      }
      try{await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.sync();}catch(error){await lock.close();await unlink(key+'.lock');throw error;}
      try{return await operation();}finally{await lock.close();await unlink(key+'.lock');}
    });locks.set(key,work);try{return await work;}finally{if(locks.get(key)===work)locks.delete(key);}
  }
  async owners(id){const value=await this.liveSession(id);return (Array.isArray(value)?value:value?[value]:[]).filter(v=>this.isPidAlive(v.pid));}
  async readState(id){
    id=validId(id);const meta=await this.metadata(id),owners=await this.owners(id);
    if(owners.length>1)throw fail('DESKTOP_OWNER_AMBIGUOUS','同一会话出现多个活动写入者，不能自动接管',{sessionId:id,recoverable:true});
    const owner=meta?.cliSessionId===id&&typeof meta.sessionId==='string'
      ?owners.find(v=>v.sessionId===id&&nativeEntry.has(v.entrypoint)&&v.hostSessionId===meta.sessionId):null;
    const attached=!!owner,status=owner?.status??(owners.length?'foreign-writer':meta?'pendingDesktop':'detached');
    return {desktopSessionId:meta?.cliSessionId===id?meta.sessionId:null,attached,nativePid:owner?.pid??null,running:attached&&status==='busy',status,waitingFor:owner?.waitingFor??null,canInterrupt:false,...desktopFields(meta?.cliSessionId===id?meta:null)};
  }
  async assertNoForeignWriter(id){
    const owners=await this.owners(id);
    if(owners.some(v=>v.sessionId===id&&!nativeEntry.has(v.entrypoint)))throw fail('CLI_WRITER_ACTIVE','独立 CLI 正持有会话，不能导入或分叉',{sessionId:id,recoverable:true,pendingDesktop:true});
  }
  async waitAttached(id,record){
    await this.assertNoForeignWriter(id);
    let state=await this.readState(id);
    if(!state.attached){
      // Mark before opening: timeout or process loss must recover this identity.
      if(record){record.phase='importRequested';await this.save(record);}
      try{await this.openSession(id);}catch{throw pending(id,'importRequested');}
      const deadline=Date.now()+this.attachTimeoutMs;
      do{await this.assertNoForeignWriter(id);state=await this.readState(id);if(state.attached)break;if(Date.now()>=deadline)throw pending(id,'importRequested');await this.sleep(Math.min(this.pollMs,Math.max(1,deadline-Date.now())));}while(true);
    }
    if(record){record.phase='attached';record.desktopSessionId=state.desktopSessionId;await this.save(record);}
    return {sessionId:id,desktopSessionId:state.desktopSessionId,attached:true,canInterrupt:false,...desktopFields(state)};
  }
  attach(id){id=validId(id);return this.exclusive(id,async()=>this.waitAttached(id,null));}
  async verifyTitle(record,model){
    let records;
    try{
      records=recordsOf(await this.readTranscript(record.sessionId));
      if(!records?.length||records.some(v=>unsafeRecord(v)||v.sessionId!==undefined&&v.sessionId!==record.sessionId)
        ||!renameMarker(records,record.sessionId,record.title)
        ||!await this.checkLocalModelMarker({records,events:[],prompt:'/model '+model,model,title:record.title}))throw Error('invalid title transcript');
    }catch{
      record.seedRejected=true;await this.save(record);
      throw fail('SEED_REJECTED','原生标题记录未通过本地命令核验，禁止接管',{sessionId:record.sessionId});
    }
  }
  async renameBeforeImport(record,{cwd,model,permissionMode}){
    const id=record.sessionId;
    if(record.titleStarted)throw pending(id,'renaming');
    // Even an idle native owner is a writer: never resume a second CLI into it.
    await this.assertNoForeignWriter(id);
    if((await this.owners(id)).length||await this.metadata(id))throw pending(id,'nativeAlreadyImported');
    const ready=await this.readiness();if(!ready?.cli||ready.ready===false)throw fail('CLAUDE_NOT_READY','本地标题命令尚未就绪');
    const launch=ready.launch??await this.getLaunch();
    record.titleStarted=true;record.phase='renaming';await this.save(record);
    if((await this.owners(id)).length||await this.metadata(id))throw pending(id,'renaming');
    let turn;try{turn=await this.startTurn({cli:ready.cli,env:this.buildEnv(launch,model),cwd,model,permissionMode,resume:id,prompt:'/rename '+record.title});}catch{throw pending(id,'renaming');}
    const exited=watchExit(turn.child,this.seedTimeoutMs),events=[];
    record.titlePid=turn.child?.pid??null;await this.save(record);
    let timer;
    try{
      await Promise.race([(async()=>{for await(const event of turn.events){
        events.push(event);
        if(events.length>1000||unsafeRecord(event,{title:record.title,command:'rename',allowSynthetic:true})||event.session_id!==undefined&&event.session_id!==id)throw fail('SEED_REJECTED','标题命令产生了非本地行为');
      }})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(pending(id,'renaming')),this.seedTimeoutMs);})]);
      const results=events.filter(v=>v.type==='result');
      if(events.filter(v=>v.type==='assistant').length!==1||results.length!==1||results[0].total_cost_usd!==0||results[0].is_error===true||results[0].result!==renameReply(record.title))throw fail('SEED_REJECTED','标题命令缺少精确的零费用本地回执');
      await this.verifyTitle(record,model);
      record.titleValidated=true;record.phase='titlePersisted';await this.save(record);
    }catch(error){
      if(error.code==='SEED_REJECTED'){turn.child?.kill?.('SIGTERM');record.seedRejected=true;await this.save(record);}throw error;
    }finally{clearTimeout(timer);}
    let exit;try{exit=await exited;}catch{throw pending(id,'titlePersisted');}
    if(exit.code!==0||exit.signal){record.seedRejected=true;await this.save(record);throw fail('SEED_REJECTED','标题命令未正常退出');}
    record.phase='titleWriterReleased';record.titleExit={code:exit.code,signal:exit.signal};await this.save(record);
  }
  async create(options){
    const id=validId(options?.sessionId),{model,permissionMode='bypassPermissions'}=options;
    const title=normalizeDesktopTitle(options.title);
    // /model receives one literal argument string, not shell code. Catalog
    // names include spaces and [1m]; forbid line/control/XML delimiter injection.
    if(typeof model!=='string'||!model||model.length>256||model!==model.trim()||model.startsWith('/')||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>`]/u.test(model))throw fail('INVALID_MODEL','模型名称必须是单行模型标识');
    if(!PERMISSION_MODES.has(permissionMode))throw fail('INVALID_PERMISSION_MODE','不支持的权限模式');
    if(typeof options.cwd!=='string'||!isAbsolute(options.cwd))throw fail('INVALID_CWD','需要绝对工作目录');
    const cwd=await realpath(options.cwd);if(!(await stat(cwd)).isDirectory())throw fail('INVALID_CWD','工作目录不存在');
    const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const fingerprint=digest({cwd,model,permissionMode,title}),legacyFingerprint=digest({cwd,model,permissionMode});
    return this.exclusive(id,async()=>{
      let record=await this.load(id);
      // Legacy intents never recorded a title: retain their identity and stages,
      // ignoring a newly supplied title rather than reseeding/renaming old work.
      if(record&&(record.version!==1||record.sessionId!==id||(Object.hasOwn(record,'title')
        ?record.fingerprint!==fingerprint||record.title!==title:record.fingerprint!==legacyFingerprint)))throw fail('DESKTOP_INTENT_COLLISION','同一会话编号不能更换创建参数');
      if(!record){
        if(await this.readTranscript(id)||await this.metadata(id)||(await this.owners(id)).length)throw fail('SESSION_ALREADY_EXISTS','已有同 UUID 会话不属于本次创建 intent');
        record={version:1,sessionId:id,fingerprint,title,phase:'create',createdAt:Date.now(),seedStarted:false};await this.save(record);
      }
      if(record.seedRejected)throw fail('SEED_REJECTED','bootstrap 未通过本地命令核验，禁止桌面接管',{sessionId:id});
      await this.assertNoForeignWriter(id);
      if(record.phase==='create'&&!record.seedStarted){
        const ready=await this.readiness();
        if(!ready?.cli||ready.ready===false)throw fail('CLAUDE_NOT_READY','Claude bootstrap 尚未就绪');
        const launch=ready.launch??await this.getLaunch();
        if(await this.readTranscript(id))throw fail('SESSION_ALREADY_EXISTS','bootstrap 启动前出现了未归属本 intent 的会话记录');
        record.seedStarted=true;await this.save(record);
        let turn;try{turn=await this.startTurn({cli:ready.cli,env:this.buildEnv(launch,model),cwd,model,prompt:'/model '+model,sessionId:id,permissionMode});}catch{throw pending(id,'create');}
        record.seedPid=turn.child?.pid??null;await this.save(record);
        const exited=watchExit(turn.child,this.seedTimeoutMs),events=[];
        let timer;
        try{
          await Promise.race([(async()=>{for await(const event of turn.events){events.push(event);if(events.length>1000||unsafeRecord(event,{model,allowSynthetic:true})||event.session_id!==undefined&&event.session_id!==id)throw fail('SEED_REJECTED','bootstrap 产生了非本地命令行为');}})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(pending(id,'create')),this.seedTimeoutMs);})]);
          const results=events.filter(v=>v.type==='result');
          const saved=await this.readTranscript(id),records=recordsOf(saved);
          if(results.length!==1||results[0].total_cost_usd!==0||results[0].is_error===true||!records?.length||records.some(v=>unsafeRecord(v)||v.sessionId!==undefined&&v.sessionId!==id)||!await this.checkLocalModelMarker({records,events,prompt:'/model '+model,model}))throw fail('SEED_REJECTED','bootstrap 不是已确认的零费用本地 /model 命令');
          record.seedValidated=true;record.phase='persisted';await this.save(record);
        }catch(error){if(error.code==='SEED_REJECTED'){record.seedRejected=true;await this.save(record);}throw error;}finally{clearTimeout(timer);}
        let exit;try{exit=await exited;}catch{throw pending(id,'persisted');}
        if(exit.code!==0||exit.signal){record.seedRejected=true;await this.save(record);throw fail('SEED_REJECTED','bootstrap 未正常退出');}
        record.phase='writerReleased';await this.save(record);
      }
      if(record.phase==='create')throw pending(id,'create'); // Never replay an uncertain seed.
      if(record.phase==='persisted'){
        if(!record.seedValidated||!Number.isSafeInteger(record.seedPid)||this.isPidAlive(record.seedPid))throw pending(id,'persisted');
        record.phase='writerReleased';await this.save(record);
      }
      if(!['writerReleased','renaming','titlePersisted','titleWriterReleased','importRequested','attached'].includes(record.phase)||!record.seedValidated)throw pending(id,record.phase);
      if(record.phase==='writerReleased'){
        const records=recordsOf(await this.readTranscript(id));
        if(!records?.length||records.some(v=>unsafeRecord(v)||v.sessionId!==undefined&&v.sessionId!==id)||!await this.checkLocalModelMarker({records,events:[],prompt:'/model '+model,model})){
          record.seedRejected=true;await this.save(record);throw fail('SEED_REJECTED','writer 释放后的 bootstrap 记录未通过核验');
        }
        if(record.title)await this.renameBeforeImport(record,{cwd,model,permissionMode});
      }
      if(record.phase==='renaming')throw pending(id,'renaming'); // Never replay an uncertain rename.
      if(record.phase==='titlePersisted'){
        if(!record.titleValidated||!Number.isSafeInteger(record.titlePid)||this.isPidAlive(record.titlePid))throw pending(id,'titlePersisted');
        record.phase='titleWriterReleased';record.titleReleaseEvidence='pid-gone-after-restart';await this.save(record);
      }
      if(record.title&&(record.phase==='titleWriterReleased'||record.phase==='importRequested'&&!(await this.readState(id)).attached)){
        if(!record.titleValidated||!Number.isSafeInteger(record.titlePid)||this.isPidAlive(record.titlePid))throw pending(id,record.phase);
        await this.verifyTitle(record,model);
      }
      return this.waitAttached(id,record);
    });
  }
}
