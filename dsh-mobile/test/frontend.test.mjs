import {pinnedTest as test,hasPinnedFrontend} from './pinned-fixture.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadPinnedFrontend } from '../backend/frontend.mjs';

const frontend = hasPinnedFrontend ? await loadPinnedFrontend() : null;
const root = new URL('../frontend/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
assert.ok(Object.keys(manifest.resources).every(key=>!key.includes('@local/')), 'public manifest must exclude local plugins and their mixed desktop batches');

test('pinned UI stays identical when the desktop changes; API stays live', async () => {
  let desktopVersion = 'desktop-before';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (await frontend.serve(req, res, url.pathname, url.search)) return;
    res.end(desktopVersion);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const before = await (await fetch(origin + '/')).text();
    const asset = Object.keys(manifest.resources)[0];
    const code = await (await fetch(origin + asset)).text();
    desktopVersion = 'desktop-upgraded';
    assert.equal(await (await fetch(origin + '/')).text(), before);
    assert.equal(await (await fetch(origin + asset)).text(), code);
    assert.equal(await (await fetch(origin + '/api/session/list')).text(), 'desktop-upgraded');
    assert.equal((await fetch(origin + '/assets/new-desktop.js')).status, 404);
    assert.equal((await fetch(origin + '/plugins/??new-desktop/client.js')).status, 404);
    assert.equal((await fetch(origin + '/assets/%2e%2e%2f%2e%2e%2fmanifest.json')).status, 404);
    const boot = JSON.parse(before.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
    assert.equal(boot.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-hmr'), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('every captured plugin bundle is present and matches its recorded hash', async () => {
  for (const resource of Object.values(manifest.resources)) {
    const bytes = await readFile(new URL(resource.file, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), resource.sha256);
  }
});

test('mobile boot and fetched batches exclude desktop and dynamic plugin runners', async () => {
  const { buildMobileProfile } = await import('../backend/mobile-profile.mjs');
  const { fileURLToPath } = await import('node:url');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('index.html', root), 'utf8');
  const profile = await buildMobileProfile(fileURLToPath(root), source, manifest);
  const boot = JSON.parse(profile.html.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
  const registrations = [];
  for (const batch of boot.batches) runInNewContext(profile.bodies.get('/' + batch.url).toString(), {window:{__ModuleLoader__:{load:entry=>registrations.push(entry.id)}}});
  assert.deepEqual(registrations.sort(), profile.entries.slice().sort());
  assert.ok(!registrations.some(id => /@local\/|cordis|plugin-manager|settings-plugin|client-hmr|ui-schedule/.test(id)));
  for (const name of ['ui-attachment','ui-sidebar-documentpreview','ui-model-selection','ui-approval','ui-user-questions','ui-goal']) assert.ok(registrations.includes('@deepseek-ai/dsh-client-'+name));
  const changed = JSON.parse(source.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
  changed.entries.push({id:'@local/new-desktop-plugin',url:'plugins/??new.js'});
  const future = source.replace(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s, 'globalThis["__DSH_BOOT__"] = '+JSON.stringify(changed)+'</script>');
  const after = await buildMobileProfile(fileURLToPath(root), future, manifest);
  assert.deepEqual(after.entries, profile.entries);
  assert.equal(after.html, profile.html);
});

test('static code is compressed, privately cached and revalidated; HTML is not cached', async () => {
  const { brotliDecompressSync, gunzipSync } = await import('node:zlib');
  const server = http.createServer(async(req,res)=>{const url=new URL(req.url,'http://test');if(!await frontend.serve(req,res,url.pathname,url.search)){res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const get=(path,headers={})=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject);});
  try {
    const html=await get('/');assert.equal(html.headers['cache-control'],'no-store');
    const boot=JSON.parse(html.body.toString().match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
    const path='/'+boot.batches.find(b=>b.phase==='application').url;
    const plain=await get(path),br=await get(path,{'accept-encoding':'br, gzip'});
    assert.equal(br.headers['content-encoding'],'br');assert.deepEqual(brotliDecompressSync(br.body),plain.body);
    assert.ok(br.body.length<plain.body.length*0.4);assert.match(br.headers['cache-control'],/^private,.*immutable/);
    const gz=await get(path,{'accept-encoding':'br;q=0, gzip;q=1'});assert.equal(gz.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(gz.body),plain.body);
    const cached=await get(path,{'if-none-match':plain.headers.etag});assert.equal(cached.status,304);assert.equal(cached.body.length,0);
    const disabled=await get(path,{'accept-encoding':'br;q=0, gzip;q=0'});assert.equal(disabled.headers['content-encoding'],undefined);
    const originalBoot=JSON.parse((await readFile(new URL('index.html',root),'utf8')).match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
    const excluded=originalBoot.entries.filter(entry=>entry.id.startsWith('@local/'));
    assert.equal(excluded.length,2,'the unchanged desktop snapshot has two local plugins');
    for(const entry of excluded)assert.equal((await get('/'+entry.url)).status,404);
    for(const batch of originalBoot.batches.filter(batch=>batch.entries.some(id=>id.startsWith('@local/'))))assert.equal((await get('/'+batch.url)).status,404);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('the pinned PDF lazy chunk is served, while unreviewed revisions remain unavailable', async()=>{
  const html=await new Promise(resolve=>{
    frontend.serve({method:'GET',headers:{}},{writeHead(){},end:body=>resolve(String(body))},'/','');
  });
  const boot=JSON.parse(html.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
  const owner=boot.entries.find(entry=>entry.id==='@deepseek-ai/dsh-client-ui-sidebar-documentpreview');
  const key='/plugins/'+owner.id+'/client.pdf.js?rev='+owner.rev;
  const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://test');await frontend.serve(req,res,u.pathname,u.search);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  try{const response=await fetch(origin+key);assert.equal(response.status,200);const body=Buffer.from(await response.arrayBuffer());assert.ok(body.includes(Buffer.from('installPdfCompatibility')));assert.equal((await fetch(origin+key.replace(owner.rev,'unreviewed'))).status,404);assert.match(response.headers.get('cache-control'),/private,.*immutable/);}finally{await new Promise(resolve=>server.close(resolve));}
});
