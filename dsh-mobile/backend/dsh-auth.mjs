import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * DSH 网页端要求每个请求携带由 `$DSH_HOME/.credentials.yaml` 中
 * `client-connection/browser-session` 密钥签名的 cookie。
 *
 * 这个模块只在本机读取该密钥，按 host + 端口派生 cookie 名与签名，
 * 供手机网关在转发请求时注入。密钥不写入日志、不出现在 argv。
 */

const COOKIE_PREFIX = 'dsh-auth-';
const SECRET_BYTES = 32;
const COOKIE_VERSION = 1;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

function base64url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64url(value) {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

/** 从凭证 YAML 中取出浏览器会话签名密钥（32 字节原始缓冲）。 */
export function parseBrowserSessionSecret(yamlText) {
  const marker = 'client-connection/browser-session:';
  const start = yamlText.indexOf(marker);
  if (start === -1) throw new Error('DSH credentials: client-connection/browser-session record is missing');
  const block = yamlText.slice(start + marker.length);
  const match = block.match(/^\s*secret:\s*(\S+)\s*$/m);
  if (match === null) throw new Error('DSH credentials: browser-session secret is missing');
  const secret = decodeBase64url(match[1]);
  if (secret.byteLength !== SECRET_BYTES) throw new Error('DSH credentials: browser-session secret has an unexpected length');
  return secret;
}

/**
 * 生成某个 authority 的签名 cookie。
 * @param {object} options
 * @param {Buffer} options.secret 32 字节签名密钥
 * @param {string} options.authority `host:port`，例如 127.0.0.1:52115
 * @param {number} [options.maxAgeDays] cookie 有效期，默认 30 天
 * @returns {{ name: string, value: string, header: string }}
 */
export function signBrowserCookie({ secret, authority, maxAgeDays = 30, now = Date.now() }) {
  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority).digest());
  const payload = {
    version: COOKIE_VERSION,
    authority,
    issuedAt: now,
    expiresAt: now + maxAgeDays * DAY_MILLISECONDS,
  };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = base64url(createHmac('sha256', secret).update(body).digest());
  const value = `v${COOKIE_VERSION}.${body}.${signature}`;
  return { name, value, header: `${name}=${value}` };
}

/** 读取 $DSH_HOME 下的凭证文件；默认 ~/.dsh，可用 DSH_HOME 覆盖。 */
export function credentialsPath(home = process.env.DSH_HOME ?? join(process.env.HOME ?? homedir(), '.dsh')) {
  return join(home, '.credentials.yaml');
}

/** 读取密钥并返回可直接注入的 cookie 头。 */
export async function loadBrowserCookie({ authority, home, maxAgeDays } = {}) {
  const text = await readFile(credentialsPath(home), 'utf8');
  const secret = parseBrowserSessionSecret(text);
  return { ...signBrowserCookie({ secret, authority, maxAgeDays }), secret };
}
