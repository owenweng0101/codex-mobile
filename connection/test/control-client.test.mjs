import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readControlResponse } from '../control-client.mjs';

test('pairing status travels over a private socket without a TCP port', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cm-'));
  const socketPath = join(folder, 'c.sock');
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/local/status');
    assert.equal(req.method, 'GET');
    res.end(JSON.stringify({ status: 'online' }));
  });
  try {
    await new Promise(resolve => server.listen(socketPath, resolve));
    const response = await readControlResponse({ socketPath });
    assert.deepEqual(await response.json(), { status: 'online' });
    assert.equal(typeof server.address(), 'string');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});

test('stopped control service rejects promptly instead of returning a stale QR', async () => {
  await assert.rejects(readControlResponse({ socketPath: '/tmp/codex-mobile-missing-control.sock' }));
});

test('a nonresponsive control socket respects cancellation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cm-'));
  const socketPath = join(folder, 'c.sock');
  const server = http.createServer(() => {});
  try {
    await new Promise(resolve => server.listen(socketPath, resolve));
    await assert.rejects(readControlResponse({ socketPath, signal: AbortSignal.timeout(20) }), { name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(folder, { recursive: true, force: true });
  }
});
