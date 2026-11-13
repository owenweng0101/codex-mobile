import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverDshPort, listHarnessPids, listListeningPorts, probeDshPort } from '../backend/upstream.mjs';

const psOutput = [
  '  101 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js /x /y',
  '  202 /usr/bin/something-else --flag',
  '  303 grep dsh-desktop-host/lib/index.js',
].join('\n');

const lsofOutput = (ports) => ports.map((port, index) => `p900${index}\nf2${index}\nn127.0.0.1:${port}`).join('\n');

test('lists only Harness host processes', async () => {
  const pids = await listHarnessPids({ run: async () => ({ stdout: psOutput }) });
  assert.deepEqual(pids, [101]);
});

test('reads loopback listening ports from lsof output', async () => {
  const ports = await listListeningPorts(101, { run: async () => ({ stdout: lsofOutput([52115, 3080]) }) });
  assert.deepEqual(ports, [52115, 3080]);
});

test('returns no ports when the process has none', async () => {
  const ports = await listListeningPorts(101, { run: async () => { throw new Error('no match'); } });
  assert.deepEqual(ports, []);
});

test('recognises the DSH auth challenge and rejects other servers', async () => {
  const dsh = async () => new Response('dsh web authentication required; reopen the URL printed by dsh web.\n', { status: 401 });
  const other = async () => new Response('hello', { status: 200 });
  assert.equal(await probeDshPort(52115, { fetchImpl: dsh }), true);
  assert.equal(await probeDshPort(52115, { fetchImpl: other }), false);
  assert.equal(await probeDshPort(52115, { fetchImpl: async () => { throw new Error('nope'); } }), false);
});

test('prefers a still-valid known port without touching the process table', async () => {
  let scanned = false;
  const port = await discoverDshPort({
    preferred: 52115,
    exclude: [18902],
    fetchImpl: async () => new Response('dsh web authentication required; reopen the URL printed by dsh web.\n', { status: 401 }),
    run: async () => { scanned = true; return { stdout: '' }; },
  });
  assert.equal(port, 52115);
  assert.equal(scanned, false);
});

test('falls back to scanning harness processes when the preferred port is gone', async () => {
  const port = await discoverDshPort({
    preferred: 9999,
    exclude: [18902],
    fetchImpl: async (url) => (url.includes(':52115/')
      ? new Response('dsh web authentication required; reopen the URL printed by dsh web.\n', { status: 401 })
      : new Response('not dsh', { status: 404 })),
    run: async (command) => ({ stdout: command === 'ps' ? psOutput : lsofOutput([4000, 52115]) }),
  });
  assert.equal(port, 52115);
});

test('returns null when no DSH port answers', async () => {
  const port = await discoverDshPort({
    exclude: [18902],
    fetchImpl: async () => new Response('nope', { status: 404 }),
    run: async (command) => ({ stdout: command === 'ps' ? psOutput : lsofOutput([4000]) }),
  });
  assert.equal(port, null);
});
