import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDshProxy } from '../dsh-proxy.mjs';

/**
 * `/dsh/*` 透明转发：只验证路由、原样透传与失败分支。
 * 每个请求都关连接，避免 keep-alive socket 让测试进程悬挂。
 */

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(() => resolve());
  server.once('close', resolve);
});

const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path, headers: { connection: 'close', ...headers }, agent: false }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  request.end();
});

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null }));
});
const upstreamPort = await listen(upstream);
const proxy = createDshProxy({ target: `http://127.0.0.1:${upstreamPort}`, prefix: '/dsh' });

const gateway = http.createServer((req, res) => {
  if (proxy.handles(new URL(req.url, 'http://x').pathname)) proxy.forward(req, res);
  else {
    res.writeHead(404);
    res.end('nope');
  }
});
const gatewayPort = await listen(gateway);

test('handles only the configured prefix', () => {
  assert.equal(proxy.handles('/dsh'), true);
  assert.equal(proxy.handles('/dsh/'), true);
  assert.equal(proxy.handles('/dsh/api/session/list'), true);
  assert.equal(proxy.handles('/dshx'), false);
  assert.equal(proxy.handles('/'), false);
  assert.equal(proxy.handles('/mobile/api/threads'), false);
});

test('forwards the path unchanged with caller headers and cookies', async () => {
  const response = await get(gatewayPort, '/dsh/api/session/list', { cookie: 'dshm-auth=phone-token' });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.url, '/dsh/api/session/list');
  assert.equal(body.cookie, 'dshm-auth=phone-token');
  assert.equal(body.host, `127.0.0.1:${gatewayPort}`);
});

test('leaves unrelated paths to the caller', async () => {
  const response = await get(gatewayPort, '/mobile/api/threads');
  assert.equal(response.status, 404);
});

test('keeps the status code and body of an upstream response', async () => {
  const failing = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('需要手机连接口令');
  });
  const failingPort = await listen(failing);
  const failingProxy = createDshProxy({ target: `http://127.0.0.1:${failingPort}`, prefix: '/dsh' });
  const server = http.createServer((req, res) => failingProxy.forward(req, res));
  const port = await listen(server);
  const response = await get(port, '/dsh/');
  assert.equal(response.status, 401);
  assert.equal(response.body, '需要手机连接口令');
  failingProxy.dispose();
  await closeServer(server);
  await closeServer(failing);
});

test('answers 502 when the harness gateway is down', async () => {
  const deadProxy = createDshProxy({ target: 'http://127.0.0.1:1', prefix: '/dsh' });
  const server = http.createServer((req, res) => deadProxy.forward(req, res));
  const port = await listen(server);
  const response = await get(port, '/dsh/');
  assert.equal(response.status, 502);
  assert.match(response.body, /Harness/);
  deadProxy.dispose();
  await closeServer(server);
});

test('refuses a non-loopback target', () => {
  assert.throws(() => createDshProxy({ target: 'http://10.0.0.5:18902' }), /loopback/);
});

test.after(async () => {
  proxy.dispose();
  await Promise.all([closeServer(gateway), closeServer(upstream)]);
});
