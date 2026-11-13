import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { loadBrowserCookie } from './dsh-auth.mjs';
import { createUpstreamAgent, proxyHttp, proxyUpgrade } from './proxy.mjs';
import { injectMobileShell, SHELL_VERSION } from './mobile.mjs';
import { discoverDshPort } from './upstream.mjs';
import { loadPinnedFrontend } from './frontend.mjs';

/**
 * DSH 手机连接网关：把本机 Harness 网页服务包装成手机可访问的入口。
 *
 * 手机 → 本网关（带访问口令）→ 127.0.0.1:<Harness 端口>（注入签名 cookie）。
 * 手机上看到的是 Harness 自己的完整界面，因此功能与桌面完全一致。
 *
 * 桌面端每次启动用随机端口，所以上游端口靠进程监听表发现，而不是写死。
 */

const PORT = Number(process.env.DSHM_PORT ?? 18902);
const BIND = process.env.DSHM_BIND ?? '0.0.0.0';
const RAW_BASE_PATH = (process.env.DSHM_BASE_PATH ?? '').trim();
const BASE_PATH = RAW_BASE_PATH === '' || RAW_BASE_PATH === '/'
  ? ''
  : '/' + RAW_BASE_PATH.replace(/^\/+|\/+$/gu, '');
const FIXED_UPSTREAM = process.env.DSHM_UPSTREAM ? new URL(process.env.DSHM_UPSTREAM) : null;
const STATE_DIR = process.env.DSHM_STATE ?? join(homedir(), 'Library', 'Application Support', 'DshMobile');
const TOKEN_PATH = join(STATE_DIR, 'access-token');
const COOKIE_NAME = 'dshm-auth';
const STARTED_AT = Date.now();
const COOKIE_MAX_AGE_DAYS = 30;

let accessToken = '';
let qrCache = { value: null, data: null };
let refreshing = null;
let lastRefreshAt = 0;

/** 当前上游：端口、authority、origin 与注入用的签名 cookie。 */
const upstream = { target: null, cookie: null, cookieAt: 0 };
const agent = createUpstreamAgent();
const frontend = process.env.DSHM_FRONTEND_MODE === 'live-test' ? null : await loadPinnedFrontend();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** 只接受来自本机回环、且没有经过代理的请求（状态面板用）。 */
export function isLocalRequest(req, port = PORT) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (Object.keys(req.headers).some((key) => key.startsWith('x-forwarded-') || ['forwarded', 'via', 'cf-ray', 'cf-connecting-ip'].includes(key))) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

function readCookie(headerValue, name) {
  if (typeof headerValue !== 'string') return undefined;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

function lanAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    .filter((address) => !address.startsWith('169.254.'));
}

async function loadOrCreateToken() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    await chmod(STATE_DIR, 0o700);
  } catch {}
  try {
    const existing = (await readFile(TOKEN_PATH, 'utf8')).trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(existing)) return existing;
  } catch {}
  const created = randomBytes(32).toString('base64url');
  await writeFile(TOKEN_PATH, created, { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600);
  return created;
}

/** 去掉公开前缀；路径不在前缀下时返回 undefined。 */
function stripBasePath(pathname) {
  if (BASE_PATH === '') return pathname;
  if (pathname === BASE_PATH) return '';
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length);
  return undefined;
}

function tokenPath() {
  // v 随注入脚本变化：内置浏览器按 URL 缓存页面，换版本就换地址。
  return `${BASE_PATH}/?t=${accessToken}&v=${SHELL_VERSION}`;
}

function phoneUrlFor(origin) {
  return origin ? `${origin}${tokenPath()}` : null;
}

/** 当前首选公开地址：显式配置 > 面板提示，最后才用局域网。 */
function currentOrigin(hint) {
  if (process.env.DSHM_PUBLIC_URL) return process.env.DSHM_PUBLIC_URL.replace(/\/+$/u, '');
  if (typeof hint === 'string' && /^https?:\/\//u.test(hint)) return hint.replace(/\/+$/u, '');
  const [address] = lanAddresses();
  return address ? `http://${address}:${PORT}` : null;
}

/** 判断一个 origin 是否公网入口（局域网地址与回环不算）。 */
function isPublicOrigin(origin) {
  if (typeof origin !== 'string' || !/^https?:\/\//u.test(origin)) return false;
  try {
    const host = new URL(origin).hostname;
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) return false;
    if (/^10\./u.test(host) || /^192\.168\./u.test(host)) return false;
    if (/^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function providerFor(origin) {
  if (process.env.DSHM_PUBLIC_URL) return 'public-url';
  if (isPublicOrigin(origin)) return 'tunnel';
  return 'lan';
}

async function qrFor(value) {
  if (qrCache.value === value) return qrCache.data;
  const data = await QRCode.toDataURL(value, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
  qrCache = { value, data };
  return data;
}

function makeTarget(port) {
  const authority = `127.0.0.1:${port}`;
  return { port, authority, origin: `http://${authority}` };
}

/**
 * 解析/刷新上游：优先复用已知端口，否则从 Harness 进程的监听表里发现。
 */
async function refreshUpstream() {
  if (FIXED_UPSTREAM !== null) {
    const target = makeTarget(Number(FIXED_UPSTREAM.port || 80));
    target.origin = FIXED_UPSTREAM.origin;
    target.authority = FIXED_UPSTREAM.host;
    upstream.target = target;
  } else {
    const port = await discoverDshPort({ preferred: upstream.target?.port, exclude: [PORT] });
    upstream.target = port === null ? null : makeTarget(port);
  }
  lastRefreshAt = Date.now();
  if (upstream.target === null) return;
  if (upstream.cookie !== null && upstream.cookie.authority === upstream.target.authority) return;
  const cookie = await loadBrowserCookie({ authority: upstream.target.authority, maxAgeDays: COOKIE_MAX_AGE_DAYS });
  upstream.cookie = { ...cookie, authority: upstream.target.authority };
  upstream.cookieAt = Date.now();
  log(`上游就绪：${upstream.target.origin}`);
}

function scheduleRefresh() {
  if (refreshing !== null) return refreshing;
  if (Date.now() - lastRefreshAt < 3000) return Promise.resolve();
  refreshing = refreshUpstream()
    .catch((error) => log('上游刷新失败：' + error.message))
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function handleStatus(req, res, hint) {
  if (!isLocalRequest(req)) return json(res, 403, { error: '本机入口访问受限' });
  const origin = currentOrigin(hint);
  const phoneUrl = phoneUrlFor(origin);
  const publicOrigin = isPublicOrigin(origin) ? origin : null;
  return json(res, 200, {
    service: 'dsh-mobile',
    status: publicOrigin === null ? 'local' : 'online',
    upstream: upstream.target?.origin ?? null,
    upstreamReady: upstream.target !== null && upstream.cookie !== null,
    frontend: frontend?.status ?? { mode: 'live-test' },
    provider: providerFor(origin),
    basePath: BASE_PATH,
    publicOrigin,
    lan: lanAddresses().map((address) => `http://${address}:${PORT}${BASE_PATH}/`),
    path: tokenPath(),
    phoneUrl,
    qr: phoneUrl ? await qrFor(phoneUrl) : null,
    uptimeMs: Date.now() - STARTED_AT,
    pid: process.pid,
  });
}

async function main() {
  accessToken = await loadOrCreateToken();
  try {
    await refreshUpstream();
  } catch (error) {
    log('启动时未找到 Harness 网页服务：' + error.message);
  }
  if (upstream.target === null) log('等待 DeepSeek Harness 启动（端口未知）');

  // 端口会随 Harness 重启变化，定期核对；cookie 也在这里按需重签。
  setInterval(() => { refreshUpstream().catch(() => {}); }, 10_000).unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dshm.invalid');
    try {
      // 本机面板固定用根路径探测，前缀之外也接受两个只读入口。
      const localInner = url.pathname === '/_dsh/status' || url.pathname === '/_dsh/ping' ? url.pathname : undefined;
      const inner = localInner ?? stripBasePath(url.pathname);
      if (inner === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('not found\n');
      }
      if (inner === '' && BASE_PATH !== '') {
        res.writeHead(308, { location: `${BASE_PATH}/${url.search}`, 'cache-control': 'no-store' });
        return res.end();
      }
      if (inner === '/_dsh/ping') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('dsh-mobile');
      }
      if (inner === '/_dsh/status') return await handleStatus(req, res, url.searchParams.get('publicOrigin'));

      if (url.searchParams.get('t') !== null) {
        if (url.searchParams.get('t') !== accessToken) return json(res, 401, { error: '口令无效' });
        res.writeHead(302, {
          'set-cookie': `${COOKIE_NAME}=${accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_DAYS * 86400}`,
          location: `${BASE_PATH}/`,
          'cache-control': 'no-store',
        });
        return res.end();
      }

      if (readCookie(req.headers.cookie, COOKIE_NAME) !== accessToken) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('需要手机连接口令：请重新扫描二维码。\n');
      }

      if (frontend && await frontend.serve(req, res, inner, url.search)) return;

      if (upstream.target === null || upstream.cookie === null) {
        await scheduleRefresh();
        if (upstream.target === null || upstream.cookie === null) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end('DeepSeek Harness 未在运行：请在电脑上打开 Harness 后刷新。\n');
        }
      }

      if (inner !== url.pathname) req.url = `${inner}${url.search}`;
      const { target, cookie } = upstream;
      await proxyHttp(req, res, {
        host: '127.0.0.1',
        port: target.port,
        authority: target.authority,
        origin: target.origin,
        cookie: cookie.header,
        agent,
        transformHtml: injectMobileShell,
        onUpstreamError: (error) => {
          log('upstream:', error.message);
          scheduleRefresh();
        },
      });
    } catch (error) {
      log('request failed:', error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('手机网关内部错误\n');
      } else {
        res.destroy();
      }
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://dshm.invalid');
    const inner = stripBasePath(url.pathname);
    if (inner === undefined || inner === '/_dsh/status' || inner === '/_dsh/ping') return socket.destroy();
    if (readCookie(req.headers.cookie, COOKIE_NAME) !== accessToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (upstream.target === null || upstream.cookie === null) await scheduleRefresh();
    if (upstream.target === null || upstream.cookie === null) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (inner !== url.pathname) req.url = `${inner}${url.search}`;
    const { target, cookie } = upstream;
    proxyUpgrade(req, socket, head, {
      host: '127.0.0.1',
      port: target.port,
      authority: target.authority,
      origin: target.origin,
      cookie: cookie.header,
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, BIND, resolve);
  });
  log(`DSH 手机网关已启动：http://127.0.0.1:${PORT}${BASE_PATH}/  监听 ${BIND}:${PORT}`);

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log('shutting down');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

main().catch((error) => {
  console.error('dsh-mobile failed:', error);
  process.exit(1);
});
