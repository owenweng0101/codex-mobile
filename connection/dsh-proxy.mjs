import http from 'node:http';
import net from 'node:net';

/**
 * 把 `/dsh/*` 透明转发到本机的 DeepSeek Harness 手机网关。
 *
 * 隧道只有一个端口，Codex 手机入口占根路径；Harness 的手机入口因此挂在
 * 子路径下。Harness 前端用相对路径访问 API，只要路径前缀保持原样即可工作。
 */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardedHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.target] 本机 Harness 手机网关地址
 * @param {string} [options.prefix] 对外路径前缀
 * @param {number} [options.timeoutMs] 上游空闲超时
 */
export function createDshProxy({ target = 'http://127.0.0.1:18902', prefix = '/dsh', timeoutMs = 300000 } = {}) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') throw new Error('dsh proxy target must be loopback HTTP');
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  function handles(path) {
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  function forward(req, res) {
    const proxy = http.request({
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: forwardedHeaders(req),
      agent,
      timeout: timeoutMs,
    }, (response) => {
      const headers = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (key.toLowerCase() === 'x-frame-options') continue;
        headers[key] = value;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    proxy.on('timeout', () => proxy.destroy());
    proxy.on('error', () => {
      if (res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Harness 手机网关未启动' }));
      } else {
        res.destroy();
      }
    });
    req.on('aborted', () => proxy.destroy());
    res.on('close', () => { if (!res.writableFinished) proxy.destroy(); });
    req.pipe(proxy);
  }

  function upgrade(req, socket, head) {
    const headers = forwardedHeaders(req);
    headers.connection = 'Upgrade';
    headers.upgrade = req.headers.upgrade ?? 'websocket';

    const target = net.connect({ host: upstream.hostname, port: Number(upstream.port || 80) });
    target.setNoDelay(true);
    socket.setNoDelay(true);

    target.on('connect', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
        else lines.push(`${key}: ${value}`);
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });

    const close = () => { socket.destroy(); target.destroy(); };
    target.on('error', close);
    target.on('close', close);
    socket.on('error', close);
    socket.on('close', close);
  }

  function dispose() {
    agent.destroy();
  }

  return { handles, forward, upgrade, dispose, prefix, target: upstream.origin };
}
