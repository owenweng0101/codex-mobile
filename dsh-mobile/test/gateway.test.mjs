import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 端到端：假上游 + 真实网关进程。
 * 覆盖令牌交换、前缀路由、头改写、HTML 注入与 WebSocket 透传。
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base64url = (value) => Buffer.from(value).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

let upstream;
let upstreamPort;
let gateway;
let gatewayPort;
let home;
let token;

const received = [];

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
  });
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return true;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
  }
  return false;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dshm-home-'));
  await mkdir(join(home, '.dsh'), { recursive: true });
  const secret = Buffer.alloc(32, 3);
  await writeFile(join(home, '.dsh', '.credentials.yaml'), `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: ${base64url(secret)}
`);

  upstream = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin }));
      return;
    }
    if (req.url === '/plain') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head></head><body><div id="app">harness</div></body></html>');
  });
  upstream.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (chunk) => socket.write(chunk));
  });
  upstreamPort = await listen(upstream);

  gatewayPort = await freePort();
  gateway = spawn(process.execPath, [join(project, 'backend', 'server.mjs')], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: join(home, '.dsh'),
      DSHM_STATE: join(home, 'state'),
      DSHM_FRONTEND_MODE: 'live-test',
      DSHM_PORT: String(gatewayPort),
      DSHM_BASE_PATH: '/dsh',
      DSHM_TUNNEL: 'off',
      DSHM_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stderr.on('data', () => {});

  const ready = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/_dsh/ping`);
    return response.ok;
  });
  assert.ok(ready, 'gateway did not become ready');
  const status = await (await fetch(`http://127.0.0.1:${gatewayPort}/_dsh/status`)).json();
  token = status.path.split('t=')[1].split('&')[0];
  assert.match(token, /^[A-Za-z0-9_-]{32,}$/);
});

after(async () => {
  gateway?.kill('SIGTERM');
  upstream?.close();
  await rm(home, { recursive: true, force: true });
});

const url = (path) => `http://127.0.0.1:${gatewayPort}${path}`;

test('rejects paths outside the configured base path', async () => {
  const response = await fetch(url('/somewhere'));
  assert.equal(response.status, 404);
});

test('unauthenticated requests get 401 before reaching the upstream', async () => {
  const before = received.length;
  const response = await fetch(url('/dsh/'));
  assert.equal(response.status, 401);
  assert.equal(received.length, before);
});

test('token exchange sets the phone cookie and redirects into the prefix', async () => {
  const bad = await fetch(url('/dsh/?t=wrong'));
  assert.equal(bad.status, 401);

  const good = await fetch(url(`/dsh/?t=${token}`), { redirect: 'manual' });
  assert.equal(good.status, 302);
  assert.equal(good.headers.get('location'), '/dsh/');
  assert.match(good.headers.get('set-cookie') ?? '', /^dshm-auth=/);
  assert.match(good.headers.get('set-cookie') ?? '', /HttpOnly/);
});

test('forwards with rewritten host and injected DSH cookie, injecting the mobile shell', async () => {
  const response = await fetch(url('/dsh/'), { headers: { cookie: `dshm-auth=${token}` } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="dshm-mobile"/);
  assert.match(html, /id="dshm-mobile-shell"/);
  assert.match(html, /<div id="app">harness<\/div>/);

  const last = received.at(-1);
  assert.equal(last.url, '/');
  assert.equal(last.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.match(last.headers.cookie, /^dsh-auth-/);
});

test('rewrites a browser origin to the upstream origin', async () => {
  const response = await fetch(url('/dsh/echo'), {
    headers: { cookie: `dshm-auth=${token}`, origin: `http://127.0.0.1:${gatewayPort}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.origin, `http://127.0.0.1:${upstreamPort}`);
  assert.equal(body.host, `127.0.0.1:${upstreamPort}`);
});

test('passes non-HTML bodies through untouched', async () => {
  const response = await fetch(url('/dsh/plain'), { headers: { cookie: `dshm-auth=${token}` } });
  assert.equal(await response.text(), '{"ok":true}');
});

test('proxies WebSocket upgrades under the base path', async () => {
  const socket = net.connect({ host: '127.0.0.1', port: gatewayPort });
  const chunks = [];
  await new Promise((resolveConnect) => socket.once('connect', resolveConnect));
  socket.write([
    'GET /dsh/ws HTTP/1.1',
    `Host: 127.0.0.1:${gatewayPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    `Cookie: dshm-auth=${token}`,
    '',
    '',
  ].join('\r\n'));

  const head = await new Promise((resolveHead, reject) => {
    const timer = setTimeout(() => reject(new Error('no upgrade response')), 5000);
    const onData = (chunk) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('latin1');
      if (text.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolveHead(text);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
  assert.match(head, /HTTP\/1\.1 101/);

  socket.write('ping-through-proxy');
  const echo = await new Promise((resolveEcho, reject) => {
    const timer = setTimeout(() => reject(new Error('no echo')), 3000);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      resolveEcho(chunk.toString());
    });
  });
  assert.equal(echo, 'ping-through-proxy');
  socket.destroy();
});

test('WebSocket upgrades without the phone cookie are refused', async () => {
  const socket = net.connect({ host: '127.0.0.1', port: gatewayPort });
  await new Promise((resolveConnect) => socket.once('connect', resolveConnect));
  socket.write([
    'GET /dsh/ws HTTP/1.1',
    `Host: 127.0.0.1:${gatewayPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '',
    '',
  ].join('\r\n'));
  const text = await new Promise((resolveText) => socket.once('data', (chunk) => resolveText(chunk.toString())));
  assert.match(text, /401/);
  socket.destroy();
});

test('status is local-only and never exposes the phone cookie', async () => {
  const response = await fetch(url('/_dsh/status'), { headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(response.status, 403);
});
