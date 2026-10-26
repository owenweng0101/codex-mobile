import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {CodexCore} from './core.mjs';
import {forkThreadAtTurn} from './desktop-bridge.mjs';

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function desktopThreadUrl(threadId) {
  if (!UUID.test(threadId)) throw new Error('会话标识无效');
  return `codex://threads/${threadId}`;
}
export async function ensureDesktopOwner(threadId,{isOwned,isStale,owner,attach}) {
  desktopThreadUrl(threadId);
  const unavailable=cause=>Object.assign(new Error('与电脑端此会话的连接状态尚未确认，请重新连接并核对后再操作'),{statusCode:503,cause});
  if(isOwned())throw Object.assign(new Error('这条会话仍由手机后台旧引擎持有，请等待现有任务结束并重启手机服务后再连接 Codex 桌面'),{threadId,persisted:true,writerReleased:false,needsAttach:true,recoverable:true});
  if(isStale())throw unavailable();
  let current;try{current=await owner();}catch(error){throw unavailable(error);}
  if(isStale())throw unavailable();
  if(current)return current;
  try {
    await attach();
    if(isStale())throw unavailable();
    current=await owner();if(!current)throw new Error('电脑端尚未接管原会话');
    return current;
  } catch(cause) {
    if(cause.statusCode===503)throw cause;
    throw Object.assign(new Error('Codex 桌面尚未接管这条会话，请重试连接原会话后再操作'),{threadId,persisted:true,writerReleased:true,needsAttach:true,recoverable:true,cause});
  }
}
async function openDesktopThread(threadId) {
  if (process.platform !== 'darwin') throw new Error('当前系统暂不支持 Codex 桌面会话交接');
  await execute('/usr/bin/open', [desktopThreadUrl(threadId)], {timeout:10000});
}

// A creator owns a writer even after thread/unsubscribe. Always use a separate
// short-lived app-server; never pass the shared mobile execution core here.
async function closeCreator(core, timeout) {
  const child = core.child;
  if (!child || child.exitCode != null || child.signalCode != null) { core.stop(); return; }
  await new Promise((resolve, reject) => {
    let killTimer, deadline;
    const finish = error => { clearTimeout(killTimer); clearTimeout(deadline); child.off('exit', exited); error ? reject(error) : resolve(); };
    const exited = () => finish();
    child.once('exit', exited);
    killTimer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, timeout - 1000));
    deadline = setTimeout(() => finish(new Error('创建服务尚未释放会话，请稍后重试交接')), timeout);
    try { core.stop(); } catch (error) { finish(error); }
  });
}

export class DesktopIntent {
  constructor({desktop, executable, createCore = options => new CodexCore(options), openThread = openDesktopThread, attachTimeoutMs = 15000, probeTimeoutMs = 1500, pollMs = 250, persistTimeoutMs = 3000, closeTimeoutMs = 5000, initializeTimeoutMs = 10000, operationTimeoutMs = 15000, metadataTimeoutMs = 5000} = {}) {
    if (!desktop) throw new Error('需要 Codex 桌面连接');
    this.desktop = desktop; this.executable = executable; this.createCore = createCore; this.openThread = openThread;
    this.attachTimeoutMs = attachTimeoutMs; this.probeTimeoutMs = probeTimeoutMs; this.pollMs = pollMs; this.persistTimeoutMs = persistTimeoutMs; this.closeTimeoutMs = closeTimeoutMs;
    this.initializeTimeoutMs=initializeTimeoutMs; this.operationTimeoutMs=operationTimeoutMs; this.metadataTimeoutMs=metadataTimeoutMs;
    this.serial = Promise.resolve();
  }
  enqueue(operation) {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {}); return next;
  }
  create(options = {}) { return this.enqueue(() => this.createThread(options)); }
  fork(threadId, options = {}) { return this.enqueue(() => this.forkThread(threadId, options)); }
  attach(threadId, options = {}) { return this.enqueue(() => this.attachThread(threadId, options)); }
  async attachThread(threadId, {timeout = this.attachTimeoutMs} = {}) {
    desktopThreadUrl(threadId);
    await this.openThread(threadId);
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const owner = await this.desktop.owner(threadId, {timeout:Math.max(1, Math.min(this.probeTimeoutMs, deadline - Date.now()))});
        if (owner) return {threadId, desktop:{attached:true,persisted:true,writerReleased:true}};
      } catch (error) { lastError = error; }
      await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
    throw Object.assign(new Error('会话已创建，Codex 桌面尚未完成接管，请重试打开该会话'), {code:'DESKTOP_ATTACH_TIMEOUT',threadId,persisted:true,writerReleased:true,cause:lastError});
  }
  async createThread(options) {
    if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd)) throw new Error('请输入工作目录的完整路径');
    const directory = await stat(options.cwd);
    if (!directory.isDirectory()) throw new Error('请选择工作目录');
    const title = typeof options.name === 'string' && options.name.trim() ? options.name.trim().slice(0,200) : '新任务';
    const params = {cwd:options.cwd,ephemeral:false,threadSource:'user'};
    for (const key of ['model','approvalPolicy','sandbox','projectId']) if (options[key] != null) params[key] = options[key];
    if (options.effort) params.config = {model_reasoning_effort:options.effort};
    let core, result, released = false, persisted = false, stage='initialize';
    try {
      core = this.createCore({cwd:options.cwd,...(this.executable ? {executable:this.executable} : {})});
      await core.start({timeoutMs:this.initializeTimeoutMs});
      stage='thread/start'; result = await core.call('thread/start', params, this.operationTimeoutMs);
      desktopThreadUrl(result.thread.id);
      await options.onCreated?.({threadId:result.thread.id,persisted:false,writerReleased:false});
      if (result.thread.turns?.length) throw new Error('新会话包含意外的历史消息');
      // Naming persists the otherwise lazy empty rollout without a model call.
      stage='thread/name/set'; await core.call('thread/name/set', {threadId:result.thread.id,name:title}, this.metadataTimeoutMs);
      const deadline = Date.now() + this.persistTimeoutMs;
      while (Date.now() < deadline) {
        try { const info = await stat(result.thread.path); if (info.isFile() && info.size > 0) { persisted = true; break; } } catch {}
        await delay(Math.min(50,this.persistTimeoutMs));
      }
      if (!persisted) throw new Error('新会话尚未保存，暂时无法交给 Codex 桌面');
      await options.onPersisted?.({threadId:result.thread.id,persisted:true,writerReleased:false});
      stage='thread/unsubscribe'; await core.call('thread/unsubscribe', {threadId:result.thread.id}, this.metadataTimeoutMs);
      await closeCreator(core,this.closeTimeoutMs); core = null; released = true;
      stage='desktop/attach';
      await this.attachThread(result.thread.id);
      return {...result,thread:{...result.thread,name:title},desktop:{attached:true,persisted:true,writerReleased:true},settings:{name:title,model:result.model,effort:result.reasoningEffort,approvalPolicy:result.approvalPolicy,...(options.sandbox ? {sandbox:options.sandbox} : {})}};
    } catch (error) {
      error.stage ||= stage;
      if (core) { await closeCreator(core,this.closeTimeoutMs); core = null; released = true; }
      if (result?.thread?.id) Object.assign(error,{threadId:result.thread.id,persisted,writerReleased:released});
      throw error;
    } finally {
      if (core) await closeCreator(core,this.closeTimeoutMs);
    }
  }
  async forkThread(threadId, options) {
    desktopThreadUrl(threadId);
    const hasLast = options.lastTurnId !== undefined, hasBefore = options.beforeTurnId !== undefined;
    if (hasLast && hasBefore || (hasLast || hasBefore) && options.wholeThread === true) throw new Error('分叉位置只能选择一个');
    if (hasLast && (typeof options.lastTurnId !== 'string' || !options.lastTurnId.trim()) || hasBefore && (typeof options.beforeTurnId !== 'string' || !options.beforeTurnId.trim())) throw new Error('请选择明确的分叉消息位置');
    if (!hasLast && !hasBefore && options.wholeThread !== true) throw new Error('分叉整个当前会话需要明确选择');
    if (options.cwd !== undefined && (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || !(await stat(options.cwd)).isDirectory())) throw new Error('请选择存在的工作目录完整路径');
    const boundary = hasBefore ? options.beforeTurnId : options.lastTurnId;
    let core, result, persisted = false, released = false, stage='initialize';
    try {
      core = this.createCore({ ...(options.cwd ? { cwd: options.cwd } : {}), ...(this.executable ? { executable: this.executable } : {}) }); await core.start({timeoutMs:this.initializeTimeoutMs});
      stage='thread/fork'; const boundedCore={call:(method,params)=>core.call(method,params,this.operationTimeoutMs)};
      result = boundary != null ? await forkThreadAtTurn(boundedCore, threadId, { turnId: boundary, before: options.beforeTurnId != null }) : await core.call('thread/fork', { threadId, ephemeral:false, excludeTurns:true, deferGoalContinuation:true, threadSource:'user' }, this.operationTimeoutMs);
      desktopThreadUrl(result.thread.id);
      const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim().slice(0,200) : result.thread.name || '任务副本';
      stage='thread/name/set'; await core.call('thread/name/set', { threadId: result.thread.id, name }, this.metadataTimeoutMs);
      if (options.projectId) { stage='thread/metadata/update'; await core.call('thread/metadata/update', { threadId: result.thread.id, projectId: options.projectId }, this.metadataTimeoutMs); }
      const info = await stat(result.thread.path); if (!info.isFile() || info.size === 0) throw new Error('会话副本尚未保存'); persisted = true;
      stage='thread/unsubscribe'; await core.call('thread/unsubscribe', { threadId: result.thread.id }, this.metadataTimeoutMs); await closeCreator(core, this.closeTimeoutMs); core = null; released = true;
      stage='desktop/attach';
      await this.attachThread(result.thread.id);
      return { ...result, thread: { ...result.thread, name }, desktop: { attached:true, persisted:true, writerReleased:true }, settings: { name, model:result.model, effort:result.reasoningEffort, approvalPolicy:result.approvalPolicy } };
    } catch (error) {
      error.stage ||= stage;
      if (core) { await closeCreator(core, this.closeTimeoutMs); core = null; released = true; }
      if (result?.thread?.id) Object.assign(error, { threadId: result.thread.id, persisted, writerReleased: released });
      throw error;
    } finally { if (core) await closeCreator(core, this.closeTimeoutMs); }
  }
}
