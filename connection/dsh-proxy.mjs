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
  // Connection may nominate additional hop-by-hop fields. Node has already
  // decoded incoming chunks; the outgoing HTTP stack owns the new framing.
  const hop = new Set([...HOP_BY_HOP, ...String(req.headers.connection ?? '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)]);
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || hop.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} [options.target] 本机 Harness 手机网关地址
 * @param {string} [options.prefix] 对外路径前缀
 * @param {number} [options.timeoutMs] 上游空闲超时
 * @param {function} [options.onError] 仅接收前缀、方法、错误码与复用状态，不含口令和请求体
 */
export function createDshProxy({ target = 'http://127.0.0.1:18902', prefix = '/dsh', timeoutMs = 300000,
  onError = details => console.error('mobile proxy error', JSON.stringify(details)) } = {}) {
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
      const headers = forwardedHeaders(response);
      delete headers['x-frame-options'];
      res.writeHead(response.statusCode ?? 502, headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    proxy.on('timeout', () => proxy.destroy(Object.assign(new Error('Upstream timeout'), { code: 'ETIMEDOUT' })));
    proxy.on('error', error => {
      const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UPSTREAM_ERROR';
      onError({ prefix, method: req.method, code, reusedSocket: proxy.reusedSocket });
      if (res.writableEnded) return;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        const name = ['/claude', '/m'].includes(prefix) ? 'Claude' : 'Harness';
        // A reset, parse error or timeout does not mean the gateway is stopped.
        res.end(JSON.stringify({ error: `${name} 手机网关暂时无法连接`, code }));
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
