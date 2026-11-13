import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {isIP} from 'node:net';

export const HUB_FRAME_PARAM = 'hub_frame';
const FALLBACK = 'http://127.0.0.1:18903/m/#';

// Keep existing query bytes and the fragment intact, replacing only our marker.
export function withHubFrame(url) {
  if (typeof url !== 'string' && !(url instanceof URL)) throw TypeError('Entry URL must be a string or URL');
  const value = String(url), hashAt = value.indexOf('#');
  const fragment = hashAt < 0 ? '' : value.slice(hashAt);
  const entry = hashAt < 0 ? value : value.slice(0, hashAt);
  const queryAt = entry.indexOf('?');
  const path = queryAt < 0 ? entry : entry.slice(0, queryAt);
  const query = queryAt < 0 ? '' : entry.slice(queryAt + 1);
  const fields = query ? query.split('&').filter(field => !new URLSearchParams(field).has(HUB_FRAME_PARAM)) : [];
  fields.push(HUB_FRAME_PARAM + '=1');
  return path + '?' + fields.join('&') + fragment;
}

export function isHubFrameRequest(req, url) {
  const headers = req?.headers;
  let present = false, destination;
  if (typeof headers?.has === 'function' && typeof headers?.get === 'function') {
    present = headers.has('sec-fetch-dest');
    destination = headers.get('sec-fetch-dest');
  } else if (headers) {
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'sec-fetch-dest');
    present = key !== undefined;
    if (present) destination = headers[key];
  }
  // A marker never overrides browser-provided document/empty/unknown metadata.
  if (present) return typeof destination === 'string' && destination.trim() === 'iframe';
  try {
    const target = url instanceof URL ? url : new URL(url ?? req?.url ?? '', 'http://mobile-entry.invalid');
    const markers = target.searchParams.getAll(HUB_FRAME_PARAM);
    return markers.length === 1 && markers[0] === '1';
  } catch { return false; }
}

export function hubEntryGuard(html, target = '/m/#') {
  if (typeof html !== 'string' || typeof target !== 'string') throw TypeError('HTML and target must be strings');
  const literal = JSON.stringify(target).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const guard = '<script data-hub-entry-guard>(()=>{if(window.top===window.self){document.documentElement.style.visibility="hidden";window.stop();window.location.replace(' + literal + ');}})();</script>';
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + guard + html.slice(at);
  }
  // Malformed/minimal documents still receive the guard before any app script.
  const opening = /<html(?:\s[^>]*)?>/i.exec(html);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = opening ? opening.index + opening[0].length : doctype ? doctype[0].length : 0;
  return html.slice(0, at) + '<head>' + guard + '</head>' + html.slice(at);
}

function publicHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  const address = host.replace(/^\[|\]$/g, '');
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(address) === 6) return !(address === '::' || address === '::1' || /^(?:f[cd]|fe[89ab]|ff|::ffff:)/i.test(address));
  return true;
}

// `request` is accepted for callers, but Host/Origin/forwarded headers never
// influence this target. This helper does not inspect or translate credentials.
export async function unifiedEntryTarget({request: _request, statePath = join(homedir(), 'Library/Application Support/CodexMobileCpolar/state.json')} = {}) {
  try {
    const raw = await readFile(statePath, 'utf8');
    if (raw.length > 100000) return FALLBACK;
    const origin = JSON.parse(raw)?.origin;
    if (typeof origin !== 'string' || /[\u0000-\u0020\u007f]/.test(origin)) return FALLBACK;
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || !publicHost(url.hostname)
      || url.pathname !== '/' || url.search || url.hash) return FALLBACK;
    return url.origin + '/m/#';
  } catch { return FALLBACK; }
}
