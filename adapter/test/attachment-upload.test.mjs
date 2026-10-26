import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAttachmentUploadServices, attachmentRefToUploadId} from '../attachment-upload.mjs';

const ID = 'a'.repeat(48);
const REF = '/api/attachment?id=' + ID;
const CHUNK = 384 * 1024;
const TTL = 5 * 60 * 1000;
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const image = size => {
  const bytes = Buffer.alloc(size, 42);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return bytes;
};
function harness(t, {post, scope = () => {}} = {}) {
  const calls = [], scopes = [];
  const methods = createAttachmentUploadServices({api: {async post(path, body) {
    calls.push({path, body});
    if (post) return post(path, body);
    return {id: ID, name: body.name, mime: 'image/png', size: Buffer.from(body.dataUrl.split(',')[1], 'base64').length, url: REF};
  }}, scope: async (p, sessionId) => {scopes.push({p, sessionId}); return scope(p, sessionId);}});
  t.after(() => methods.dispose());
  return {methods, calls, scopes};
}
function fixture(bytes = image(CHUNK + 17), overrides = {}) {
  const identity = {workspacePath: '/workspace/a', sessionId: 'draft-session', uploadId: 'upload-1', ...overrides};
  const begin = {...identity, fileName: 'example.png', mime: 'image/png', totalBytes: bytes.length,
    totalChunks: Math.ceil(bytes.length / CHUNK), checksum: digest(bytes)};
  const chunks = Array.from({length: begin.totalChunks}, (_, chunkIndex) => ({...identity, chunkIndex,
    dataBase64: bytes.subarray(chunkIndex * CHUNK, (chunkIndex + 1) * CHUNK).toString('base64')}));
  return {identity, begin, chunks, bytes};
}
async function stage(methods, f) {
  await methods.attachmentBeginV4(f.begin);
  for (const chunk of f.chunks) await methods.attachmentChunkV4(chunk);
}
const code = expected => error => error.code === expected;

test('original 384 KiB protocol, canonical native ref, and idempotent Begin/Commit', async t => {
  const {methods, calls, scopes} = harness(t), f = fixture();
  assert.deepEqual(Object.keys(methods), ['attachmentBeginV4', 'attachmentChunkV4', 'attachmentCommitV4', 'attachmentAbortV4']);
  assert.deepEqual(await methods.attachmentBeginV4(f.begin), {uploadId: 'upload-1', state: 'staging', nextChunkIndex: 0});
  for (const chunk of f.chunks) assert.deepEqual(await methods.attachmentChunkV4(chunk), {uploadId: 'upload-1', nextChunkIndex: chunk.chunkIndex + 1});
  assert.deepEqual(await methods.attachmentCommitV4(f.identity), {ref: REF});
  assert.deepEqual(await methods.attachmentBeginV4(f.begin), {uploadId: 'upload-1', state: 'committed', nextChunkIndex: 2, ref: REF});
  assert.deepEqual(await methods.attachmentCommitV4(f.identity), {ref: REF});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/upload');
  assert.match(calls[0].body.requestId, /^[A-Za-z0-9_-]{8,160}$/);
  assert.equal(calls[0].body.name, f.begin.fileName);
  assert.deepEqual(Buffer.from(calls[0].body.dataUrl.split(',')[1], 'base64'), f.bytes);
  assert.equal(scopes.length, 6);
  assert.ok(scopes.every(({p, sessionId}) => p.workspacePath === '/workspace/a' && sessionId === 'draft-session'));
});

test('out of order chunks and exact retries advance only the contiguous prefix', async t => {
  const {methods} = harness(t), f = fixture(image(CHUNK * 2 + 1));
  await methods.attachmentBeginV4(f.begin);
  assert.equal((await methods.attachmentChunkV4(f.chunks[2])).nextChunkIndex, 0);
  assert.equal((await methods.attachmentChunkV4(f.chunks[0])).nextChunkIndex, 1);
  assert.equal((await methods.attachmentChunkV4(f.chunks[0])).nextChunkIndex, 1);
  await assert.rejects(methods.attachmentChunkV4({...f.chunks[0], dataBase64: Buffer.alloc(CHUNK).toString('base64')}), code('CODEX_ATTACHMENT_CONFLICT'));
  await assert.rejects(methods.attachmentCommitV4(f.identity), code('CODEX_ATTACHMENT_INCOMPLETE'));
  assert.equal((await methods.attachmentBeginV4(f.begin)).nextChunkIndex, 1);
  assert.equal((await methods.attachmentChunkV4(f.chunks[1])).nextChunkIndex, 3);
  assert.deepEqual(await methods.attachmentCommitV4(f.identity), {ref: REF});
});

test('metadata collision and checksum mismatch never POST; checksum failure releases the slot', async t => {
  const {methods, calls} = harness(t), f = fixture(image(20));
  await methods.attachmentBeginV4(f.begin);
  await assert.rejects(methods.attachmentBeginV4({...f.begin, fileName: 'changed.png'}), code('CODEX_ATTACHMENT_CONFLICT'));
  await methods.attachmentChunkV4({...f.chunks[0], dataBase64: image(20).fill(0).toString('base64')});
  await assert.rejects(methods.attachmentCommitV4(f.identity), code('CODEX_ATTACHMENT_CHECKSUM'));
  assert.equal(calls.length, 0);
  assert.equal((await methods.attachmentBeginV4(f.begin)).nextChunkIndex, 0);
});

test('8 MiB inclusive limit and bounded metadata/base64/chunk input', async t => {
  const {methods} = harness(t), f = fixture(image(8 * 1024 * 1024));
  await stage(methods, f);
  assert.deepEqual(await methods.attachmentCommitV4(f.identity), {ref: REF});
  for (const invalid of [
    {totalBytes: 8 * 1024 * 1024 + 1}, {totalBytes: 0, totalChunks: 0}, {totalChunks: 65},
    {totalBytes: 2, totalChunks: 3}, {totalBytes: 512 * 1024 + 1, totalChunks: 1},
    {mime: 'image/svg+xml'}, {mime: 'text/plain'}, {fileName: '\0bad'}, {checksum: '0'.repeat(64)},
  ]) await assert.rejects(methods.attachmentBeginV4({...f.begin, uploadId: 'invalid', ...invalid}), code('CODEX_ATTACHMENT_INVALID_INPUT'));
  const small = fixture(image(10), {uploadId: 'small'});
  await methods.attachmentBeginV4(small.begin);
  for (const dataBase64 of ['', '====', 'YQ=', 'YQ==\n', 'YR==', '****', Buffer.alloc(512 * 1024 + 1).toString('base64'), image(11).toString('base64')]) {
    await assert.rejects(methods.attachmentChunkV4({...small.chunks[0], dataBase64}), code('CODEX_ATTACHMENT_INVALID_INPUT'));
  }
  for (const chunkIndex of [-1, 0.5, 1, NaN]) await assert.rejects(methods.attachmentChunkV4({...small.chunks[0], chunkIndex}), code('CODEX_ATTACHMENT_INVALID_INPUT'));
});

test('workspace and session isolation; authorization is rechecked on every operation', async t => {
  let authorized = true;
  const {methods, calls} = harness(t, {scope: () => authorized}), f = fixture(image(20));
  await stage(methods, f);
  for (const override of [{workspacePath: '/workspace/b'}, {sessionId: 'other-session'}]) {
    await assert.rejects(methods.attachmentCommitV4({...f.identity, ...override}), code('CODEX_ATTACHMENT_NOT_FOUND'));
    await methods.attachmentAbortV4({...f.identity, ...override});
    const other = fixture(f.bytes, override);
    await stage(methods, other);
    await methods.attachmentCommitV4(other.identity);
  }
  await methods.attachmentCommitV4(f.identity);
  assert.equal(new Set(calls.map(call => call.body.requestId)).size, 3);
  authorized = false;
  for (const [method, params] of [['attachmentBeginV4', f.begin], ['attachmentChunkV4', f.chunks[0]], ['attachmentCommitV4', f.identity], ['attachmentAbortV4', f.identity]]) {
    await assert.rejects(methods[method](params), code('CODEX_ATTACHMENT_SCOPE'));
  }
  for (const override of [{workspaceIdentity: 'remote'}, {remoteSessionId: 'remote'}, {workspacePath: ''}, {uploadId: '../escape'}]) {
    await assert.rejects(methods.attachmentBeginV4({...f.begin, ...override}), code('CODEX_ATTACHMENT_SCOPE'));
  }
});

test('parallel Commit calls share one native request; transport retries reuse requestId', async t => {
  let resolvePost, attempts = 0;
  const {methods, calls} = harness(t, {post: async () => {
    attempts++;
    if (attempts === 1) return new Promise(resolve => {resolvePost = resolve;});
    if (attempts === 2) throw Error('connection lost');
    return {id: ID, name: 'example.png', mime: 'image/png', size: 20, url: REF};
  }});
  const f = fixture(image(20));
  await stage(methods, f);
  const pending = [methods.attachmentCommitV4(f.identity), methods.attachmentCommitV4(f.identity)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  resolvePost({id: ID, name: 'example.png', mime: 'image/png', size: 20, url: REF});
  assert.deepEqual(await Promise.all(pending), [{ref: REF}, {ref: REF}]);
  const retry = fixture(image(20), {uploadId: 'retry'});
  await stage(methods, retry);
  await assert.rejects(methods.attachmentCommitV4(retry.identity), /connection lost/);
  assert.deepEqual(await methods.attachmentCommitV4(retry.identity), {ref: REF});
  assert.equal(calls[1].body.requestId, calls[2].body.requestId);
});

test('abort is idempotent, cancels in-flight commit, and never resurrects an upload', async t => {
  let resolvePost;
  const {methods} = harness(t, {post: () => new Promise(resolve => {resolvePost = resolve;})}), f = fixture(image(20));
  await stage(methods, f);
  const pending = methods.attachmentCommitV4(f.identity);
  const rejected = assert.rejects(pending, code('CODEX_ATTACHMENT_ABORTED'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await methods.attachmentAbortV4(f.identity), {});
  assert.deepEqual(await methods.attachmentAbortV4(f.identity), {});
  await rejected;
  resolvePost({id: ID, name: 'example.png', mime: 'image/png', size: 20, url: REF});
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(methods.attachmentCommitV4(f.identity), code('CODEX_ATTACHMENT_NOT_FOUND'));
  assert.equal((await methods.attachmentBeginV4(f.begin)).nextChunkIndex, 0);
});

test('four active transactions globally; abort and idle expiry reclaim capacity', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {methods} = harness(t);
  const fixtures = Array.from({length: 5}, (_, i) => fixture(image(20), {workspacePath: '/w/' + i}));
  await Promise.all(fixtures.slice(0, 4).map(f => methods.attachmentBeginV4(f.begin)));
  await assert.rejects(methods.attachmentBeginV4(fixtures[4].begin), code('CODEX_ATTACHMENT_BUSY'));
  await methods.attachmentAbortV4(fixtures[0].identity);
  await methods.attachmentBeginV4(fixtures[4].begin);
  t.mock.timers.tick(TTL - 1);
  await methods.attachmentChunkV4(fixtures[1].chunks[0]);
  t.mock.timers.tick(1);
  await assert.rejects(methods.attachmentCommitV4(fixtures[4].identity), code('CODEX_ATTACHMENT_NOT_FOUND'));
  assert.deepEqual(await methods.attachmentCommitV4(fixtures[1].identity), {ref: REF});
  await methods.attachmentBeginV4(fixtures[4].begin);
  t.mock.timers.tick(TTL);
  await assert.rejects(methods.attachmentCommitV4(fixtures[1].identity), code('CODEX_ATTACHMENT_NOT_FOUND'));
});

test('commit timeout rejects the caller even when native POST stalls', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {methods} = harness(t, {post: () => new Promise(() => {})}), f = fixture(image(20));
  await stage(methods, f);
  const pending = methods.attachmentCommitV4(f.identity);
  const rejected = assert.rejects(pending, code('CODEX_ATTACHMENT_EXPIRED'));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(TTL);
  await rejected;
  await assert.rejects(methods.attachmentCommitV4(f.identity), code('CODEX_ATTACHMENT_NOT_FOUND'));
});

test('ref parser rejects alternate URLs, paths, encodings and duplicate query fields', () => {
  assert.equal(attachmentRefToUploadId(REF), ID);
  for (const ref of [undefined, null, ID, 'https://host' + REF, '/mobile' + REF, REF + '&id=' + ID,
    REF + '#fragment', REF + '&meta=1', REF + '\n', REF + '\r\n', REF.replace('a', 'A'), '/api/attachment?id=' + '%61'.repeat(48), '/api/attachment?id=../secret']) {
    assert.throws(() => attachmentRefToUploadId(ref), code('CODEX_ATTACHMENT_INVALID_REF'));
  }
});

test('invalid backend receipt cannot become a committed ref', async t => {
  for (const invalid of [{url: 'https://evil.test/image'}, {id: 'b'.repeat(48)}, {mime: 'text/plain'}, {size: 21}, {name: null}]) {
    const {methods} = harness(t, {post: () => ({id: ID, name: 'example.png', mime: 'image/png', size: 20, url: REF, ...invalid})});
    const f = fixture(image(20));
    await stage(methods, f);
    await assert.rejects(methods.attachmentCommitV4(f.identity));
    assert.equal((await methods.attachmentBeginV4(f.begin)).state, 'staging');
  }
});

test('dispose clears state and cannot become an RPC method through object spread', async t => {
  const {methods} = harness(t), f = fixture();
  await stage(methods, f);
  assert.equal({...methods}.dispose, undefined);
  methods.dispose();
  methods.dispose();
  await assert.rejects(methods.attachmentBeginV4(f.begin), code('CODEX_ATTACHMENT_DISPOSED'));
  assert.throws(() => createAttachmentUploadServices({api: {post() {}}}), TypeError);
});

test('aborting stalled native requests cannot bypass the native concurrency limit', async t => {
  const {methods, calls} = harness(t, {post: () => new Promise(() => {})});
  for (let i = 0; i < 4; i++) {
    const f = fixture(image(20), {uploadId: 'stalled-' + i});
    await stage(methods, f);
    const pending = methods.attachmentCommitV4(f.identity);
    const rejected = assert.rejects(pending, code('CODEX_ATTACHMENT_ABORTED'));
    await new Promise(resolve => setImmediate(resolve));
    await methods.attachmentAbortV4(f.identity);
    await rejected;
  }
  await assert.rejects(methods.attachmentBeginV4(fixture().begin), code('CODEX_ATTACHMENT_BUSY'));
  assert.equal(calls.length, 4);
});

test('requestId is stable across service recreation and changes with file metadata', async t => {
  const f = fixture(image(20));
  const first = harness(t), second = harness(t);
  await stage(first.methods, f);
  await first.methods.attachmentCommitV4(f.identity);
  first.methods.dispose();
  await stage(second.methods, f);
  await second.methods.attachmentCommitV4(f.identity);
  assert.equal(first.calls[0].body.requestId, second.calls[0].body.requestId);
  const third = harness(t);
  await stage(third.methods, {...f, begin: {...f.begin, fileName: 'other.png'}});
  await third.methods.attachmentCommitV4(f.identity);
  assert.notEqual(second.calls[0].body.requestId, third.calls[0].body.requestId);
});

test('completed receipts remain bounded and abort preserves a committed receipt', async t => {
  const {methods} = harness(t);
  for (let i = 0; i < 129; i++) {
    const f = fixture(image(20), {uploadId: 'receipt-' + i});
    await stage(methods, f);
    await methods.attachmentCommitV4(f.identity);
  }
  await assert.rejects(methods.attachmentCommitV4(fixture(image(20), {uploadId: 'receipt-0'}).identity), code('CODEX_ATTACHMENT_NOT_FOUND'));
  const latest = fixture(image(20), {uploadId: 'receipt-128'});
  await methods.attachmentAbortV4(latest.identity);
  assert.deepEqual(await methods.attachmentCommitV4(latest.identity), {ref: REF});
});

test('writer resolver authorizes committed refs by workspace across draft/native sessions', async t => {
  let authorized = true;
  const {methods, scopes} = harness(t, {scope: () => authorized});
  const f = fixture(image(20));
  const native = {workspacePath: f.identity.workspacePath, sessionId: '11111111-1111-4111-8111-111111111111', ref: REF};
  assert.equal(Object.hasOwn(methods, 'resolveAttachment'), true);
  assert.equal({...methods}.resolveAttachment, undefined);
  const resolve = methods.resolveAttachment; // Parent passes this unbound callback to writer.
  await assert.rejects(resolve(native), code('CODEX_ATTACHMENT_NOT_FOUND'));
  await stage(methods, f);
  await assert.rejects(resolve(native), code('CODEX_ATTACHMENT_NOT_FOUND'));
  await methods.attachmentCommitV4(f.identity);
  assert.deepEqual(await resolve(native), {id: ID});
  assert.deepEqual(await resolve({...native, sessionId: 'draft-session'}), {id: ID});
  assert.ok(scopes.some(({p, sessionId}) => p.ref === REF && sessionId === native.sessionId));
  await assert.rejects(resolve({...native, workspacePath: '/workspace/b'}), code('CODEX_ATTACHMENT_NOT_FOUND'));
  await assert.rejects(resolve({...native, ref: '/api/attachment?id=' + 'b'.repeat(48)}), code('CODEX_ATTACHMENT_NOT_FOUND'));
  await assert.rejects(resolve({...native, ref: 'https://host' + REF}), code('CODEX_ATTACHMENT_INVALID_REF'));
  await assert.rejects(resolve({...native, workspaceIdentity: 'remote'}), code('CODEX_ATTACHMENT_SCOPE'));
  authorized = false;
  await assert.rejects(resolve(native), code('CODEX_ATTACHMENT_SCOPE'));
});

test('writer resolver rejects expired, aborted, restarted and disposed ownership records', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const first = harness(t), f = fixture(image(20));
  const params = {workspacePath: f.identity.workspacePath, sessionId: 'new-native-session', ref: REF};
  await stage(first.methods, f);
  await first.methods.attachmentAbortV4(f.identity);
  await assert.rejects(first.methods.resolveAttachment(params), code('CODEX_ATTACHMENT_NOT_FOUND'));
  await stage(first.methods, f);
  await first.methods.attachmentCommitV4(f.identity);
  assert.deepEqual(await first.methods.resolveAttachment(params), {id: ID});
  const restarted = harness(t);
  await assert.rejects(restarted.methods.resolveAttachment(params), error => error.code === 'CODEX_ATTACHMENT_NOT_FOUND' && /重新上传/.test(error.message));
  t.mock.timers.tick(TTL);
  await assert.rejects(first.methods.resolveAttachment(params), error => error.code === 'CODEX_ATTACHMENT_NOT_FOUND' && /重新上传/.test(error.message));
  first.methods.dispose();
  await assert.rejects(first.methods.resolveAttachment(params), code('CODEX_ATTACHMENT_DISPOSED'));
});
