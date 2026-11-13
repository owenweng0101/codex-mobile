import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { parseBrowserSessionSecret, signBrowserCookie } from '../backend/dsh-auth.mjs';

const base64url = (value) => Buffer.from(value).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const secret = Buffer.alloc(32, 7);
const secretText = base64url(secret);

const credentials = `version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: ${secretText}
  other-record:
    kind: grant
    payload:
      secret: not-this-one
refs:
  JD_API_KEY: abcdef
`;

test('parses the browser-session secret from the credentials store', () => {
  const parsed = parseBrowserSessionSecret(credentials);
  assert.equal(parsed.byteLength, 32);
  assert.deepEqual(parsed, secret);
});

test('rejects a missing or malformed secret', () => {
  assert.throws(() => parseBrowserSessionSecret('version: 1\nrecords: {}\n'), /browser-session/);
  assert.throws(
    () => parseBrowserSessionSecret('client-connection/browser-session:\n  kind: grant\n  payload:\n    secret: short\n'),
    /unexpected length/,
  );
});

test('signs the cookie the host verifies (name, payload, HMAC)', () => {
  const now = 1_800_000_000_000;
  const cookie = signBrowserCookie({ secret, authority: '127.0.0.1:52115', maxAgeDays: 30, now });

  const expectedName = 'dsh-auth-' + base64url(createHash('sha256').update('127.0.0.1:52115').digest());
  assert.equal(cookie.name, expectedName);

  const [version, body, signature] = cookie.value.split('.');
  assert.equal(version, 'v1');
  const payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  assert.deepEqual(payload, {
    version: 1,
    authority: '127.0.0.1:52115',
    issuedAt: now,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  });
  const expected = base64url(createHmac('sha256', secret).update(body).digest());
  assert.equal(signature, expected);
  assert.equal(cookie.header, `${cookie.name}=${cookie.value}`);
});

test('cookie name is authority-specific', () => {
  const first = signBrowserCookie({ secret, authority: '127.0.0.1:52115' });
  const second = signBrowserCookie({ secret, authority: '127.0.0.1:18902' });
  assert.notEqual(first.name, second.name);
});
