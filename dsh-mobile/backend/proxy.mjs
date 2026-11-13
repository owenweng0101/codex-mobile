import http from 'node:http';
import net from 'node:net';

/**
 * 转发到本机 DSH 网页服务的最小反向代理。
 *
 * 只做三件事：把 Host/Origin 改写成上游 authority、注入签名 cookie、
 * 把 HTML 交给调用方注入手机样式。其余请求与响应按字节透传（含压缩）。
 */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** 去掉逐跳头，返回可转发的小写头对象。 */
export function filterHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    result[key.toLowerCase()] = value;
  }
  return result;
}

/**
 * 拼出转发用的请求头：改写 Host/Origin/Referer/Cookie。
 * @param {object} headers 浏览器请求头
 * @param {object} options
 * @param {string} options.authority 上游 authority（127.0.0.1:52115）
 * @param {string} options.origin 上游 origin（http://127.0.0.1:52115）
 * @param {string} options.cookie 需要注入的 dsh-auth cookie
 * @param {boolean} [options.identity] 要求上游返回未压缩正文
 */
export function rewriteHeaders(headers, { authority, origin, cookie, identity = false }) {
  const output = filterHeaders(headers);
  output.host = authority;
  output['accept-encoding'] = identity ? 'identity' : (headers['accept-encoding'] ?? 'identity');

  const originHeader = headers.origin;
  if (typeof originHeader === 'string' && originHeader.length > 0) output.origin = origin;
  const referer = headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      const parsed = new URL(referer);
      output.referer = origin + parsed.pathname + parsed.search;
    } catch {
      delete output.referer;
    }
  }

  const incoming = typeof headers.cookie === 'string' ? headers.cookie : '';
  const kept = incoming.split(';').map((part) => part.trim()).filter((part) => (
    part.length > 0 && !part.startsWith('dsh-auth-') && !part.startsWith('dshm-auth=')
  ));
  kept.push(cookie);
  output.cookie = kept.join('; ');
  return output;
}

/**
 * 创建到上游的连接池（keep-alive）。端口按请求传入，不能写进 agent 默认值。
 * @param {object} [options]
 * @param {number} [options.maxSockets] 并发连接上限
 */
export function createUpstreamAgent({ maxSockets = 128 } = {}) {
  return new http.Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 15000 });
}

/**
 * 转发一次普通 HTTP 请求。
 * @param {http.IncomingMessage} req 浏览器请求
 * @param {http.ServerResponse} res 浏览器响应
 * @param {object} options
 */
export async function proxyHttp(req, res, {
  host, port, authority, origin, cookie, agent,
  transformHtml,
  onUpstreamError,
}) {
  const wantsHtml = (req.headers.accept ?? '').includes('text/html');
  const headers = rewriteHeaders(req.headers, { authority, origin, cookie, identity: wantsHtml });

  const upstream = http.request({
    host, port, method: req.method, path: req.url, headers, agent,
  }, (upstreamRes) => {
    const contentType = String(upstreamRes.headers['content-type'] ?? '');
    const isHtml = contentType.startsWith('text/html');
    const responseHeaders = filterHeaders(upstreamRes.headers);
    delete responseHeaders['set-cookie'];
    const setCookies = upstreamRes.headers['set-cookie'];
    if (Array.isArray(setCookies)) {
      const kept = setCookies.filter((value) => !value.startsWith('dsh-auth-'));
      if (kept.length > 0) responseHeaders['set-cookie'] = kept;
    }

    if (!isHtml || typeof transformHtml !== 'function') {
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
      return;
    }

    const chunks = [];
    upstreamRes.on('data', (chunk) => chunks.push(chunk));
    upstreamRes.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const transformed = Buffer.from(transformHtml(body), 'utf8');
        delete responseHeaders['content-encoding'];
        delete responseHeaders.etag;
        delete responseHeaders['content-length'];
        responseHeaders['content-length'] = String(transformed.byteLength);
        responseHeaders['cache-control'] = 'no-store';
        res.writeHead(upstreamRes.statusCode ?? 200, responseHeaders);
        res.end(transformed);
      } catch (error) {
        responseHeaders['content-length'] = String(Buffer.concat(chunks).byteLength);
        res.writeHead(upstreamRes.statusCode ?? 200, responseHeaders);
        res.end(Buffer.concat(chunks));
        onUpstreamError?.(error);
      }
    });
    upstreamRes.on('error', () => { res.destroy(); });
  });

  upstream.on('error', (error) => {
    onUpstreamError?.(error);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`DSH 上游不可用：${error.message}\n`);
    } else {
      res.destroy();
    }
  });
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * 把 WebSocket / upgrade 请求原样穿过代理。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {object} options
 */
export function proxyUpgrade(req, socket, head, { host, port, authority, origin, cookie }) {
  const headers = rewriteHeaders(req.headers, { authority, origin, cookie, identity: true });
  headers.upgrade = req.headers.upgrade ?? 'websocket';
  headers.connection = 'Upgrade';

  const target = net.connect({ host, port });
  target.setNoDelay(true);
  socket.setNoDelay(true);

  target.on('connect', () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
      else lines.push(`${key}: ${value}`);
    }
    target.write(lines.join('\r\n') + '\r\n\r\n');
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
