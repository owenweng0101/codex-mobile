import { EventEmitter } from 'node:events';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class MessageQueue extends EventEmitter {
  constructor({ stateDir, send, isActive }) {
    super(); this.path = resolve(stateDir, 'message-queue.json'); this.stateDir = stateDir; this.send = send; this.isActive = isActive; this.threads = {}; this.delivered = []; this.running = new Set(); this.writes = Promise.resolve();
  }
  async init() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    try { const state = JSON.parse(await readFile(this.path, 'utf8')); this.threads = state.threads || {}; this.delivered = state.delivered || []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const queue of Object.values(this.threads)) for (const item of queue.items) if (item.status === 'sending') { item.status = 'uncertain'; item.error = '连接在发送时中断，请确认聊天记录后编辑重发或删除'; queue.paused = true; queue.error = item.error; }
    await this.save(); return this;
  }
  get(threadId) {
    if (!threadId || typeof threadId !== 'string' || threadId.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(threadId)) throw new Error('无效的任务编号');
    const queue = Object.hasOwn(this.threads, threadId) ? this.threads[threadId] : { paused: false, items: [], error: null };
    return structuredClone({ threadId, ...queue });
  }
  ensure(threadId) { this.get(threadId); if (!Object.hasOwn(this.threads, threadId)) this.threads[threadId] = { paused: false, items: [], error: null }; return this.threads[threadId]; }
  save() {
    const data = JSON.stringify({ threads: this.threads, delivered: this.delivered });
    this.writes = this.writes.catch(() => {}).then(async () => { await writeFile(this.path + '.tmp', data, { mode: 0o600 }); await rename(this.path + '.tmp', this.path); });
    return this.writes;
  }
  async changed(threadId) { await this.save(); this.emit('change', { threadId, queue: this.get(threadId) }); }
  hasPending(threadId) { const q = this.get(threadId); return q.items.length > 0 || q.paused; }
  clean(data) {
    if (typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 128) throw new Error('消息缺少编号');
    if (typeof data.text !== 'string' && data.text != null) throw new Error('无效的消息内容');
    if ((!data.text?.trim() && !data.attachments?.length && !data.files?.length) || (data.text?.length || 0) > 160000) throw new Error('消息为空或过长');
    if (data.attachments != null && (!Array.isArray(data.attachments) || data.attachments.length > 6 || data.attachments.some(id => typeof id !== 'string'))) throw new Error('每条消息最多添加 6 个附件');
    if (data.files != null && (!Array.isArray(data.files) || data.files.length > 20 || data.files.some(path => typeof path !== 'string'))) throw new Error('每条消息最多引用 20 个文件');
    return Object.fromEntries(['text', 'requestId', 'attachments', 'files', 'model', 'effort', 'mode', 'approvalPolicy', 'sandbox'].filter(k => data[k] != null).map(k => [k, data[k]]));
  }
  async enqueue(threadId, data) {
    const clean = this.clean(data), q = this.ensure(threadId);
    if (this.delivered.some(d => d.threadId === threadId && d.requestId === clean.requestId)) return { duplicate: true, queue: this.get(threadId), item: null };
    const existing = q.items.find(i => i.requestId === clean.requestId); if (existing) return { duplicate: true, queue: this.get(threadId), item: structuredClone(existing) };
    if (q.items.length >= 50) throw new Error('发送队列最多保留 50 条消息');
    const item = { ...clean, id: clean.requestId, createdAt: Date.now(), status: 'queued', error: null }; q.items.push(item);
    await this.changed(threadId); this.kick(threadId);
    return { queue: this.get(threadId), item: structuredClone(item) };
  }
  kickAll() { for (const id of Object.keys(this.threads)) this.kick(id); }
  kick(threadId) { if (!this.running.has(threadId)) this.drain(threadId).catch(() => {}); }
  async drain(threadId) {
    if (this.running.has(threadId)) return; this.running.add(threadId);
    try {
      const q = this.ensure(threadId);
      while (!q.paused && !this.isActive(threadId) && q.items.length) {
        const item = q.items[0]; if (item.status !== 'queued') return;
        await this.deliver(threadId, item, false);
      }
    } finally { this.running.delete(threadId); }
  }
  async deliver(threadId, item, steer) {
    const q = this.ensure(threadId); item.status = 'sending'; item.error = null; await this.changed(threadId);
    try {
      await this.send({ ...item, threadId }, { steer });
      q.items = q.items.filter(i => i.id !== item.id); q.error = null;
      this.delivered.push({ threadId, requestId: item.requestId, time: Date.now() }); if (this.delivered.length > 500) this.delivered.splice(0, this.delivered.length - 500);
      await this.changed(threadId);
    } catch (error) { item.status = error.outcomeUnknown ? 'uncertain' : 'failed'; item.error = error.message; q.error = error.message; q.paused = true; await this.changed(threadId); }
  }
  async handle(threadId, data) {
    const q = this.ensure(threadId);
    if (data.action === 'enqueue') { await this.enqueue(threadId, data); return this.get(threadId); }
    if (data.action === 'pause') q.paused = true;
    else if (data.action === 'resume') { if (q.items.some(i => i.status === 'uncertain')) throw new Error('请先处理上次发送状态未确认的消息'); for (const item of q.items) if (item.status === 'failed') { item.status = 'queued'; item.error = null; } q.paused = false; q.error = null; }
    else {
      const index = q.items.findIndex(i => i.id === data.id); if (index < 0) throw new Error('队列消息不存在或已发送');
      const item = q.items[index]; if (item.status === 'sending') throw new Error('消息正在发送，请稍后操作');
      if (data.action === 'remove') q.items.splice(index, 1);
      else if (data.action === 'edit') { const requestId = item.status === 'uncertain' ? randomUUID() : item.requestId; const patch = this.clean({ ...item, ...data, requestId }); Object.assign(item, patch, { id: requestId, status: 'queued', error: null }); q.error = null; }
      else if (data.action === 'move') { const target = data.direction === 'up' ? Math.max(0, index - 1) : data.direction === 'down' ? Math.min(q.items.length - 1, index + 1) : index; q.items.splice(index, 1); q.items.splice(target, 0, item); }
      else if (data.action === 'sendNow') {
        if (this.running.has(threadId)) throw new Error('正在发送队列消息，请稍后重试');
        if (item.status === 'uncertain') throw new Error('请先编辑或删除发送状态未确认的消息');
        this.running.add(threadId); try { await this.deliver(threadId, item, this.isActive(threadId)); } finally { this.running.delete(threadId); }
        return this.get(threadId);
      } else throw new Error('不支持的队列操作');
    }
    await this.changed(threadId); this.kick(threadId); return this.get(threadId);
  }
}
