import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { writeFile, readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createImagePreviewer } from '../mobile-image.mjs';
const execute = promisify(execFile);

function chunk(type, data) {
  const name = Buffer.from(type), content = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of content) { crc ^= byte; for (let index = 0; index < 8; index++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, content, tail]);
}
function png(width = 800, height = 480, alpha = false) {
  const channels = alpha ? 4 : 3, row = width * channels, pixels = randomBytes((row + 1) * height), header = Buffer.alloc(13);
  for (let y = 0; y < height; y++) pixels[y * (row + 1)] = 0;
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const opaque = png(), transparent = png(800, 480, true);

async function dimensions(result) {
  const folder = await mkdtemp(join(tmpdir(), 'codex-preview-test-'));
  try {
    const path = join(folder, 'image'); await writeFile(path, result.bytes, { mode: 0o600 });
    return (await execute('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', path])).stdout;
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test('real opaque PNG becomes a smaller 640px JPEG while transparent PNG preserves alpha', { skip: process.platform !== 'darwin' }, async () => {
  const preview = createImagePreviewer();
  const jpg = await preview(opaque, 'image/png');
  assert.equal(jpg.contentType, 'image/jpeg'); assert.ok(jpg.bytes.length < opaque.length);
  assert.match(await dimensions(jpg), /pixelWidth:\s*640/);
  const alpha = await preview(transparent, 'image/png');
  assert.equal(alpha.contentType, 'image/png'); assert.ok(alpha.bytes.length < transparent.length);
  const metadata = await dimensions(alpha);
  assert.match(metadata, /pixelWidth:\s*640/); assert.match(metadata, /hasAlpha:\s*yes/);
});

test('small, oversize, invalid, mislabeled and animated GIF input returns original without spawning', async () => {
  let calls = 0; const preview = createImagePreviewer({ run: async () => { calls++; throw Error('should not run'); } });
  const cases = [[png(16, 16), 'image/png'], [Buffer.alloc(20 * 1024 * 1024 + 1), 'image/png'], [Buffer.alloc(200000), 'image/png'], [opaque, 'image/jpeg'], [Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200000)]), 'image/gif']];
  for (const [bytes, contentType] of cases) assert.equal((await preview(bytes, contentType)).bytes, bytes);
  assert.equal(calls, 0);
});

test('cache deduplicates same-image work, stays within LRU byte budget and leaves private temporary files clean', async () => {
  let calls = 0; const folders = new Set(), tiny = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(100)]);
  const preview = createImagePreviewer({ maxCacheBytes: tiny.length + 1, run: async (_binary, args) => {
    calls++; const path = args.at(-1), folder = dirname(path); folders.add(folder);
    assert.equal((await stat(folder)).mode & 0o777, 0o700); assert.equal((await stat(path)).mode & 0o777, 0o600);
    if (args.includes('--out')) { await writeFile(path, tiny); return { stdout: '' }; }
    return { stdout: 'pixelWidth: 800\npixelHeight: 480\nhasAlpha: no' };
  } });
  const [first, same] = await Promise.all([preview(opaque, 'image/png'), preview(opaque, 'image/png')]);
  assert.equal(first.bytes.length, tiny.length); assert.equal(same.bytes.length, tiny.length); assert.equal(calls, 2);
  await preview(opaque, 'image/png'); assert.equal(calls, 2);
  await preview(transparent, 'image/png'); assert.equal(calls, 4);
  assert.ok(preview.cacheInfo().bytes <= tiny.length + 1);
  await preview(opaque, 'image/png'); assert.equal(calls, 6);
  for (const path of folders) await assert.rejects(stat(path), error => error.code === 'ENOENT');
});

test('tool errors and timeout return original and remove their private temporary directory', async () => {
  for (const fail of ['error', 'timeout']) {
    let folder;
    const preview = createImagePreviewer({ timeoutMs: 30, run: async (_binary, args, options) => {
      folder = dirname(args.at(-1));
      if (fail === 'error') throw Error('unavailable');
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
    assert.equal((await preview(opaque, 'image/png')).bytes, opaque);
    await assert.rejects(stat(folder), error => error.code === 'ENOENT');
  }
});
