import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createIngress } from '../ingress.mjs';

/**
 * 扫码打开 Harness 手机入口时，浏览器把首次导航标成跨站文档导航。
 * 入口文档必须放行（它自带口令），但同样跨站的 API / 资源请求仍要拒绝。
 */

const origin = 'https://test.cn.cpolar.top';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const request = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port,
    path,
    method,
    headers: { host: new URL(origin).host, ...headers },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(body);
});

const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

const codexBackend = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('codex');
});

const dshCalls = [];
const dshBackend = http.createServer((req, res) => {
  dshCalls.push({ url: req.url, site: req.headers['sec-fetch-site'], method: req.method });
  if (req.url.startsWith('/dsh/?t=')) {
    res.writeHead(302, { location: '/dsh/', 'set-cookie': 'dshm-auth=token; Path=/; HttpOnly' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html>dsh</html>');
});

const codexPort = await listen(codexBackend);
const dshPort = await listen(dshBackend);
const gateway = createIngress({ backend: `http://127.0.0.1:${codexPort}`, dshTarget: `http://127.0.0.1:${dshPort}` });
gateway.setPublicOrigin(origin);
gateway.setMode('codex-read');
const port = await listen(gateway.server);

test('a QR-scan entry navigation reaches the Harness gateway', async () => {
  dshCalls.length = 0;
  const response = await request(port, '/dsh/?t=secret-token', { headers: navigation });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/dsh/');
  assert.equal(dshCalls.length, 1);
  assert.equal(dshCalls[0].url, '/dsh/?t=secret-token');
  assert.equal(dshCalls[0].method, 'GET');
});

test('the redirected entry document is also allowed', async () => {
  const response = await request(port, '/dsh/', { headers: navigation });
  assert.equal(response.status, 200);
  assert.equal(response.body, '<html>dsh</html>');
});

test('HEAD entry navigation is allowed for scanners that probe first', async () => {
  const response = await request(port, '/dsh/', { method: 'HEAD', headers: navigation });
  assert.equal(response.status, 200);
});

test('a webview that stamps its own Origin on the entry navigation is still allowed', async () => {
  const response = await request(port, '/dsh/?t=secret-token', { headers: { ...navigation, origin } });
  assert.equal(response.status, 302);
});

test('an in-app browser sending Origin: null still counts as an entry navigation', async () => {
  const response = await request(port, '/dsh/?t=secret-token', { headers: { ...navigation, origin: 'null' } });
  assert.equal(response.status, 302);
});

test('cross-site API calls and non-document requests are still rejected', async () => {
  dshCalls.length = 0;
  for (const attempt of [
    { path: '/dsh/api/session/list', headers: { ...navigation, 'sec-fetch-mode': 'cors' } },
    { path: '/dsh/api/session/list', headers: navigation },
    { path: '/dsh/api/session/list', headers: { ...navigation, 'sec-fetch-dest': 'empty' } },
    { path: '/dsh/?t=secret-token', headers: { ...navigation, origin: 'https://evil.example' } },
    { path: '/dsh/?t=secret-token', method: 'POST', headers: navigation },
  ]) {
    const response = await request(port, attempt.path, attempt);
    assert.equal(response.status, 403, JSON.stringify(attempt));
  }
  assert.equal(dshCalls.length, 0);
});

test('the Codex entry paths keep working', async () => {
  const response = await request(port, '/', { headers: navigation });
  assert.equal(response.status, 200);
  assert.equal(response.body, 'codex');
});

test.after(async () => {
  await gateway.close();
  await Promise.all([new Promise((resolve) => codexBackend.close(resolve)), new Promise((resolve) => dshBackend.close(resolve))]);
});
