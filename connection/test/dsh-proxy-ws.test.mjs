import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createDshProxy } from '../dsh-proxy.mjs';

/** WebSocket 升级透传：客户端帧经 `/dsh` 前缀到上游再回来。 */

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const upgradeSockets = new Set();
const upstream = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('http');
});
upstream.on('connection', (socket) => upgradeSockets.add(socket));
upstream.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  socket.on('data', (chunk) => socket.write(chunk));
});
const upstreamPort = await listen(upstream);

const proxy = createDshProxy({ target: `http://127.0.0.1:${upstreamPort}`, prefix: '/dsh' });
const gateway = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('nope');
});
gateway.on('upgrade', (req, socket, head) => proxy.upgrade(req, socket, head));
gateway.on('connection', (socket) => upgradeSockets.add(socket));
const gatewayPort = await listen(gateway);

test('passes websocket upgrades through and echoes frames', async () => {
  const socket = net.connect({ host: '127.0.0.1', port: gatewayPort });
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write([
    'GET /dsh/api/remote.mux HTTP/1.1',
    `Host: 127.0.0.1:${gatewayPort}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    '',
    '',
  ].join('\r\n'));

  const chunks = [];
  const head = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('no upgrade response')), 5000);
    const onData = (chunk) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('latin1');
      if (text.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(text);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  assert.match(head, /HTTP\/1\.1 101/);

  socket.write('hello-through-dsh');
  const echo = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('no echo')), 3000);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString());
    });
  });
  assert.equal(echo, 'hello-through-dsh');
  socket.destroy();
});

test.after(async () => {
  proxy.dispose();
  for (const socket of upgradeSockets) socket.destroy();
  upgradeSockets.clear();
  const closeServer = (server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
    server.once('close', resolve);
  });
  await Promise.all([closeServer(gateway), closeServer(upstream)]);
});
