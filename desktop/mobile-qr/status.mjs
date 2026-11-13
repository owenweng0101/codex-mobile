import {readControlResponse} from '../../connection/control-client.mjs';

const offline = reason => ({status:'offline', reason, phoneUrl:null, qr:null});
const pngData = value => typeof value === 'string' && value.length <= 60000
  && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
const localHost = host => ['localhost','127.0.0.1','[::1]'].includes(host)
  || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);

// Bound both headers and body, including injected transports that ignore abort.
async function readJson(url, request, timeoutMs, limit) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {controller.abort(); reject(Error('Status deadline'));}, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await request(url, {signal:controller.signal, redirect:'error'});
      if (!response.ok) throw Error('Status unavailable');
      const raw = await response.text();
      if (raw.length > limit) throw Error('Status too large');
      return JSON.parse(raw);
    })(), timeout]);
  } finally { clearTimeout(timer); }
}

export function isLocalMobileRequest(req, port) {
  const host = req.headers.host;
  return ['127.0.0.1:' + port, 'localhost:' + port].includes(host)
    && (!req.headers.origin || req.headers.origin === 'http://' + host)
    && req.headers['sec-fetch-site'] !== 'cross-site'
    && !Object.keys(req.headers).some(key => key.startsWith('x-forwarded-') || ['forwarded','via','cf-ray'].includes(key));
}

export async function readMobileStatus({fetchImpl=(_url, options)=>readControlResponse(options), timeoutMs=2500}={}) {
  try {
    const value = await readJson('http://localhost/local/status', fetchImpl, timeoutMs, 100000);
    if (value.status !== 'online' || value.mode !== 'codex-read' || !pngData(value.qr)) return offline('共享入口未就绪');
    const phone = new URL(value.phoneUrl);
    if (phone.protocol !== 'https:' || phone.username || phone.password || localHost(phone.hostname)
      || (phone.port && !(value.provider === 'sakura' && phone.hostname.endsWith('.nyat.app') && Number(phone.port) >= 1024))
      || phone.pathname !== '/' || phone.search || !/^#[A-Za-z0-9_-]{43}$/.test(phone.hash)) return offline('共享入口地址无效');
    return {status:'online', mode:'codex-read', provider:value.provider, phoneUrl:phone.href, qr:value.qr};
  } catch { return offline('共享入口暂不可用'); }
}

function publicOriginOf(phoneUrl) {
  try {
    const url = new URL(phoneUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !localHost(url.hostname) ? url.origin : null;
  } catch { return null; }
}

async function readGateway({service, pathname, statusUrl, mobileStatus, fetchImpl=fetch, timeoutMs=2500}) {
  try {
    const target = new URL(statusUrl);
    // Never send even the public origin to a caller-selected remote status API.
    if (target.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(target.hostname)
      || target.username || target.password || target.hash) return offline('状态地址无效');
    const publicOrigin = publicOriginOf(mobileStatus?.phoneUrl);
    if (publicOrigin) target.searchParams.set('publicOrigin', publicOrigin);
    const value = await readJson(target.href, fetchImpl, timeoutMs, 200000);
    if (value.service !== service || !['online','local'].includes(value.status) || !pngData(value.qr)) return offline('入口状态无效');
    const phone = new URL(value.phoneUrl);
    if (phone.username || phone.password || phone.hash || phone.pathname !== pathname
      || phone.searchParams.getAll('t').length !== 1 || !/^[A-Za-z0-9_-]{32,}$/.test(phone.searchParams.get('t') || '')) return offline('入口地址无效');
    if (value.status === 'online' && (phone.protocol !== 'https:' || localHost(phone.hostname) || (publicOrigin && phone.origin !== publicOrigin))) return offline('入口与共享隧道不一致');
    if (value.status === 'local' && (phone.protocol !== 'http:' || !localHost(phone.hostname))) return offline('局域网入口地址无效');
    return {status:value.status, upstreamReady:value.upstreamReady === true, provider:value.status === 'online'?'tunnel':'lan', publicOrigin, phoneUrl:phone.href, qr:value.qr};
  } catch { return offline('手机入口暂不可用'); }
}

export function readDshStatus(options={}) {
  return readGateway({...options, service:'dsh-mobile', pathname:'/dsh/', statusUrl:options.statusUrl || 'http://127.0.0.1:18902/_dsh/status'});
}

export function readClaudeStatus(options={}) {
  return readGateway({...options, service:'claude-mobile', pathname:'/m/', statusUrl:options.statusUrl || 'http://127.0.0.1:18903/_claude/status'});
}

export async function readStatuses() {
  const mobile = await readMobileStatus();
  const [dsh, claude] = await Promise.all([readDshStatus({mobileStatus:mobile}), readClaudeStatus({mobileStatus:mobile})]);
  return {mobile, dsh, claude};
}
