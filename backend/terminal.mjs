import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

// Keep the PTY on this Mac; the gateway only relays authenticated HTTP frames.
const supervisor = String.raw`
import os, sys, pty, select, subprocess, json, fcntl, termios, struct, signal, base64
master, slave = pty.openpty()
def emit(event):
 print(json.dumps(event), flush=True)
def resize(cols, rows):
 # The candidate is not a replay frame until the following ioctl succeeds.
 emit({'type':'resize', 'cols':cols, 'rows':rows})
 try:
  fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH',rows,cols,0,0))
 except (ValueError, OSError, struct.error):
  emit({'type':'resizeResult', 'ok':False})
  return False
 emit({'type':'resizeResult', 'ok':True})
 return True
if not resize(int(sys.argv[2]), int(sys.argv[3])):
 raise RuntimeError('Unable to set initial PTY size')
def setup():
 os.setsid()
 fcntl.ioctl(0, termios.TIOCSCTTY, 0)
shell = os.environ.get('SHELL', '/bin/zsh')
child = subprocess.Popen([shell, '-l'], stdin=slave, stdout=slave, stderr=slave, cwd=sys.argv[1], env=dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor'), preexec_fn=setup)
os.close(slave)
emit({'type':'ready'})
pending = b''
try:
 while True:
  readers, _, _ = select.select([master, sys.stdin.buffer], [], [], .1)
  if master in readers:
   try: data = os.read(master, 65536)
   except OSError: break
   if not data: break
   emit({'type':'data', 'data':base64.b64encode(data).decode()})
  if sys.stdin.buffer in readers:
   incoming = os.read(sys.stdin.fileno(), 65536)
   if not incoming: break
   pending += incoming
   while b'\n' in pending:
    line, pending = pending.split(b'\n',1)
    try:
     command = json.loads(line)
     if command['type']=='write':
      data = command.get('data','').encode()
      written = 0
      try:
       while written < len(data):
        count = os.write(master, data[written:])
        if count <= 0: raise OSError('PTY input closed')
        written += count
       emit({'type':'writeAck', 'requestId':command.get('requestId'), 'ok':True})
      except OSError:
       emit({'type':'writeAck', 'requestId':command.get('requestId'), 'ok':False, 'partial':written > 0})
     elif command['type']=='resize': resize(command['cols'], command['rows'])
     elif command['type']=='close': raise KeyboardInterrupt()
    except (ValueError, OSError, KeyError): pass
  if child.poll() is not None and not readers: break
except (KeyboardInterrupt, BrokenPipeError): pass
finally:
 try: os.killpg(child.pid, signal.SIGHUP)
 except ProcessLookupError: pass
 try: child.wait(timeout=2)
 except subprocess.TimeoutExpired:
  try: os.killpg(child.pid, signal.SIGKILL)
  except ProcessLookupError: pass
 os.close(master)
 try: emit({'type':'exit','code':child.poll()})
 except BrokenPipeError: pass
`;

export class TerminalManager {
  constructor({ spawnProcess = spawn, drainTtlMs = 30000, writeTimeoutMs = 8000 } = {}) { this.sessions = new Map(); this.spawnProcess = spawnProcess; this.supervisors = new Set(); this.updateDrain = null; this.drainTtlMs = Number.isFinite(drainTtlMs) && drainTtlMs > 0 ? drainTtlMs : 30000; this.writeTimeoutMs = writeTimeoutMs; this.creations = new Map(); }
  expireUpdateDrain() { if (this.updateDrain && this.updateDrain.expiresAt <= Date.now()) this.cancelUpdate(this.updateDrain.token); }
  assertCreationAllowed() { this.expireUpdateDrain(); if (this.updateDrain) throw Object.assign(new Error('服务准备更新，暂时无法创建终端，请稍后重试'), { code: 'UPDATE_DRAIN_ACTIVE' }); }
  summary() { this.expireUpdateDrain(); return { livePTYCount: this.supervisors.size, draining: !!this.updateDrain, ...(this.updateDrain ? { drainExpiresAt: this.updateDrain.expiresAt } : {}) }; }
  prepareUpdate() {
    this.expireUpdateDrain();
    if (this.updateDrain) throw Object.assign(new Error('已有服务更新正在准备'), { code: 'UPDATE_DRAIN_ACTIVE' });
    const token = randomBytes(24).toString('hex'), expiresAt = Date.now() + this.drainTtlMs;
    this.updateDrain = { token, expiresAt, timer: null };
    const livePTYCount = this.supervisors.size;
    if (livePTYCount) { this.cancelUpdate(token); throw Object.assign(new Error('还有终端正在运行，请先明确结束终端再更新服务'), { code: 'TERMINALS_ACTIVE', livePTYCount }); }
    this.updateDrain.timer = setTimeout(() => this.cancelUpdate(token), this.drainTtlMs); this.updateDrain.timer.unref?.();
    return { token, expiresAt, livePTYCount: 0 };
  }
  cancelUpdate(token) { if (!this.updateDrain || token !== this.updateDrain.token) return { released: false }; clearTimeout(this.updateDrain.timer); this.updateDrain = null; return { released: true }; }
  async create(root, cols = 80, rows = 24, { scope, tabId } = {}) {
    this.assertCreationAllowed();
    const directory = await realpath(root);
    this.assertCreationAllowed();
    const terminalTabId = tabId == null ? 'default' : tabId;
    if (typeof terminalTabId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(terminalTabId)) throw new Error('终端标签标识无效');
    const terminalScope = scope || directory, key = JSON.stringify([directory, terminalScope, terminalTabId]);
    const existing = this.creations.get(key);
    if (existing) {
      const created = await existing, current = this.sessions.get(created.id), metadata = current ? this.metadata(current, 0) : { ...created, exited: true, closed: true };
      if (tabId != null || !metadata.exited) return { ...metadata, resumed: true };
      // Old clients have no explicit tab identity: their default terminal can
      // start again after an explicit end, matching the previous get-or-create.
      this.creations.delete(key);
    }
    const promise = this.spawnSession(directory, cols, rows, terminalScope, terminalTabId);
    this.creations.set(key, promise);
    // Keep successful creation receipts for this service lifetime. Retrying a
    // closed tab must never silently create another shell with the same tab ID.
    try { return await promise; } catch (error) { if (!error.outcomeUnknown) this.creations.delete(key); throw error; }
  }
  async spawnSession(directory, cols, rows, scope, tabId) {
    if (this.supervisors.size >= 4) throw new Error('最多同时打开 4 个终端，请先关闭不用的终端');
    for (const [id, session] of this.sessions) if (session.exited && !this.supervisors.has(session.child)) this.sessions.delete(id);
    const id = randomBytes(24).toString('hex');
    const child = this.spawnProcess('/usr/bin/python3', ['-u', '-c', supervisor, directory, String(this.dimension(cols,80,500)), String(this.dimension(rows,24,250))], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.supervisors.add(child);
    child.once('exit', () => this.supervisors.delete(child));
    child.once('error', () => { if (!child.pid) this.supervisors.delete(child); });
    const session = { id, root: directory, scope, tabId, createdAt: Date.now(), child, sequence: 0, frames: [], bytes: 0, exited: false, code: null, waiters: new Set(), writeReceipts: new Map(), pendingWrites: new Map(), initialSize: null, replaySize: null, currentSize: null, pendingResize: null };
    this.sessions.set(id, session);
    child.stdin.on('error', () => { session.exited = true; this.failPendingWrites(session); for (const wake of session.waiters) wake(); });
    let pending = '', errors = '';
    const ready = new Promise((resolve, reject) => {
      let readyReceived = false;
      const timer = setTimeout(() => { this.close(id); reject(new Error('终端启动超时')); }, 6000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.stdout.on('data', chunk => {
        pending += chunk.toString('utf8');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'ready') { readyReceived = true; clearTimeout(timer); resolve(); }
          else if (event.type === 'data') {
            this.appendFrame(session, { data: event.data });
          } else if (event.type === 'resize') {
            session.pendingResize = Number.isInteger(event.cols) && event.cols >= 2 && event.cols <= 500 && Number.isInteger(event.rows) && event.rows >= 2 && event.rows <= 250 ? { cols: event.cols, rows: event.rows } : null;
          } else if (event.type === 'resizeResult') {
            const size = session.pendingResize; session.pendingResize = null;
            if (event.ok === true && size) { session.currentSize = size; session.initialSize ||= size; session.replaySize ||= size; this.appendFrame(session, { type:'resize', ...size }); }
          } else if (event.type === 'writeAck') this.acceptWriteAck(session, event);
          else if (event.type === 'exit') { session.exited = true; session.code = event.code; this.failPendingWrites(session); for (const wake of session.waiters) wake(); }
        }
      });
      child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-1000); });
      child.once('exit', code => { clearTimeout(timer); session.exited = true; session.code ??= code; this.failPendingWrites(session); for (const wake of session.waiters) wake(); if (!readyReceived) reject(new Error('无法启动本机终端' + (errors ? '：' + errors : ''))); });
    });
    try { await ready; } catch (error) { this.sessions.delete(id); if (this.supervisors.has(child)) Object.assign(error, { code: 'TERMINAL_CREATE_UNKNOWN', terminalId: id, outcomeUnknown: true }); throw error; }
    return this.metadata(session, 0);
  }
  appendFrame(session, frame) {
    session.frames.push({ id: ++session.sequence, ...(frame.type === 'resize' ? {data:''} : {}), ...frame }); session.bytes += frame.data?.length || 0;
    while (session.frames.length > 256 || session.bytes > 700000) { const removed = session.frames.shift(); session.bytes -= removed.data?.length || 0; if (removed.type === 'resize') session.replaySize = { cols:removed.cols, rows:removed.rows }; }
    for (const wake of session.waiters) wake();
  }
  metadata(session, sequence = session.sequence) { return { id: session.id, root: session.root, scope: session.scope, tabId: session.tabId, createdAt: session.createdAt, sequence, exited: session.exited, code: session.code, closed: !!session.closed, initialSize: session.initialSize, replaySize: session.replaySize, currentSize: session.currentSize }; }
  scope(query, root) { return query.get('threadId') ? 'thread:' + query.get('threadId') : query.get('projectId') ? 'project:' + query.get('projectId') : root; }
  dimension(value, fallback, max) { const n = Number(value); return Number.isInteger(n) && n >= 2 && n <= max ? n : fallback; }
  write(session, message) { if (!session.exited && !session.child.stdin.destroyed) session.child.stdin.write(JSON.stringify(message) + '\n'); }
  acceptWriteAck(session, event) {
    const receipt = session.pendingWrites.get(event.requestId); if (!receipt) return;
    clearTimeout(receipt.timer); session.pendingWrites.delete(event.requestId);
    if (event.ok === true) { receipt.status = 'acknowledged'; receipt.result = { ok: true, id: session.id, ...(receipt.chunkId ? { chunkId: receipt.chunkId } : {}), acknowledged: true, exited: session.exited }; receipt.resolve(receipt.result); }
    else { receipt.status = event.partial ? 'unknown' : 'failed'; receipt.error = Object.assign(new Error(event.partial ? '部分终端输入可能已发出，请核对后再操作；不会自动重发' : '终端未接受这段输入'), { code: event.partial ? 'TERMINAL_WRITE_UNKNOWN' : 'TERMINAL_WRITE_FAILED', outcomeUnknown: !!event.partial }); receipt.reject(receipt.error); }
  }
  failPendingWrites(session) { for (const receipt of session.pendingWrites.values()) if (receipt.status === 'pending') { clearTimeout(receipt.timer); receipt.status = 'unknown'; receipt.error = Object.assign(new Error('终端输入结果尚未确认，不会自动重发，请核对终端'), { code: 'TERMINAL_WRITE_UNKNOWN', outcomeUnknown: true }); receipt.reject(receipt.error); } }
  input(session, data, chunkId) {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 65536) return Promise.reject(new Error('终端输入过长'));
    if (chunkId != null && (typeof chunkId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(chunkId))) return Promise.reject(new Error('终端输入标识无效'));
    const digest = createHash('sha256').update(data).digest('hex'), previous = chunkId && session.writeReceipts.get(chunkId);
    if (previous) {
      if (previous.digest !== digest) return Promise.reject(new Error('同一终端输入标识不能更换内容'));
      if (previous.status === 'acknowledged') return Promise.resolve({ ...previous.result, duplicate: true });
      if (previous.status !== 'pending') return Promise.reject(previous.error);
      return previous.promise;
    }
    if (session.exited || session.child.stdin.destroyed || !session.child.stdin.writable) return Promise.reject(Object.assign(new Error('终端已结束，未发送输入'), { code: 'TERMINAL_CLOSED', outcomeUnknown: false }));
    if (session.writeReceipts.size >= 65536) return Promise.reject(new Error('终端输入确认记录已满，请新建终端；不会删除旧确认记录或重放输入'));
    const requestId = randomBytes(24).toString('hex'), receipt = { digest, chunkId, status: 'pending' };
    receipt.promise = new Promise((resolve, reject) => { receipt.resolve = resolve; receipt.reject = reject; });
    receipt.timer = setTimeout(() => { if (receipt.status !== 'pending') return; receipt.status = 'unknown'; receipt.error = Object.assign(new Error('终端输入已发出但尚未确认，不会自动重发，请核对终端'), { code: 'TERMINAL_WRITE_UNKNOWN', outcomeUnknown: true }); receipt.reject(receipt.error); }, this.writeTimeoutMs);
    if (chunkId) session.writeReceipts.set(chunkId, receipt);
    session.pendingWrites.set(requestId, receipt);
    try { session.child.stdin.write(JSON.stringify({ type: 'write', data, requestId }) + '\n', error => { if (error) this.failPendingWrites(session); }); } catch { this.failPendingWrites(session); }
    return receipt.promise;
  }
  close(id) { const s = this.sessions.get(id); if (!s) return; this.write(s, { type: 'close' }); s.exited = true; s.closed = true; this.failPendingWrites(s); s.child.stdin.end(); for (const wake of s.waiters) wake(); this.sessions.delete(id); const timer = setTimeout(() => { if (this.supervisors.has(s.child)) s.child.kill('SIGTERM'); }, 2500); timer.unref(); }
  closeAll() { for (const id of this.sessions.keys()) this.close(id); }
  async handle(method, query, data, resolveWorkspace) {
    if (method === 'POST' && data.action === 'create') this.assertCreationAllowed();
    const root = await realpath(await resolveWorkspace());
    const scope = this.scope(query, root);
    const id = method === 'GET' ? query.get('id') : data.id;
    if (method === 'GET' && query.get('action') === 'list') return { sessions: [...this.sessions.values()].filter(session => session.root === root && session.scope === scope).map(session => this.metadata(session)), ...this.summary() };
    if (method === 'POST' && data.action === 'create') {
      this.assertCreationAllowed();
      const created = await this.create(root, data.cols, data.rows, { scope, tabId: data.tabId });
      const current = this.sessions.get(created.id);
      return current ? { ...this.metadata(current, 0), ...(created.resumed ? { resumed: true } : {}) } : { ...created, exited: true, closed: true, resumed: true };
    }
    const session = this.sessions.get(id);
    if (!session || session.root !== root || session.scope !== scope) throw Object.assign(new Error('终端已关闭或不属于当前项目或会话'), { code: 'TERMINAL_NOT_FOUND' });
    if (method === 'POST') {
      if (data.action === 'attach') return this.metadata(session);
      if (data.action === 'close') { this.close(id); return { ok: true }; }
      if (data.action === 'write') return this.input(session, data.data, data.chunkId);
      else if (data.action === 'resize') this.write(session, { type: 'resize', cols: this.dimension(data.cols,80,500), rows: this.dimension(data.rows,24,250) });
      else throw new Error('不支持的终端操作');
      return { ok: true, exited: session.exited };
    }
    const since = Math.max(0, Number(query.get('since')) || 0);
    if (!session.exited && session.sequence <= since && query.get('wait') !== '0') {
      await new Promise(resolve => { const wake = () => { clearTimeout(timer); session.waiters.delete(wake); resolve(); }; const timer = setTimeout(wake,15000); session.waiters.add(wake); });
    }
    return { id, sequence: session.sequence, reset: since > 0 && !!session.frames.length && since < session.frames[0].id - 1, frames: session.frames.filter(frame => frame.id > since), exited: session.exited, code: session.code, initialSize: session.initialSize, replaySize: session.replaySize, currentSize: session.currentSize };
  }
}
