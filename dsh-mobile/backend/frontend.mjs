import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { buildMobileProfile } from './mobile-profile.mjs';
import { injectMobileShell } from './mobile.mjs';

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };

/** Only static UI resources are pinned. Auth, API and WebSocket traffic stay live. */
export async function loadPinnedFrontend(directory = fileURLToPath(new URL('../frontend/', import.meta.url))) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const profile = await buildMobileProfile(root, await readFile(resolve(root, 'index.html'), 'utf8'), manifest);
  const html = injectMobileShell(profile.html);
  const cache = new Map();
  const publicNames = new Set(await readdir(resolve(root, 'public')));
  return {
    status: { mode: 'pinned', release: manifest.release, capturedAt: manifest.capturedAt, autoUpdate: false, profile: 'mobile', modules: profile.entries.length },
    async serve(req, res, inner, search) {
      const bundle = profile.resources[inner + search];
      const isIndex = inner === '/' || inner === '/index.html';
      const isPlugin = inner.startsWith('/plugins/');
      const publicRoot = resolve(root, 'public');
      let pathname;
      try { pathname = decodeURIComponent(inner); } catch { pathname = ''; }
      const publicFile = resolve(publicRoot, '.' + pathname);
      const isStatic = inner.startsWith('/assets/') || publicNames.has(inner.slice(1));
      if (!isIndex && !isPlugin && !isStatic) return false;
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { 'cache-control': 'no-store', allow: 'GET, HEAD' }); res.end(); return true;
      }
      try {
        let body, type;
        if (isIndex) { body = Buffer.from(html); type = 'text/html; charset=utf-8'; }
        else if (bundle) { body = profile.bodies.get(inner + search); type = bundle.type; }
        else {
          // Never fetch missing UI code from an upgraded desktop runtime.
          if (isPlugin || !publicFile.startsWith(publicRoot + sep)) throw new Error('Missing pinned asset');
          body = await readFile(publicFile);
          type = TYPES[extname(publicFile)] || 'application/octet-stream';
        }
        const key = bundle ? inner + search : inner;
        let asset = !isIndex && cache.get(key);
        if (!asset) {
          asset = { body, etag: '"' + createHash('sha256').update(body).digest('hex') + '"' };
          if (/javascript|text\/|json|svg/.test(type) && body.length > 1024) {
            asset.br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
            asset.gzip = gzipSync(body);
          }
          if (!isIndex) cache.set(key, asset);
        }
        const encoding = chooseEncoding(req.headers['accept-encoding'], asset);
        const bytes = encoding ? asset[encoding] : asset.body;
        // Authentication is checked by server.mjs before any cached asset is served.
        const immutable = !!bundle || /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(inner);
        const headers = { 'content-type': type, 'cache-control': isIndex ? 'no-store' : immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache', 'x-content-type-options': 'nosniff', 'x-dshm-frontend': 'pinned', vary: 'Accept-Encoding, Cookie' };
        if (!isIndex) headers.etag = 'W/' + asset.etag;
        if (encoding) headers['content-encoding'] = encoding;
        if (!isIndex && req.headers['if-none-match']?.split(',').some(v => v.trim().replace(/^W\//, '') === asset.etag)) {
          res.writeHead(304, headers); res.end(); return true;
        }
        res.writeHead(200, { ...headers, 'content-length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('固定版手机页面中没有此资源。\n');
      }
      return true;
    },
  };
}

function chooseEncoding(header = '', asset) {
  const q = new Map(header.toLowerCase().split(',').map(part => {
    const [name, ...params] = part.trim().split(';');
    const value = params.find(v => v.trim().startsWith('q='));
    const n = value ? Number(value.trim().slice(2)) : 1;
    return [name, Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0];
  }));
  return ['br', 'gzip'].filter(x => asset[x] && (q.get(x) ?? q.get('*') ?? 0) > 0)
    .sort((a,b) => (q.get(b) ?? q.get('*') ?? 0) - (q.get(a) ?? q.get('*') ?? 0))[0];
}
