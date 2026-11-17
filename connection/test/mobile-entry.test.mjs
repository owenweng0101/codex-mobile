import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {HUB_FALLBACK, HUB_FRAME_PARAM, withHubFrame, isHubFrameRequest, hubEntryGuard, unifiedEntryTarget} from '../mobile-entry.mjs';

test('frame marker preserves absolute/relative query bytes and hash, and is idempotent', () => {
  assert.equal(HUB_FRAME_PARAM, 'hub_frame');
  for (const [input, expected] of [
    ['/dsh/', '/dsh/?hub_frame=1'],
    ['/#fixture', '/?hub_frame=1#fixture'],
    ['/dsh/?t=fixture&v=2', '/dsh/?t=fixture&v=2&hub_frame=1'],
    ['https://relay.example.test:12345/?q=a%20b&next=%2f#fixture', 'https://relay.example.test:12345/?q=a%20b&next=%2f&hub_frame=1#fixture'],
    ['../entry?blank=&x=1#fragment?unchanged', '../entry?blank=&x=1&hub_frame=1#fragment?unchanged'],
    ['/entry?hub_frame=0&t=fixture&hub_frame=1#', '/entry?t=fixture&hub_frame=1#'],
    ['/entry?%68ub_frame=0&x=1', '/entry?x=1&hub_frame=1'],
  ]) {
    assert.equal(withHubFrame(input), expected);
    assert.equal(withHubFrame(expected), expected);
  }
  assert.equal(withHubFrame(new URL('https://relay.example.test/#fixture')), 'https://relay.example.test/?hub_frame=1#fixture');
});

test('browser destination wins over marker: only iframe is accepted when metadata exists', () => {
  for (const destination of ['document', 'empty', 'image', 'script', '', 'unknown', 'IFRAME']) {
    assert.equal(isHubFrameRequest({headers:{'sec-fetch-dest':destination}}, '/?hub_frame=1'), false, destination);
  }
  assert.equal(isHubFrameRequest({headers:{'sec-fetch-dest':'iframe'}}, '/'), true);
  assert.equal(isHubFrameRequest({headers:{'Sec-Fetch-Dest':'iframe'}}, '/?hub_frame=0'), true);
  assert.equal(isHubFrameRequest({headers:{'sec-fetch-dest':['iframe','document']}}, '/?hub_frame=1'), false);
  assert.equal(isHubFrameRequest({headers:new Headers({'Sec-Fetch-Dest':'document'})}, new URL('https://relay.example.test/?hub_frame=1')), false);
  assert.equal(isHubFrameRequest({headers:new Headers({'Sec-Fetch-Dest':'iframe'})}, '/'), true);
});

test('only missing metadata enables the old-WebView marker compatibility path', () => {
  assert.equal(isHubFrameRequest({headers:{},url:'/dsh/?hub_frame=1'}), true);
  assert.equal(isHubFrameRequest({headers:new Headers()}, '/?hub_frame=1#fixture'), true);
  assert.equal(isHubFrameRequest({}, '/?hub_frame=1'), true);
  for (const url of ['/', '/?embedded=1', '/?hub_frame=0', '/?hub_frame=true', '/?hub_frame=1&hub_frame=0', '/#hub_frame=1', 'http://[invalid']) {
    assert.equal(isHubFrameRequest({headers:{}}, url), false, url);
  }
});

function executeGuard(html, {topLevel=true} = {}) {
  const events = [], style = {};
  Object.defineProperty(style, 'visibility', {set:value=>events.push(['visibility',value])});
  const self = {}, window = {self, top:topLevel?self:{}, stop:()=>events.push(['stop']), location:{replace:value=>events.push(['replace',value])}};
  const script = /<script data-hub-entry-guard>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(script, 'guard was inserted');
  vm.runInNewContext(script[1], {window, document:{documentElement:{style}}});
  return events;
}

test('guard is first in head, before module/preload scripts, and hides/stops/replaces in order', () => {
  const original = '<!doctype html><html><head><link rel="modulepreload" href="app.mjs"><script type="module" src="app.mjs"></script></head><body>app</body></html>';
  const guarded = hubEntryGuard(original);
  assert.ok(guarded.startsWith('<!doctype html><html><head><script data-hub-entry-guard>'));
  assert.ok(guarded.indexOf('data-hub-entry-guard') < guarded.indexOf('modulepreload'));
  assert.ok(guarded.indexOf('data-hub-entry-guard') < guarded.indexOf('type="module"'));
  assert.deepEqual(executeGuard(guarded), [['visibility','hidden'],['stop'],['replace','/m/#']]);
  assert.deepEqual(executeGuard(guarded, {topLevel:false}), []);
  assert.ok(guarded.endsWith('<body>app</body></html>'));
});

test('headerless marker is not a standalone-page bypass: top-level guard still redirects', () => {
  assert.equal(isHubFrameRequest({headers:{}}, '/dsh/?hub_frame=1'), true);
  assert.deepEqual(executeGuard(hubEntryGuard('<html><head></head><body>DSH</body></html>')), [['visibility','hidden'],['stop'],['replace','/m/#']]);
});

test('guard supports head attributes, missing head and safe custom-target serialization', () => {
  for (const html of ['<HTML><HEAD data-app="test"><script type="module"></script></HEAD></HTML>', '<!doctype html><html><body>app</body></html>', '<script type="module" src="app.mjs"></script>']) {
    const guarded = hubEntryGuard(html, 'https://relay.example.test/m/#');
    assert.deepEqual(executeGuard(guarded).at(-1), ['replace','https://relay.example.test/m/#']);
    if (html.includes('type="module"')) assert.ok(guarded.indexOf('data-hub-entry-guard') < guarded.indexOf('type="module"'));
  }
  const target = '/m/#</script><script>unexpected()</script>\u2028';
  const guarded = hubEntryGuard('<head></head>', target);
  assert.equal((guarded.match(/<script/g) || []).length, 1);
  assert.deepEqual(executeGuard(guarded).at(-1), ['replace',target]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'mobile-entry-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const statePath = join(root,'state.json');
  return {statePath, save:value=>writeFile(statePath,JSON.stringify(value))};
}

test('validated HTTPS state origin yields a clean unified URL with an explicit empty fragment', async t => {
  const f = await fixture(t);
  for (const [origin, expected] of [
    ['https://relay.example.test','https://relay.example.test/m/#'],
    ['https://relay.nyat.app:12345/','https://relay.nyat.app:12345/m/#'],
    ['https://RELAY.example.test:443/','https://relay.example.test/m/#'],
  ]) {
    await f.save({origin});
    assert.equal(await unifiedEntryTarget({statePath:f.statePath}), expected);
    assert.equal(new URL(expected).search, '');
    assert.ok(expected.endsWith('/m/#'));
  }
});

test('unsafe or credential-bearing state origins cannot turn into redirect targets', async t => {
  const f = await fixture(t);
  for (const origin of [
    null, 42, '', 'http://relay.example.test', '//relay.example.test', 'javascript:alert(1)',
    'https://user:password@relay.example.test/', 'https://relay.example.test/old',
    'https://relay.example.test/?t=fixture', 'https://relay.example.test/#fixture',
    'https://localhost/', 'https://localhost./', 'https://app.localhost/', 'https://host.local/',
    'https://127.0.0.1/', 'https://127.1/', 'https://0.0.0.0/', 'https://10.1.2.3/',
    'https://172.16.0.1/', 'https://192.168.1.1/', 'https://169.254.1.1/', 'https://100.64.0.1/',
    'https://[::1]/', 'https://[::]/', 'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[::ffff:127.0.0.1]/',
    ' https://relay.example.test/', 'https://relay.example.test/\n',
  ]) {
    await f.save({origin});
    assert.equal(await unifiedEntryTarget({statePath:f.statePath}), HUB_FALLBACK, String(origin));
  }
});

test('missing or corrupt state falls back without trusting Host, Origin, URL or forwarded headers', async t => {
  const f = await fixture(t);
  const request = {headers:{host:'attacker.example.test',origin:'https://attacker.example.test','x-forwarded-host':'attacker.example.test','x-forwarded-proto':'https'},url:'/?t=old#old'};
  assert.equal(await unifiedEntryTarget({request,statePath:f.statePath}), HUB_FALLBACK);
  for (const raw of ['not JSON', 'null', '{}', 'x'.repeat(100001)]) {
    await writeFile(f.statePath,raw);
    assert.equal(await unifiedEntryTarget({request,statePath:f.statePath}), HUB_FALLBACK);
  }
  await f.save({origin:'https://relay.example.test'});
  const before = await readFile(f.statePath,'utf8');
  assert.equal(await unifiedEntryTarget({request,statePath:f.statePath}), 'https://relay.example.test/m/#');
  assert.equal(await readFile(f.statePath,'utf8'), before, 'helper does not modify state');
});

test('entry fallback is same-origin so a phone never lands on its own localhost', async t => {
  const f = await fixture(t);
  // A bare path cannot name a host: the phone resolves it on the origin that
  // actually served the request, whether that is the HTTPS tunnel or LAN http.
  assert.equal(HUB_FALLBACK, '/m/#');
  assert.doesNotMatch(HUB_FALLBACK, /^[a-z][a-z0-9+.-]*:|127\.0\.0\.1|localhost|\/\//i);
  assert.equal(await unifiedEntryTarget({statePath:f.statePath}), HUB_FALLBACK);
  for (const [base, expected] of [
    ['https://relay.example.test/', 'https://relay.example.test/m/#'],
    ['https://relay.example.test/dsh/index.html?hub_frame=1', 'https://relay.example.test/m/#'],
    ['http://192.168.1.20:18903/m/?t=fixture', 'http://192.168.1.20:18903/m/#'],
    ['http://192.168.1.20:18903/claude/', 'http://192.168.1.20:18903/m/#'],
  ]) assert.equal(new URL(HUB_FALLBACK, base).href, expected, base);
  // The standalone-page guard must carry the exact same relative target.
  assert.deepEqual(executeGuard(hubEntryGuard('<head></head>', HUB_FALLBACK)).at(-1), ['replace', HUB_FALLBACK]);
  // A validated tunnel origin still wins, so a reconnected tunnel keeps working.
  await f.save({origin:'https://relay.example.test'});
  assert.equal(await unifiedEntryTarget({statePath:f.statePath}), 'https://relay.example.test/m/#');
});
