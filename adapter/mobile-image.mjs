import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execute = promisify(execFile), MiB = 1024 * 1024;
const temporaryDirectories = new Set();
process.once('exit', () => {
  for (const path of temporaryDirectories) try { rmSync(path, { recursive: true, force: true }); } catch {}
});

function formatOf(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function animated(bytes, format) {
  if (format === 'gif') return true;
  if (format === 'webp') return bytes.includes(Buffer.from('ANIM'));
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
      if (length > bytes.length - offset - 12) break;
      offset += length + 12;
    }
  }
  return false;
}

/** The injectable runner and smaller budgets are only for isolated tests. */
export function createImagePreviewer({ run = execute, maxCacheBytes = 64 * MiB, timeoutMs = 5000, maxConcurrent = 2 } = {}) {
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0 || maxCacheBytes > 64 * MiB) throw Error('Preview cache exceeds its memory budget');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error('Preview timeout exceeds its budget');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw Error('Preview concurrency exceeds its budget');
  const cache = new Map(), inflight = new Map(), waiting = [];
  let cachedBytes = 0, active = 0, waitingBytes = 0;
  function releaseSlot() {
    active--;
    while (active < maxConcurrent && waiting.length) {
      const entry = waiting.shift(); clearTimeout(entry.timer); waitingBytes -= entry.bytes;
      if (entry.deadline <= Date.now()) { entry.resolve(null); continue; }
      active++; entry.resolve(releaseSlot);
    }
  }
  function acquireSlot(deadline, bytes) {
    if (deadline <= Date.now()) return Promise.resolve(null);
    if (active < maxConcurrent) { active++; return Promise.resolve(releaseSlot); }
    // Briefly queue normal multi-image pages instead of immediately forwarding
    // their largest originals. Waiting shares the same total conversion budget.
    if (waiting.length >= 4 || waitingBytes + bytes > 40 * MiB) return Promise.resolve(null);
    return new Promise(resolve => {
      const entry = { deadline, bytes, resolve }; waiting.push(entry); waitingBytes += bytes;
      entry.timer = setTimeout(() => {
        const index = waiting.indexOf(entry); if (index < 0) return;
        waiting.splice(index, 1); waitingBytes -= bytes; resolve(null);
      }, Math.max(1, deadline - Date.now()));
    });
  }
  function remember(key, value) {
    const cost = value?.bytes.length || 0;
    if (cost > maxCacheBytes) return;
    cache.set(key, { value, cost }); cachedBytes += cost;
    while (cachedBytes > maxCacheBytes || cache.size > 256) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).cost; cache.delete(oldest);
    }
  }
  async function resize(bytes, format, deadline) {
    let directory;
    const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const call = args => run('/usr/bin/sips', args, { timeout: Math.max(1, deadline - Date.now()), signal, killSignal: 'SIGKILL', maxBuffer: 16384, encoding: 'utf8' });
    try {
      directory = await mkdtemp(join(tmpdir(), 'codex-mobile-image-'));
      temporaryDirectories.add(directory); await chmod(directory, 0o700);
      const input = join(directory, 'input.' + format);
      await writeFile(input, bytes, { mode: 0o600, flag: 'wx' });
      const metadata = await call(['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', input]);
      const width = Number(/pixelWidth:\s*(\d+)/.exec(metadata.stdout)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(metadata.stdout)?.[1]);
      if (!(width > 0 && height > 0) || width * height > 64 * 1000 * 1000) return null;
      const transparent = /hasAlpha:\s*no\b/.test(metadata.stdout) ? false : true;
      const target = transparent ? 'png' : 'jpeg', output = join(directory, 'preview.' + target);
      await writeFile(output, Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
      await call(['-s', 'format', target, ...(target === 'jpeg' ? ['-s', 'formatOptions', '80'] : []), '-Z', String(Math.min(640, Math.max(width, height))), input, '--out', output]);
      await chmod(output, 0o600);
      const preview = await readFile(output);
      if (!preview.length || preview.length >= bytes.length || preview.length > 20 * MiB || formatOf(preview) !== target) return null;
      return { bytes: preview, contentType: 'image/' + target };
    } catch {
      return null;
    } finally {
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
          temporaryDirectories.delete(directory);
        } catch {}
      }
    }
  }
  const preview = async (input, contentType) => {
    const original = { bytes: input, contentType };
    if (!(Buffer.isBuffer(input) || input instanceof Uint8Array) || input.byteLength <= 128 * 1024 || input.byteLength > 20 * MiB) return original;
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const format = formatOf(bytes), mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!format || mime !== 'image/' + format || animated(bytes, format)) return original;
    const key = format + ':' + createHash('sha256').update(bytes).digest('hex');
    if (cache.has(key)) { const entry = cache.get(key); cache.delete(key); cache.set(key, entry); return entry.value || original; }
    if (inflight.has(key)) return (await inflight.get(key)) || original;
    const deadline = Date.now() + timeoutMs;
    const operation = (async () => {
      const release = await acquireSlot(deadline, bytes.length);
      if (!release) return null;
      try { return await resize(bytes, format, deadline); } finally { release(); }
    })().then(result => { if (result) remember(key, result); return result; }).finally(() => inflight.delete(key));
    inflight.set(key, operation);
    return (await operation) || original;
  };
  preview.cacheInfo = () => ({ entries: cache.size, bytes: cachedBytes, inflight: inflight.size, maxBytes: maxCacheBytes, active, queued: waiting.length });
  preview.clearCache = () => { cache.clear(); cachedBytes = 0; };
  return preview;
}

export const createImagePreview = createImagePreviewer();
