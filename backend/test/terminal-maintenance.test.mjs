import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { TerminalManager } from '../terminal.mjs';

function fixture(options = {}) {
  const children = [];
  const manager = new TerminalManager({ ...options, spawnProcess() {
    const child = new EventEmitter();
    child.pid = 12345 + children.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.input = [];
    child.stdin = new Writable({ write(chunk, encoding, done) { child.input.push(chunk.toString()); done(); } });
    child.kill = signal => { child.killedWith = signal; return true; };
    children.push(child);
    queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
    return child;
  } });
  return { manager, children };
}

// All subprocesses are fake: these checks never open a real shell or PTY.
test('maintenance drain is atomic, token-scoped, private in summary, and releases without touching a child', async () => {
  const { manager, children } = fixture();
  const prepared = manager.prepareUpdate();
  assert.match(prepared.token, /^[a-f0-9]{48}$/);
  assert.equal(prepared.livePTYCount, 0);
  assert.ok(prepared.expiresAt > Date.now());
  assert.deepEqual(manager.summary(), { livePTYCount: 0, draining: true, drainExpiresAt: prepared.expiresAt });
  assert.equal(JSON.stringify(manager.summary()).includes(prepared.token), false);
  assert.throws(() => manager.prepareUpdate(), { code: 'UPDATE_DRAIN_ACTIVE' });
  assert.deepEqual(manager.cancelUpdate('wrong-token'), { released: false });
  await assert.rejects(manager.create('/tmp'), { code: 'UPDATE_DRAIN_ACTIVE' });
  let resolved = false;
  await assert.rejects(manager.handle('POST', new URLSearchParams(), { action: 'create' }, () => { resolved = true; return '/tmp'; }), { code: 'UPDATE_DRAIN_ACTIVE' });
  assert.equal(resolved, false);
  assert.equal(children.length, 0);
  assert.deepEqual(manager.cancelUpdate(prepared.token), { released: true });
  assert.deepEqual(manager.summary(), { livePTYCount: 0, draining: false });
});

test('live supervisor blocks update even after shell exit or explicit close until the process actually exits', async () => {
  const { manager, children } = fixture();
  const session = await manager.create('/tmp'); const child = children[0];
  assert.equal(manager.summary().livePTYCount, 1);
  assert.throws(() => manager.prepareUpdate(), error => error.code === 'TERMINALS_ACTIVE' && error.livePTYCount === 1);
  assert.equal(manager.summary().draining, false);
  child.stdout.write('{"type":"exit","code":0}\n');
  assert.equal(manager.sessions.get(session.id).exited, true);
  assert.equal(manager.summary().livePTYCount, 1);
  manager.close(session.id);
  assert.equal(manager.sessions.size, 0);
  assert.equal(manager.summary().livePTYCount, 1);
  assert.throws(() => manager.prepareUpdate(), { code: 'TERMINALS_ACTIVE' });
  child.emit('exit', 0);
  assert.equal(manager.summary().livePTYCount, 0);
  const prepared = manager.prepareUpdate();
  assert.equal(child.killedWith, undefined);
  manager.cancelUpdate(prepared.token);
});

test('get-or-create is guarded but reads of existing terminal output remain available during drain', async () => {
  const { manager } = fixture();
  const prepared = manager.prepareUpdate();
  manager.sessions.set('existing', { id: 'existing', root: '/private/tmp', scope: '/private/tmp', sequence: 1, frames: [{ id: 1, data: 'b2s=' }], exited: false, code: null });
  await assert.rejects(manager.handle('POST', new URLSearchParams(), { action: 'create' }, () => '/tmp'), { code: 'UPDATE_DRAIN_ACTIVE' });
  const result = await manager.handle('GET', new URLSearchParams({ id: 'existing', wait: '0' }), {}, () => '/tmp');
  assert.equal(result.frames[0].data, 'b2s=');
  assert.equal(manager.summary().draining, true);
  manager.cancelUpdate(prepared.token);
});

test('an in-flight pre-spawn create is rejected if update drain starts before realpath completes', async () => {
  const { manager, children } = fixture();
  const creating = manager.create('/tmp');
  const prepared = manager.prepareUpdate();
  await assert.rejects(creating, { code: 'UPDATE_DRAIN_ACTIVE' });
  assert.equal(children.length, 0);
  manager.cancelUpdate(prepared.token);
});

test('drain TTL releases automatically and stale tokens cannot cancel a newer drain', async () => {
  const { manager } = fixture({ drainTtlMs: 20 });
  const old = manager.prepareUpdate();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(manager.summary(), { livePTYCount: 0, draining: false });
  const next = manager.prepareUpdate();
  assert.deepEqual(manager.cancelUpdate(old.token), { released: false });
  assert.equal(manager.summary().draining, true);
  assert.deepEqual(manager.cancelUpdate(next.token), { released: true });
});
