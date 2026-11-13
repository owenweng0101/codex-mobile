// Explicit manual capture only. Never run from install/start/update hooks.
// frontend/public must first contain the reviewed dsh-web-frontend/dist files.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadBrowserCookie } from '../backend/dsh-auth.mjs';
const dir = fileURLToPath(new URL('../frontend/', import.meta.url));
if (!process.argv.includes('--replace')) throw new Error('Frontend updates require explicit user authorization and --replace');
await readFile(join(dir, 'public/index.html'));
const status = await (await fetch('http://127.0.0.1:18902/_dsh/status')).json();
if (!status.upstreamReady) throw new Error('DSH upstream is not ready');
const origin = new URL(status.upstream);
const cookie = await loadBrowserCookie({ authority: origin.host, maxAgeDays: 30 });
async function download(path) {
  const response = await fetch(new URL(path, origin), { headers: { cookie: cookie.header, accept: 'text/html', 'accept-encoding': 'identity' } });
  if (!response.ok) throw new Error(`Capture failed: ${response.status} ${path}`);
  return { body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') };
}
let html = (await download('/')).body.toString('utf8');
const pattern = /globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s;
const boot = JSON.parse(html.match(pattern)[1]);
// Keep the boot graph and remove only its automatic frontend update subscriber.
boot.entries = boot.entries.filter(entry => entry.id !== '@deepseek-ai/dsh-client-hmr');
for (const batch of boot.batches) batch.entries = batch.entries.filter(id => id !== '@deepseek-ai/dsh-client-hmr');
html = html.replace(pattern, 'globalThis["__DSH_BOOT__"] = ' + JSON.stringify(boot) + '</script>');
const urls = new Set([...boot.entries, ...boot.batches].map(entry => entry.url));
for (const match of html.matchAll(/(?:src|href)="(plugins\/[^\"]+)"/g)) urls.add(match[1].replaceAll('&amp;', '&'));
await mkdir(join(dir, 'bundles'), { recursive: true });
const resources = {};
for (const url of urls) {
  const { body, type } = await download(url);
  if (!type?.includes('javascript')) throw new Error('Not a JavaScript bundle: ' + url);
  const hash = createHash('sha256').update(body).digest('hex');
  const file = 'bundles/' + hash + '.js';
  await writeFile(join(dir, file), body);
  resources['/' + url] = { file, type, sha256: hash };
}
await writeFile(join(dir, 'index.html'), html);
await writeFile(join(dir, 'manifest.json'), JSON.stringify({ mode: 'pinned', capturedAt: new Date().toISOString(), release: boot.release, autoUpdate: false, resources }, null, 2) + '\n');
console.log({ mode: 'pinned', release: boot.release, bundles: urls.size });
