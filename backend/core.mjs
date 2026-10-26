import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { readdir, realpath, stat, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { readWorkspaceGit } from './git-view.mjs';

export const DEFAULT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export function collaborationModeFor(mode, model, effort) {
  if (!['default', 'plan'].includes(mode)) throw new Error('不支持的任务模式');
  if (typeof model !== 'string' || !model.trim()) throw new Error('无法读取实际模型，请先选择模型再发送');
  return { mode, settings: { model, reasoning_effort: effort || null, developer_instructions: null } };
}
export class CodexCore extends EventEmitter {
  constructor({ executable = process.env.CODEX_BIN || DEFAULT_CODEX, cwd } = {}) {
    super(); this.executable = executable; this.cwd = cwd; this.pending = new Map(); this.sequence = 0; this.requests = new Map(); this.activeTurns = new Map(); this.tokenUsage = new Map(); this.turnPlans = new Map(); this.turnDiffs = new Map(); this.closed = false;
  }
  async start({ timeoutMs = 120000 } = {}) {
    this.child = spawn(this.executable, ['app-server', '--listen', 'stdio://'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', () => this.fail(new Error('Codex 本机服务已停止')));
    this.child.stderr.on('data', () => {}); // Do not publish local runtime diagnostics or credentials.
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.accept(JSON.parse(line)); } catch (e) { this.emit('diagnostic', e.message); }
    });
    this.info = await this.call('initialize', { clientInfo: { name: 'codex_mobile_local', title: 'Codex Mobile', version: '0.1.0' }, capabilities: { experimentalApi: true } }, timeoutMs);
    this.write({ method: 'initialized' });
    return this;
  }
  write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex 本机服务未连接');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, timeout = 120000) {
    const id = ++this.sequence;
    const mutation = ['turn/start', 'turn/steer'].includes(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(mutation ? '消息已发出，但本机尚未确认结果，请刷新会话核对后再操作' : `${method} 响应超时`), { outcomeUnknown: mutation })); }, timeout);
      this.pending.set(id, { resolve, reject, timer, mutation });
      try { this.write({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  accept(message) {
    if (message.method) {
      if (message.id != null) {
        this.requests.set(String(message.id), message);
        this.emit('event', { method: 'bridge/approval', params: { id: String(message.id), method: message.method, ...message.params } });
        return;
      }
      const p = message.params || {};
      if (message.method === 'turn/started') this.activeTurns.set(p.threadId, p.turn.id);
      if (message.method === 'turn/completed') this.activeTurns.delete(p.threadId);
      if (message.method === 'thread/tokenUsage/updated') this.tokenUsage.set(p.threadId, p.tokenUsage);
      if (message.method === 'turn/plan/updated') this.turnPlans.set(p.threadId, { turnId: p.turnId, explanation: p.explanation, plan: p.plan });
      if (message.method === 'turn/diff/updated') this.turnDiffs.set(p.threadId, { turnId: p.turnId, diff: p.diff });
      this.emit('event', message); return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }
  respond(id, result) {
    const request = this.requests.get(String(id));
    if (!request) throw new Error('请求已经处理或失效');
    this.write({ id: request.id, result }); this.requests.delete(String(id));
    this.emit('event', { method: 'bridge/approvalResolved', params: { id: String(id) } });
  }
  fail(error) {
    if (this.closed) return; this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(p.mutation ? Object.assign(new Error(error.message + '，请核对会话中的发送结果'), { outcomeUnknown: true }) : error); }
    this.pending.clear(); this.emit('event', { method: 'bridge/offline', params: { message: error.message } });
  }
  stop() { this.fail(new Error('服务已停止')); this.child?.kill('SIGTERM'); }
}

export async function workspacePath(root, path = '') {
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) throw new Error('请输入项目内的相对路径');
  const base = await realpath(root), target = await realpath(resolve(base, path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('无法访问工作目录以外的文件');
  return { root: base, target, path: rel };
}
export async function listWorkspaceFiles(root, path = '') {
  const location = await workspacePath(root, path);
  if (!(await stat(location.target)).isDirectory()) throw new Error('此路径不是文件夹');
  const all = (await readdir(location.target, { withFileTypes: true })).filter(e => e.name !== '.git' && e.name !== 'node_modules');
  const entries = await Promise.all(all.slice(0, 500).map(async e => {
    const p = relative(location.root, resolve(location.target, e.name));
    let type = e.isDirectory() ? 'directory' : 'file', size = 0;
    try { const resolved = await workspacePath(location.root, p), info = await stat(resolved.target); type = info.isDirectory() ? 'directory' : 'file'; size = info.size; } catch { type = 'unavailable'; }
    return { name: e.name, path: p, type, size };
  }));
  entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
  return { root: location.root, path: location.path, entries, truncated: all.length > 500 };
}
export async function readWorkspaceFile(root, path) {
  const location = await workspacePath(root, path), info = await stat(location.target);
  if (!info.isFile()) throw new Error('此路径不是文件');
  const file = await open(location.target, 'r');
  let buffer;
  try { buffer = Buffer.alloc(Math.min(info.size, 512 * 1024)); await file.read(buffer, 0, buffer.length, 0); } finally { await file.close(); }
  if (buffer.includes(0)) throw new Error('此文件是二进制文件，暂不支持文本预览');
  const truncated = info.size > buffer.length;
  return { path: location.path, content: new TextDecoder('utf8').decode(buffer, { stream: truncated }), language: extname(path).slice(1), size: info.size, truncated };
}
export async function workspaceGit(root, selectedPath, options) { return readWorkspaceGit(root, selectedPath, options); }

export function rolloutItem(item) {
  const type = item.type?.[0].toLowerCase() + item.type?.slice(1);
  const durationMs = item.duration ? Math.round((item.duration.secs || 0) * 1000 + (item.duration.nanos || 0) / 1e6) : undefined;
  if (type === 'agentMessage') return { id: item.id, type, phase: item.phase, text: typeof item.content === 'string' ? item.content : (item.content || []).map(c => c.text || '').join('') };
  if (type === 'userMessage') return { id: item.id, type, content: (item.content || []).map(c => c.type === 'local_image' ? { ...c, type: 'localImage' } : c) };
  if (type === 'imageGeneration') return { id:item.id,type,status:item.status,...(typeof (item.fileId??item.file_id)==='string'?{fileId:item.fileId??item.file_id}:{}),...(typeof item.result==='string'?{result:item.result}:{}),...(typeof (item.savedPath??item.saved_path)==='string'?{savedPath:item.savedPath??item.saved_path}:{}) };
  if (type === 'commandExecution') return { id: item.id, type, command: item.command, cwd: item.cwd, status: item.status, aggregatedOutput: item.aggregated_output, exitCode: item.exit_code, durationMs };
  if (type === 'reasoning') return { id: item.id, type, summary: item.summary_text || [] };
  if (type === 'fileChange') return { id: item.id, type, status: item.status, changes: Array.isArray(item.changes) ? item.changes : Object.entries(item.changes || {}).map(([path, change]) => ({ path, kind: { type: change.type, movePath: change.move_path }, diff: change.unified_diff || change.content || '' })) };
  if (type === 'extension' && item.kind === 'web.search') return { id: item.id, type: 'webSearch', query: item.query };
  if (type === 'mcpToolCall') return { id: item.id, type, server: item.server, tool: item.tool, status: item.status, durationMs };
  if (type === 'dynamicToolCall') return { id: item.id, type, namespace: item.namespace, tool: item.tool, status: item.status, success: item.success, durationMs };
  if (type === 'plan') return { id: item.id, type, text: item.text };
  if (type === 'contextCompaction') return { id: item.id, type, completed: item.completed ?? true, source: item.source };
  return null;
}

// Read complete recent turns from the local rollout without serializing the full
// conversation through the app-server. Byte cursors keep paging stable as it grows.
export async function readRolloutPage(filePath, cursor, limit = 4) {
  const file = await open(filePath, 'r');
  try {
    const size = (await file.stat()).size;
    let end = cursor?.startsWith('rollout:') ? Number(cursor.slice(8)) : size;
    if (!Number.isSafeInteger(end) || end < 0 || end > size) throw new Error('历史分页位置已失效，请重新打开会话');
    let position = end, remaining = Buffer.alloc(0), starts = 0, boundary = 0, scanned = 0, done = false, hasLegacyItems = false;
    const records = []; let settings;
    const accept = (line, offset) => {
      const prefix = line.subarray(0,180).toString('utf8');
      if (/"type":\s*"response_item"/.test(prefix)) hasLegacyItems = true;
      if (!/"type":\s*"(?:event_msg|turn_context)"/.test(prefix)) return false;
      let payload, record;
      try { record = JSON.parse(line.toString('utf8')); payload = record.payload; } catch { return false; }
      if (record.type === 'turn_context') {
        if (!settings) settings = { ...(typeof payload.model === 'string' ? { model: payload.model } : {}), ...(typeof payload.effort === 'string' ? { effort: payload.effort } : {}), ...(typeof payload.approval_policy === 'string' ? { approvalPolicy: payload.approval_policy } : {}), ...(['read-only', 'workspace-write', 'danger-full-access'].includes(payload.sandbox_policy?.type) ? { sandbox: payload.sandbox_policy.type } : {}) };
        return false;
      }
      if (!['task_started', 'task_complete', 'turn_aborted', 'item_completed', 'turn_failed'].includes(payload?.type)) return false;
      records.push(payload);
      if (payload.type === 'task_started') { starts++; if (starts >= limit) { boundary = offset; return true; } }
      return false;
    };
    while (position > 0 && !done) {
      const length = Math.min(position, 256 * 1024); position -= length; scanned += length;
      if (scanned > 256 * 1024 * 1024) return null;
      const chunk = Buffer.alloc(length); await file.read(chunk, 0, length, position);
      const data = Buffer.concat([chunk, remaining]); let last = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (last > i + 1 && accept(data.subarray(i + 1, last), position + i + 1)) { done = true; break; }
        last = i;
      }
      if (!done) remaining = data.subarray(0, last);
    }
    if (!done && remaining.length) accept(remaining, 0);
    // A custom byte cursor can reach a metadata-only prelude before the first
    // turn. It is an empty final page, not an app-server cursor to fall back to.
    // Preserve the legacy fallback when unprojected history records exist.
    if (!starts) return cursor?.startsWith('rollout:') && !records.length && !hasLegacyItems ? { data: [], nextCursor: null } : null;
    const turns = new Map();
    for (const record of records.reverse()) {
      const id = record.turn_id;
      if (!id) continue;
      if (!turns.has(id)) turns.set(id, { id, status: 'inProgress', items: [], error: null });
      const turn = turns.get(id);
      if (record.type === 'task_started' && record.started_at != null) turn.startedAt = record.started_at;
      if (record.type === 'task_complete') { turn.completedAt = record.completed_at; turn.durationMs = record.duration_ms; if (record.started_at != null) turn.startedAt = record.started_at; }
      if (record.type === 'item_completed') { const item = rolloutItem(record.item || {}); if (item) { const previous = turn.items.findIndex(i => i.id === item.id); if (previous >= 0) turn.items[previous] = item; else turn.items.push(item); } }
      if (record.type === 'task_complete') turn.status = 'completed';
      if (record.type === 'turn_aborted') turn.status = 'interrupted';
      if (record.type === 'turn_failed') { turn.status = 'failed'; turn.error = { message: record.message || '任务执行失败' }; }
    }
    if (![...turns.values()].some(t => t.items.length)) return null;
    return { data: [...turns.values()], settings, nextCursor: boundary > 0 ? 'rollout:' + boundary : null };
  } finally { await file.close(); }
}
