import net from 'node:net';
import { EventEmitter } from 'node:events';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { messageBusy } from './message-delivery.mjs';

// Codex Desktop's same-user multi-client coordinator. This is separate from the
// code-signing-protected app-tools socket; no app identity or key is impersonated.
const VERSIONS = {
  'thread-owner-discovery': 1, 'thread-follower-start-turn': 2,
  'thread-follower-load-complete-history': 1, 'thread-follower-steer-turn': 1,
  'thread-follower-compact-thread': 1, 'thread-follower-edit-last-user-turn': 2,
  'thread-follower-interrupt-turn': 4, 'thread-follower-read-model-settings': 1,
  'thread-follower-command-approval-decision': 1, 'thread-follower-file-approval-decision': 1,
  'thread-follower-permissions-request-approval-response': 1,
  'thread-follower-submit-user-input': 1, 'thread-follower-submit-mcp-server-elicitation-response': 1,
  'thread-stream-following-changed': 1, 'thread-stream-state-changed': 11,
};
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const clone = value => structuredClone(value);
const bridgeError = (message, code, outcomeUnknown = false) => Object.assign(new Error(message), { code, outcomeUnknown });

export function encodeDesktopFrame(message) {
  const data = Buffer.from(JSON.stringify(message));
  if (!data.length || data.length > MAX_FRAME_BYTES) throw new Error('桌面消息长度无效');
  const frame = Buffer.allocUnsafe(data.length + 4); frame.writeUInt32LE(data.length); data.copy(frame, 4); return frame;
}

// Immer JSON patches use path arrays. Reject prototype paths and unresolved
// parents rather than allowing malformed/stale input to corrupt the cache.
export function applyDesktopPatches(state, patches) {
  if (!Array.isArray(patches)) throw new Error('桌面状态更新格式无效');
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some(k => FORBIDDEN_KEYS.has(String(k))) || !['add', 'replace', 'remove'].includes(patch.op)) throw new Error('桌面状态路径无效');
    if (!patch.path.length) { if (patch.op !== 'replace') throw new Error('桌面根状态更新无效'); state = clone(patch.value); continue; }
    let target = state;
    for (const key of patch.path.slice(0, -1)) {
      if (target == null || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('桌面状态版本不一致');
      target = target[key];
    }
    const key = patch.path.at(-1);
    if (target == null || typeof target !== 'object') throw new Error('桌面状态版本不一致');
    if (Array.isArray(target)) {
      const index = key === '-' ? target.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > target.length || (patch.op !== 'add' && index === target.length)) throw new Error('桌面数组位置无效');
      if (patch.op === 'add') target.splice(index, 0, clone(patch.value));
      else if (patch.op === 'remove') target.splice(index, 1);
      else target[index] = clone(patch.value);
    } else if (patch.op === 'remove') delete target[key];
    else target[key] = clone(patch.value);
  }
  return state;
}

export function desktopTurns(state) {
  const history = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  if (!history?.entitiesByKey) return Array.isArray(state?.turns) ? state.turns : [];
  const turns = [], seen = new Set();
  for (const island of history.islands || []) for (const entry of island.entries || []) {
    const key = typeof entry === 'string' ? entry : entry.value ?? entry.key;
    if (!seen.has(key) && history.entitiesByKey[key]) { seen.add(key); turns.push(history.entitiesByKey[key]); }
  }
  return turns;
}

export function normalizeDesktopInput(input) {
  if (!Array.isArray(input)) throw new Error('消息内容格式无效');
  return input.map(item => {
    if (!item || typeof item !== 'object') throw new Error('消息内容格式无效');
    if (item.type === 'text') {
      if (typeof item.text !== 'string') throw new Error('消息正文格式无效');
      return { ...item, text_elements: Array.isArray(item.text_elements) ? item.text_elements : [] };
    }
    return { ...item };
  });
}

function normalizeTurn(turn, index) {
  const items = [], input = turn.params?.input || [];
  const requestId=typeof turn.params?.clientUserMessageId==='string'&&turn.params.clientUserMessageId?turn.params.clientUserMessageId:null;
  const steeringIds=new Set((turn.items||[]).filter(item=>item.type==='steeringUserMessage').flatMap(item=>[item.id,item.serverUserMessageId]).filter(Boolean));
  const initialUser=(turn.items||[]).find(item=>item.type==='userMessage'&&!steeringIds.has(item.id));
  const steeringRequests=new Map((turn.items||[]).filter(item=>item.type==='steeringUserMessage'&&typeof item.serverUserMessageId==='string'&&/^zcv4_[a-f0-9]{48}$/.test(item.clientUserMessageId||item.id||'')).map(item=>[item.serverUserMessageId,item.clientUserMessageId||item.id]));
  const serverUserIds = new Set((turn.items || []).filter(i => i.type === 'userMessage').map(i => i.id));
  for (const item of turn.items || []) {
    if (item.type === 'steeringUserMessage') {
      if (item.status !== 'failed' && !serverUserIds.has(item.serverUserMessageId)) items.push({ id: item.serverUserMessageId || item.id, type: 'userMessage', content: item.input || [], ...(/^zcv4_[a-f0-9]{48}$/.test(item.clientUserMessageId||item.id||'')?{clientUserMessageId:item.clientUserMessageId||item.id}:{}) });
    } else if (item.type === 'subAgentActivity') {
      items.push({ id: item.id, type: 'collabAgentToolCall', tool: '子任务', status: item.kind === 'started' ? 'inProgress' : 'completed', agentsStates: item.agentThreadId ? { [item.agentThreadId]: { status: item.kind === 'started' ? 'running' : item.kind } } : {} });
    } else if (item.type === 'error') {
      // Turn-level error is retained below; do not emit internal protocol rows.
    } else if (['userMessage','agentMessage','imageGeneration','reasoning','commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','collabAgentToolCall','plan','contextCompaction'].includes(item.type)) items.push(item.type==='userMessage'&&steeringRequests.has(item.id)?{...item,clientUserMessageId:steeringRequests.get(item.id)}:item===initialUser&&requestId&&input.length&&!item.clientUserMessageId?{...item,clientUserMessageId:requestId}:item);
  }
  if ((!items.some(i => i.type === 'userMessage')||requestId&&!initialUser) && input.length) items.unshift({ id: requestId || `desktop-input-${turn.turnId || index}`, type: 'userMessage', content: input, ...(requestId?{clientUserMessageId:requestId}:{}) });
  return { id: turn.turnId || turn.params?.clientUserMessageId || `desktop-turn-${index}`, status: turn.status || 'completed', items, error: turn.error || null, startedAt: turn.turnStartedAtMs ? turn.turnStartedAtMs / 1000 : null, completedAt: turn.durationMs != null && turn.turnStartedAtMs ? (turn.turnStartedAtMs + turn.durationMs) / 1000 : null, durationMs: turn.durationMs ?? null };
}

function exactStartedTurn(state,threadId,requestId){
  if(state?.id!==threadId)return null;
  const matches=desktopTurns(state).filter(turn=>turn.params?.clientUserMessageId===requestId);
  if(!matches.length)return null;
  if(matches.length!==1||typeof matches[0].turnId!=='string'||!matches[0].turnId||!['inProgress','completed','interrupted','failed'].includes(matches[0].status))throw bridgeError('原操作的原生回执尚未确认，请检查该会话，勿重复发送','DESKTOP_PROTOCOL',true);
  return{turn:normalizeTurn(matches[0],0)};
}

function recordedTurnDiff(turn) {
  if(typeof turn.turnId!=='string'||!turn.turnId)return null;
  if(typeof turn.diff==='string')return {turnId:turn.turnId,diff:turn.diff};
  const fileChanges=[];
  for(const item of turn.items||[]){
    if(item.type!=='fileChange'||item.status!=='completed'||typeof item.id!=='string')continue;
    const changes=(Array.isArray(item.changes)?item.changes:[]).filter(change=>change&&typeof change.path==='string'&&typeof change.diff==='string'&&['add','delete','update'].includes(change.kind?.type)).map(change=>({path:change.path,diff:change.diff,kind:{type:change.kind.type,...(change.kind.type==='update'&&typeof (change.kind.move_path??change.kind.movePath)==='string'?{move_path:change.kind.move_path??change.kind.movePath}:{})}}));
    if(changes.length)fileChanges.push({id:item.id,status:'completed',changes});
  }
  return fileChanges.length?{turnId:turn.turnId,recordedChanges:true,fileChanges}:null;
}

export function desktopHistory(state) {
  if (!state) return null;
  const originalTurns = desktopTurns(state), turns = originalTurns.map(normalizeTurn);
  const turnDiff = originalTurns.map(recordedTurnDiff).findLast(Boolean)||null;
  const active = turns.findLast(t => t.status === 'inProgress');
  const requests = (state.requests || []).filter(r => r && r.id != null && r.method && r.params);
  const permissions = state.currentPermissions || {};
  const collaboration = state.latestCollaborationMode, modeSettings = collaboration?.settings;
  const model = modeSettings?.model || state.latestModel;
  const effort = modeSettings && Object.hasOwn(modeSettings,'reasoning_effort') ? modeSettings.reasoning_effort : state.latestReasoningEffort;
  const policy = permissions.sandboxPolicy?.type;
  return {
    desktop: true, attached: true,
    thread: { id: state.id, name: state.title, cwd: state.cwd, model, reasoningEffort: effort, createdAt: state.createdAt ? state.createdAt / 1000 : null, updatedAt: state.updatedAt ? state.updatedAt / 1000 : null, status: state.threadRuntimeStatus },
    turns, activeTurn: active?.id || null,
    approvals: requests.map(r => ({ id: 'desktop:' + String(r.id), method: r.method, ...r.params })),
    settings: { model, effort, mode:collaboration?.mode, approvalPolicy: permissions.approvalPolicy, ...({ dangerFullAccess:'danger-full-access', readOnly:'read-only', workspaceWrite:'workspace-write' }[policy] ? { sandbox: { dangerFullAccess:'danger-full-access', readOnly:'read-only', workspaceWrite:'workspace-write' }[policy] } : {}) },
    tokenUsage: state.latestTokenUsageInfo || null, plan: state.plan || null,
    diff: turnDiff?.diff ?? null, turnDiff,
  };
}

export function trimIdleDesktopSubscriptions(access, isProtected, release, limit = 24) {
  const idle = [...access.keys()].filter(id => !isProtected(id));
  for (const id of idle.slice(0, Math.max(0, idle.length - limit))) { access.delete(id); release(id); }
}

// Fork boundaries are official experimental app-server fields, not coordinator
// topics. The supplied core owns only the resulting fork; its caller must release
// that writer before handing the new ID to DesktopIntent.attach().
export async function forkThreadAtTurn(core, threadId, {turnId, before = false} = {}) {
  if (!core || typeof core.call !== 'function') throw new Error('需要 Codex 会话服务');
  if (typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId) throw new Error('请选择明确的会话和消息位置');
  if (typeof before !== 'boolean') throw new Error('分叉位置无效');
  return core.call('thread/fork', {threadId, [before ? 'beforeTurnId' : 'lastTurnId']:turnId, ephemeral:false, excludeTurns:false, deferGoalContinuation:true, threadSource:'user'});
}

export class DesktopBridge extends EventEmitter {
  constructor({ socketPath, requestTimeoutMs = 5000, snapshotTimeoutMs = 1500, reconnectDelayMs = 1000, snapshotThrottleMs = 100 } = {}) {
    super(); this.socketPath = socketPath; this.requestTimeoutMs = requestTimeoutMs; this.snapshotTimeoutMs = snapshotTimeoutMs; this.reconnectDelayMs = reconnectDelayMs; this.snapshotThrottleMs = snapshotThrottleMs;
    this.clientId = 'initializing-client'; this.pending = new Map(); this.owners = new Map(); this.noOwners = new Map(); this.states = new Map(); this.followed = new Set(); this.snapshotWaiters = new Map(); this.ownerRequests = new Map(); this.snapshotRequests = new Map(); this.receipts = new Map(); this.emitTimers = new Map(); this.lastActive = new Map(); this.closed = false; this.online = false;
  }
  async start() {
    if (this.closed) throw bridgeError('桌面连接已关闭', 'DESKTOP_CLOSED');
    if (this.online) return this;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; }); return this.connecting;
  }
  async endpoint() {
    const candidates = this.socketPath ? [this.socketPath] : [join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'ipc', 'ipc.sock'), join('/tmp', 'codex-ipc', process.getuid?.() ? `ipc-${process.getuid()}.sock` : 'ipc.sock')];
    for (const candidate of candidates) {
      try {
        const [socket, folder] = await Promise.all([lstat(candidate), lstat(dirname(candidate))]);
        if (!socket.isSocket() || socket.isSymbolicLink() || !folder.isDirectory() || folder.isSymbolicLink() || socket.uid !== process.getuid?.() || folder.uid !== process.getuid?.() || folder.mode & 0o022 || socket.mode & 0o077) continue;
        return candidate;
      } catch {}
    }
    throw bridgeError('Codex 桌面未运行或本机连接暂不可用', 'DESKTOP_UNAVAILABLE');
  }
  async connect() {
    const endpoint = await this.endpoint(); if (this.closed) throw bridgeError('桌面连接已关闭', 'DESKTOP_CLOSED');
    const socket = net.createConnection(endpoint); this.socket = socket; this.buffer = Buffer.alloc(0);
    socket.on('data', data => this.acceptBytes(socket, data));
    socket.on('error', error => this.emit('diagnostic', error.message));
    socket.on('close', () => this.disconnected(socket));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(bridgeError('桌面连接超时', 'DESKTOP_TIMEOUT')); }, this.requestTimeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const initialized = await this.request('initialize', { clientType: 'codex-mobile' }, { initialize: true });
    if (!initialized?.clientId) { socket.destroy(); throw bridgeError('桌面初始化失败', 'DESKTOP_PROTOCOL'); }
    this.clientId = initialized.clientId; this.online = true;
    this.emit('event', { method:'bridge/desktopOnline', params:{} });
    for (const threadId of this.followed) this.owner(threadId).then(owner => { if (owner) this.follow(threadId, owner); }).catch(() => {});
    return this;
  }
  write(message) {
    if (!this.socket?.writable || this.closed) throw bridgeError('Codex 桌面连接已断开', 'DESKTOP_OFFLINE');
    this.socket.write(encodeDesktopFrame(message));
  }
  async notifyUnarchived(threadId) {
    if(typeof threadId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))throw new Error('会话标识无效');
    await this.start();
    this.write({type:'broadcast',method:'thread-unarchived',sourceClientId:this.clientId,version:1,params:{hostId:'local',conversationId:threadId}});
    this.noOwners.delete(threadId);
    return {notified:true};
  }
  request(method, params, { targetClientId, timeout = this.requestTimeoutMs, mutation = false, initialize = false } = {}) {
    if (!initialize && !this.online) return Promise.reject(bridgeError('Codex 桌面连接未就绪', 'DESKTOP_OFFLINE'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(bridgeError(mutation ? '桌面尚未确认操作结果，请刷新任务后检查，避免重复发送' : '桌面读取超时', 'DESKTOP_TIMEOUT', mutation)); }, timeout);
      this.pending.set(requestId, { resolve, reject, timer, mutation });
      try { this.write({ type:'request', requestId, sourceClientId:this.clientId, version:VERSIONS[method] || 0, method, params, ...(targetClientId ? { targetClientId } : {}), timeoutMs:timeout }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  acceptBytes(socket, data) {
    if (socket !== this.socket) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) { this.emit('diagnostic', '桌面消息长度无效'); socket.destroy(); return; }
      if (this.buffer.length < length + 4) return;
      const bytes = this.buffer.subarray(4, length + 4); this.buffer = this.buffer.subarray(length + 4);
      try { this.accept(JSON.parse(bytes.toString('utf8'))); } catch (error) { this.emit('diagnostic', error.message); }
    }
  }
  accept(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId); if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.resultType === 'success') { const discovery = this.discoveryIds?.delete(message.requestId); pending.resolve(discovery ? { ...message.result, clientId:message.handledByClientId } : message.result); }
      else { this.discoveryIds?.delete(message.requestId); pending.reject(bridgeError(message.error === 'no-client-found' ? '此会话尚未由 Codex 桌面打开' : message.error || '桌面操作失败', message.error === 'no-client-found' ? 'DESKTOP_NO_OWNER' : 'DESKTOP_REQUEST_FAILED')); }
      return;
    }
    if (message.type === 'client-discovery-request') { this.write({ type:'client-discovery-response', requestId:message.requestId, response:{canHandle:false} }); return; }
    if (message.type !== 'broadcast') return;
    if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
    if (message.method === 'client-status-changed' && message.params?.status === 'disconnected') {
      for (const [id, owner] of this.owners) if (owner.clientId === message.params.clientId) { this.owners.delete(id); this.states.delete(id); this.emit('event', { method:'bridge/desktopOffline', params:{threadId:id} }); }
      return;
    }
    if (message.method === 'client-status-changed' && message.params?.status === 'connected') {
      for (const id of this.followed) if (!this.owners.has(id)) { this.noOwners.delete(id); this.owner(id).then(owner => { if (owner && this.followed.has(id)) this.follow(id, owner); }).catch(() => {}); }
      return;
    }
    if (message.method !== 'thread-stream-state-changed' || message.version !== 11) return;
    const { conversationId:threadId, hostId, change } = message.params || {};
    if (hostId !== 'local' || !this.followed.has(threadId) || !change) return;
    const owner = this.owners.get(threadId); if (!owner || owner.clientId !== message.sourceClientId) return;
    if (change.type === 'snapshot') {
      if (!change.conversationState || change.conversationState.id !== threadId) return;
      this.states.set(threadId, { state:change.conversationState, revision:change.revision });
    } else if (change.type === 'patches') {
      const current = this.states.get(threadId);
      if (!current || current.revision !== change.baseRevision) { this.refreshSnapshot(threadId, owner.clientId); return; }
      try { current.state = applyDesktopPatches(current.state, change.patches); current.revision = change.revision; }
      catch { this.states.delete(threadId); this.refreshSnapshot(threadId, owner.clientId); return; }
    } else return;
    const entry = this.states.get(threadId);
    for (const waiter of this.snapshotWaiters.get(threadId) || []) waiter.resolve(entry.state);
    this.snapshotWaiters.delete(threadId); this.scheduleSnapshot(threadId);
  }
  async owner(threadId, { timeout = this.snapshotTimeoutMs } = {}) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('会话标识无效');
    await this.start(); if (Date.now() - (this.noOwners.get(threadId) || 0) < 2000) return null; const cached = this.owners.get(threadId);
    if (cached && Date.now() - cached.time < 3000) return cached.clientId;
    if (!this.ownerRequests.has(threadId)) {
      const requestId = randomUUID();
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(requestId); this.discoveryIds?.delete(requestId); reject(bridgeError('桌面读取超时', 'DESKTOP_TIMEOUT')); }, timeout);
        // Discovery needs handledByClientId, unlike regular coordinator replies.
        this.pending.set(requestId, { timer, mutation:false, resolve:result => resolve(result), reject });
        this.discoveryIds ||= new Set(); this.discoveryIds.add(requestId);
        try { this.write({type:'request',requestId,sourceClientId:this.clientId,version:1,method:'thread-owner-discovery',params:{hostId:'local',conversationId:threadId},timeoutMs:timeout}); }
        catch(error){clearTimeout(timer);this.pending.delete(requestId);reject(error);}
      }).then(result => { if (this.ownerRequests.get(threadId) !== promise || !result?.clientId) return null; this.owners.set(threadId,{clientId:result.clientId,time:Date.now(),supportsUntrustedAppInput:result.supportsUntrustedAppInput}); return result.clientId; }).catch(error => { if(error.code==='DESKTOP_NO_OWNER'){if(this.ownerRequests.get(threadId)===promise){this.owners.delete(threadId);this.noOwners.set(threadId,Date.now());}return null;}throw error; }).finally(()=>{if(this.ownerRequests.get(threadId)===promise)this.ownerRequests.delete(threadId);});
      this.ownerRequests.set(threadId,promise);
    }
    return this.ownerRequests.get(threadId);
  }
  follow(threadId, owner) {
    this.followed.add(threadId);
    this.write({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:this.clientId,targetClientIds:[owner],params:{conversationId:threadId,hostId:'local',following:true},version:1});
  }
  unfollow(threadId) {
    const owner = this.owners.get(threadId);
    if (this.followed.has(threadId) && owner) { try { this.write({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:this.clientId,targetClientIds:[owner.clientId],params:{conversationId:threadId,hostId:'local',following:false},version:1}); } catch {} }
    this.followed.delete(threadId); this.states.delete(threadId); this.owners.delete(threadId); this.noOwners.delete(threadId); this.lastActive.delete(threadId); this.ownerRequests.delete(threadId); this.resyncing?.delete(threadId);
    clearTimeout(this.emitTimers.get(threadId)); this.emitTimers.delete(threadId);
    for (const waiter of this.snapshotWaiters.get(threadId) || []) waiter.reject(bridgeError('已停止跟随该会话', 'DESKTOP_UNFOLLOWED'));
    this.snapshotWaiters.delete(threadId); this.snapshotRequests.delete(threadId);
  }
  refreshSnapshot(threadId, owner) {
    if (!this.resyncing) this.resyncing = new Set(); if(this.resyncing.has(threadId))return;
    this.resyncing.add(threadId); try { this.follow(threadId,owner); } catch {}
    const timer=setTimeout(()=>this.resyncing.delete(threadId),500);timer.unref?.();
  }
  async snapshot(threadId, {timeout=this.snapshotTimeoutMs,fresh=false}={}) {
    const owner=await this.owner(threadId,{timeout});if(!owner)return null;
    if(!fresh&&this.states.has(threadId)){this.followed.add(threadId);return this.states.get(threadId).state;}
    if(!this.snapshotRequests.has(threadId)) {
      const pending=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.snapshotWaiters.get(threadId)?.delete(waiter);reject(bridgeError('桌面快照读取超时','DESKTOP_TIMEOUT'));},timeout);
        const waiter={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
        if(!this.snapshotWaiters.has(threadId))this.snapshotWaiters.set(threadId,new Set());this.snapshotWaiters.get(threadId).add(waiter);
        try{this.follow(threadId,owner);}catch(error){clearTimeout(timer);this.snapshotWaiters.get(threadId).delete(waiter);reject(error);}
      }).finally(()=>{if(this.snapshotRequests.get(threadId)===pending)this.snapshotRequests.delete(threadId);});
      this.snapshotRequests.set(threadId,pending);
    }
    return this.snapshotRequests.get(threadId);
  }
  async history(threadId,{timeout=this.snapshotTimeoutMs,loadAll=false}={}) {
    const state=await this.snapshot(threadId,{timeout});if(!state)return null;
    if(loadAll){await this.follower(threadId,'thread-follower-load-complete-history',{}, {timeout:300000});return desktopHistory(await this.snapshot(threadId,{timeout,fresh:true}));}
    return desktopHistory(state);
  }
  compact(threadId, {requestId = randomUUID()} = {}) {
    return this.onceMutation(`compact:${threadId}:${requestId}`, () => this.follower(threadId,'thread-follower-compact-thread',{}, {mutation:true,timeout:120000}));
  }
  editUserTurn(threadId, options = {}) {
    if (typeof options.turnId !== 'string' || !options.turnId || typeof options.message !== 'string' || !options.message.trim()) return Promise.reject(new Error('请选择消息并输入修改内容'));
    const requestId = options.requestId || randomUUID();
    return this.onceMutation(`edit:${threadId}:${requestId}`, async () => {
      const state = await this.snapshot(threadId);
      if (!state) throw bridgeError('此会话尚未由 Codex 桌面打开','DESKTOP_NO_OWNER');
      const turns = desktopTurns(state), index = turns.findIndex(t => t.turnId === options.turnId);
      if (index === -1) throw bridgeError('所选消息尚未加载，请加载历史后重试','DESKTOP_TURN_NOT_FOUND');
      if (turns.slice(index).some(t => t.status === 'inProgress')) throw new Error('任务正在运行，停止后再编辑消息');
      if (options.allowEarlierMessages !== true && turns.slice(index + 1).some(t => t.params?.input?.length)) throw new Error('编辑较早消息会替换后续对话，请先明确选择该操作');
      const params = {turnId:options.turnId,message:options.message,allowEarlierMessages:options.allowEarlierMessages === true};
      for (const key of ['agentMode','shouldSendPermissionOverrides','serviceTier','additionalContext']) if (options[key] !== undefined) params[key] = options[key];
      return this.follower(threadId,'thread-follower-edit-last-user-turn',params,{mutation:true,timeout:120000});
    });
  }
  async modelSettings(threadId) { return (await this.follower(threadId,'thread-follower-read-model-settings',{})).settings; }
  async follower(threadId,method,params,{timeout=this.requestTimeoutMs,mutation=false}={}) {
    const owner=await this.owner(threadId);if(!owner)throw bridgeError('此会话尚未由 Codex 桌面打开','DESKTOP_NO_OWNER');
    return this.request(method,{conversationId:threadId,...params},{targetClientId:owner,timeout,mutation});
  }
  onceMutation(key,operation) {
    if(this.receipts.has(key))return this.receipts.get(key);
    const pending=operation().catch(error=>{if(!error.outcomeUnknown)this.receipts.delete(key);throw error;});this.receipts.set(key,pending);
    if(this.receipts.size>300)this.receipts.delete(this.receipts.keys().next().value);return pending;
  }
  send(threadId,options={}) {
    if(!Array.isArray(options.input)||!options.input.length)return Promise.reject(new Error('请输入消息'));
    const requestId=options.requestId||randomUUID();
    return this.onceMutation(`send:${threadId}:${requestId}`,async()=>{
      const state=await this.snapshot(threadId, options.delivery==='startNow'?{fresh:true}:{});if(!state)throw bridgeError('此会话尚未由 Codex 桌面打开','DESKTOP_NO_OWNER');
      const previous=exactStartedTurn(state,threadId,requestId);if(previous)return previous;
      if(options.delivery==='startNow'&&desktopHistory(state).activeTurn)throw messageBusy();
      const request={threadId,input:normalizeDesktopInput(options.input),clientUserMessageId:requestId};
      for(const key of ['model','effort','approvalPolicy','sandboxPolicy','collaborationMode','serviceTier'])if(options[key]!==undefined)request[key]=options[key];
      if(options.sandbox){const type={'danger-full-access':'dangerFullAccess','read-only':'readOnly','workspace-write':'workspaceWrite'}[options.sandbox];if(!type)throw new Error('文件权限无效');request.sandboxPolicy={type,...(type==='workspaceWrite'?{writableRoots:[state.cwd],networkAccess:true}:type==='readOnly'?{networkAccess:true}:{})};}
      let failure;
      try{
        const result=await this.follower(threadId,'thread-follower-start-turn',{turnStart:{request,context:{inheritThreadSettings:true}}},{mutation:true,timeout:120000});
        if(result?.result?.turn?.id)return result.result;
        failure=bridgeError('桌面未返回任务回执，请检查会话后再发送','DESKTOP_PROTOCOL',true);
      }catch(error){failure=error;}
      // The desktop may accept a turn before a later UI-side step rejects the
      // follower RPC. One fresh read can prove acceptance by its exact native
      // clientUserMessageId; never resend or infer success from text/time/idle.
      let fresh;try{fresh=await this.snapshot(threadId,{fresh:true});}catch{}
      const accepted=exactStartedTurn(fresh,threadId,requestId);if(accepted)return accepted;
      if(failure.code==='DESKTOP_REQUEST_FAILED')failure.outcomeUnknown=true;
      throw failure;
    });
  }
  steer(threadId,options={}) {
    if(!Array.isArray(options.input)||!options.input.length)return Promise.reject(new Error('请输入消息'));
    const requestId=options.requestId||randomUUID();
    return this.onceMutation(`steer:${threadId}:${requestId}`,async()=>{
      const state=await this.snapshot(threadId);if(!state)throw bridgeError('此会话尚未由 Codex 桌面打开','DESKTOP_NO_OWNER');
      const active=desktopHistory(state).activeTurn;if(!active)throw Object.assign(new Error('当前任务已结束，本次尚未插入'),{code:'TURN_ENDED',sent:false});
      const result=await this.follower(threadId,'thread-follower-steer-turn',{input:normalizeDesktopInput(options.input),clientUserMessageId:requestId,restoreMessage:{text:options.input.filter(i=>i.type==='text').map(i=>i.text).join('\n'),cwd:state.cwd,context:{workspaceRoots:state.cwd?[state.cwd]:[],collaborationMode:state.latestCollaborationMode,fileAttachments:[],pastedTextAttachments:[],uploadedFileAttachments:[],addedFiles:[],commentAttachments:[]}},...(options.serviceTier!==undefined?{serviceTier:options.serviceTier}:{}),attachments:[]},{mutation:true,timeout:120000});
      if(typeof result?.result?.turn?.id==='string'&&result.result.turn.id)return result.result;
      if(typeof result?.result?.turnId==='string'&&result.result.turnId)return {turnId:result.result.turnId};
      throw bridgeError('桌面未返回插入消息回执，请检查会话，勿重复发送','DESKTOP_PROTOCOL',true);
    });
  }
  interrupt(threadId,turnId) { if(!turnId)return Promise.reject(new Error('缺少需要停止的当前任务'));return this.follower(threadId,'thread-follower-interrupt-turn',{mode:'user-stop',expectedTurnId:turnId},{mutation:true}); }
  async approval(threadId,id,result) {
    const state=await this.snapshot(threadId);const raw=String(id).replace(/^desktop:/,'');const request=state?.requests?.find(r=>String(r.id)===raw);if(!request)throw new Error('该授权请求已经处理或失效');
    let method,params={requestId:request.id};
    if(request.method==='item/commandExecution/requestApproval'){method='thread-follower-command-approval-decision';params.decision=result.decision;}
    else if(request.method==='item/fileChange/requestApproval'){method='thread-follower-file-approval-decision';params.decision=result.decision;}
    else if(request.method==='item/tool/requestUserInput'){method='thread-follower-submit-user-input';params.response=result;}
    else if(request.method==='item/permissions/requestApproval'){method='thread-follower-permissions-request-approval-response';params.response=result;}
    else if(request.method==='mcpServer/elicitation/request'){method='thread-follower-submit-mcp-server-elicitation-response';params.response=result;}
    else throw new Error('请在电脑端处理此类请求');
    return this.onceMutation(`approval:${threadId}:${raw}`,()=>this.follower(threadId,method,params,{mutation:true}));
  }
  scheduleSnapshot(threadId) {
    if(this.emitTimers.has(threadId))return;
    const timer=setTimeout(()=>{this.emitTimers.delete(threadId);const entry=this.states.get(threadId);if(!entry)return;const history=desktopHistory(entry.state),previous=this.lastActive.get(threadId);this.lastActive.set(threadId,history.activeTurn);
      if(previous&&previous!==history.activeTurn){const turn=history.turns.find(t=>t.id===previous);if(turn)this.emit('event',{method:'turn/completed',params:{threadId,turn}});}
      if(history.activeTurn&&previous!==history.activeTurn)this.emit('event',{method:'turn/started',params:{threadId,turn:history.turns.find(t=>t.id===history.activeTurn)}});
      this.emit('event',{method:'bridge/desktopSnapshot',params:{threadId,history,revision:entry.revision}});
    },this.snapshotThrottleMs);timer.unref?.();this.emitTimers.set(threadId,timer);
  }
  disconnected(socket) {
    if(socket!==this.socket)return;this.socket=null;this.online=false;this.clientId='initializing-client';this.owners.clear();this.noOwners.clear();this.states.clear();this.lastActive.clear();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(bridgeError(p.mutation?'桌面连接中断，操作结果待确认，请刷新任务后检查':'Codex 桌面连接中断','DESKTOP_OFFLINE',p.mutation));}this.pending.clear();
    for(const waiters of this.snapshotWaiters.values())for(const w of waiters)w.reject(bridgeError('Codex 桌面连接中断','DESKTOP_OFFLINE'));this.snapshotWaiters.clear();
    this.emit('event',{method:'bridge/desktopOffline',params:{}});
    if(!this.closed&&!this.reconnectTimer){this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.start().catch(()=>this.scheduleReconnect());},this.reconnectDelayMs);this.reconnectTimer.unref?.();}
  }
  scheduleReconnect(){if(!this.closed&&!this.reconnectTimer){this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this.start().catch(()=>this.scheduleReconnect());},this.reconnectDelayMs);this.reconnectTimer.unref?.();}}
  stop() {
    if(this.closed)return;
    for(const id of this.followed){try{const owner=this.owners.get(id);if(owner)this.write({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:this.clientId,targetClientIds:[owner.clientId],params:{conversationId:id,hostId:'local',following:false},version:1});}catch{}}
    this.closed=true;clearTimeout(this.reconnectTimer);for(const timer of this.emitTimers.values())clearTimeout(timer);this.emitTimers.clear();
    const socket=this.socket;socket?.destroy();if(socket)this.disconnected(socket);
  }
}

