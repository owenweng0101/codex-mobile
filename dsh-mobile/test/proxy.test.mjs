import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterHeaders, rewriteHeaders } from '../backend/proxy.mjs';
import { injectMobileShell } from '../backend/mobile.mjs';

const options = {
  authority: '127.0.0.1:52115',
  origin: 'http://127.0.0.1:52115',
  cookie: 'dsh-auth-abc=signature',
};

test('drops hop-by-hop headers', () => {
  const headers = filterHeaders({ connection: 'keep-alive', 'transfer-encoding': 'chunked', 'x-keep': 'yes' });
  assert.deepEqual(headers, { 'x-keep': 'yes' });
});

test('rewrites host, origin and referer to the upstream authority', () => {
  const headers = rewriteHeaders({
    host: 'abc.trycloudflare.com',
    origin: 'https://abc.trycloudflare.com',
    referer: 'https://abc.trycloudflare.com/dsh/?t=secret',
  }, options);
  assert.equal(headers.host, '127.0.0.1:52115');
  assert.equal(headers.origin, 'http://127.0.0.1:52115');
  assert.equal(headers.referer, 'http://127.0.0.1:52115/dsh/?t=secret');
});

test('keeps foreign cookies and replaces dsh credential cookies', () => {
  const headers = rewriteHeaders({
    cookie: 'theme=dark; dsh-auth-old=stale; dshm-auth=phone; locale=zh',
  }, options);
  assert.equal(headers.cookie, 'theme=dark; locale=zh; dsh-auth-abc=signature');
});

test('asks for identity encoding only when the body is transformed', () => {
  const transformed = rewriteHeaders({ 'accept-encoding': 'gzip, br' }, { ...options, identity: true });
  assert.equal(transformed['accept-encoding'], 'identity');
  const passthrough = rewriteHeaders({ 'accept-encoding': 'gzip, br' }, options);
  assert.equal(passthrough['accept-encoding'], 'gzip, br');
});

test('drops a referer that cannot be parsed instead of forwarding it', () => {
  const headers = rewriteHeaders({ referer: 'not a url' }, options);
  assert.equal(headers.referer, undefined);
});

test('mobile shell replaces the viewport and injects style and script once', () => {
  const html = '<!doctype html><html><head><meta name="viewport" content="width=1024"></head><body><div id="app"></div></body></html>';
  const output = injectMobileShell(html);
  assert.match(output, /width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover/);
  assert.equal(output.match(/id="dshm-mobile"/g)?.length, 1);
  assert.equal(output.match(/id="dshm-mobile-shell"/g)?.length, 1);
  assert.ok(output.indexOf('dshm-mobile-shell') > output.indexOf('<div id="app">'));
  assert.ok(output.indexOf('dshm-mobile"') < output.indexOf('</head>'));
});

test('mobile shell adds a viewport when the document has none', () => {
  const output = injectMobileShell('<html><head></head><body></body></html>');
  assert.match(output, /<head><meta name="viewport"/);
});
