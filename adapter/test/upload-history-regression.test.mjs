import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentStore } from '../../backend/attachments.mjs';
import { displayTurn } from '../../backend/view.mjs';
import { projectMobileHistory, resolveMobileImagePath } from '../mobile-history.mjs';
import { createConversationReadServices, projectConversationV4 } from '../frontend-stage/conversation-read.mjs';

// Reuse the PNG bytes from backend/test/history-media-real.test.mjs and the
// /private/runtime/uploads/<48 hex>.png fixture from backend/test/view.test.mjs.
// Do not import those test modules: they register tests with filesystem effects.
// No upload(), server, credentials file, real history or message send is used.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xQAAAAASUVORK5CYII=', 'base64');
const attachmentId = 'a'.repeat(48);
const threadId = '11111111-1111-4111-8111-111111111111';
const otherThreadId = '44444444-4444-4444-8444-444444444444';
const workspacePath = '/actual';
const params = { workspacePath, sessionId: threadId };
const cursor = 'rollout:1000+older/图';
const uploadPath = '/private/runtime/uploads/' + attachmentId + '.png';
const backendPath = '/api/attachment?id=' + attachmentId;

async function fixture({ alias = 'localImage', text = '看图\n保留原文' } = {}) {
  const stored = { id: attachmentId, name: '图片.png', mime: 'image/png', size: png.length, extension: 'png', kind: 'image', path: uploadPath };
  const store = new AttachmentStore({ directory: '/private/runtime/uploads' });
  // Stub only disk resolution; exercise production upload-result and send-input
  // projections, preserving the real localImage shape consumed by /api/message.
  store.resolve = async id => { assert.equal(id, attachmentId); return { ...stored }; };
  const uploaded = store.public(stored);
  const input = await store.inputs([uploaded.id]);
  assert.deepEqual(input, [{ type: 'localImage', path: uploadPath }]);
  const raw = { id: 'turn-one', status: 'completed', items: [{ id: 'user-one', type: 'userMessage', content: [
    ...(text ? [{ type: 'text', text }] : []), ...input.map(image => ({ ...image, type: alias })),
  ] }] };
  const page = { thread: { id: threadId, cwd: workspacePath }, turns: [displayTurn(raw, { threadId })] };
  return { uploaded, input, page, text };
}

function harness(t, page, { older = false } = {}) {
  const gets = [], fetches = [];
  const api = {
    origin: 'http://fixture.invalid', bearer: 'fixture-only',
    async credentials() { assert.fail('fixture must not request real credentials'); },
    async get(path) {
      gets.push(path);
      const latest = '/api/history?threadId=' + threadId;
      if (path === latest) return structuredClone(older ? { ...page, turns: [], nextCursor: cursor } : page);
      if (older && path === latest + '&cursor=' + encodeURIComponent(cursor)) return structuredClone(page);
      assert.fail('unexpected history read: ' + path);
    },
    async fetch(url, init) {
      fetches.push(url);
      assert.equal(url, 'http://fixture.invalid' + backendPath);
      assert.equal(init.headers.authorization, 'Bearer fixture-only');
      assert.equal(init.redirect, 'error');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  };
  const services = createConversationReadServices({ api, baseServices: {
    project: { async readTree() { return { projects: [], tasks: [{ taskId: threadId, workspacePath }] }; } },
    'zcode-task': { onDynamicTaskEvent: () => () => ({ dispose() {} }) },
  } });
  t.after(() => services.dispose());
  return { agent: services.channels['zcode-agent'], gets, fetches };
}

async function snapshot(t, agent) {
  const frames = [];
  const listener = agent.onDynamicConversationFrame(params)(frame => frames.push(frame));
  t.after(() => listener.dispose());
  await agent.subscribeConversationV4(params);
  assert.equal(frames.length, 1);
  return frames[0].frame.payload.snapshot;
}

async function readChunks(agent, ref) {
  const chunks = [];
  let offset = 0;
  for (let guard = 0; guard < 32; guard++) {
    const chunk = await agent.attachmentReadV4({ ...params, ref, offset, limit: 7 });
    assert.equal(chunk.totalBytes, png.length);
    assert.equal(chunk.mediaType, 'image/png');
    const bytes = Buffer.from(chunk.dataBase64, 'base64');
    assert.equal(bytes.length, Math.min(7, png.length - offset));
    chunks.push(bytes);
    offset += bytes.length;
    assert.equal(chunk.nextOffset, offset < png.length ? offset : null);
    if (chunk.nextOffset === null) {
      assert.deepEqual(Buffer.concat(chunks), png);
      return;
    }
  }
  assert.fail('attachment chunk reader did not terminate');
}

for (const alias of ['localImage', 'local_image']) {
  test('upload send input -> history -> V4 retains ' + alias + ' image without placeholder or private path', async () => {
    const { uploaded, page, text } = await fixture({ alias });
    assert.equal(uploaded.url, backendPath);
    assert.equal(uploaded.path, undefined);
    assert.deepEqual(page.turns[0].items[0].content.at(-1), { type: 'image', url: backendPath });
    assert.deepEqual(displayTurn(page.turns[0], { threadId }), page.turns[0]);
    const mobile = projectMobileHistory(page), row = projectConversationV4(page).rows.window[0];
    assert.equal(row.text, text);
    assert.equal(row.attachments.length, 1);
    assert.equal(row.attachments[0].ref, mobile.messages[0].images[0].url);
    const query = new URL(row.attachments[0].ref, 'http://fixture.invalid').searchParams;
    assert.deepEqual([...query.keys()].sort(), ['attachmentId', 'threadId']);
    assert.equal(query.get('attachmentId'), uploaded.id);
    assert.equal(resolveMobileImagePath(page, query), backendPath);
    assert.doesNotMatch(JSON.stringify({ uploaded, page, mobile, row }), /\/private\/|data:image|\[图片\]/);
  });
}

for (const older of [false, true]) {
  test('V4 reads uploaded image bytes from ' + (older ? 'its cursor-addressed history page' : 'the current history page'), async t => {
    const { page } = await fixture({ text: '' });
    const { agent, gets, fetches } = harness(t, page, { older });
    const value = await snapshot(t, agent), row = value.rows.window[0];
    assert.equal(row.kind, 'userInput');
    assert.equal(row.text, '');
    assert.equal(row.attachments.length, 1);
    const ref = row.attachments[0].ref;
    assert.equal(new URL(ref, 'http://fixture.invalid').searchParams.get('cursor'), older ? cursor : null);
    await readChunks(agent, ref);
    assert.equal(fetches.length, 1, 'all chunks should reuse the same fetched bytes');
    assert.equal(gets.at(-1), '/api/history?threadId=' + threadId + (older ? '&cursor=' + encodeURIComponent(cursor) : ''));
    const end = await agent.attachmentReadV4({ ...params, ref, offset: png.length, limit: 7 });
    assert.equal(end.dataBase64, '');
    assert.equal(end.nextOffset, null);
  });
}

test('upload refs absent from the selected history page cannot fetch bytes', async t => {
  const { page } = await fixture();
  const { agent, fetches } = harness(t, page);
  const query = new URLSearchParams({ threadId, attachmentId: 'b'.repeat(48) });
  assert.throws(() => resolveMobileImagePath(page, query), error => error.code === 'MOBILE_IMAGE_SCOPE');
  await assert.rejects(agent.attachmentReadV4({ ...params, ref: '/mobile/api/image?' + query, offset: 0, limit: 7 }),
    error => error.code === 'MOBILE_IMAGE_SCOPE');
  assert.equal(fetches.length, 0);
});

test('upload ref must match session and workspace even after the bytes are cached', async t => {
  const { page } = await fixture();
  const { agent, fetches } = harness(t, page);
  const ref = projectConversationV4(page).rows.window[0].attachments[0].ref;
  await readChunks(agent, ref);
  await assert.rejects(agent.attachmentReadV4({ ...params, sessionId: otherThreadId, ref, offset: 0, limit: 7 }),
    error => error.code === 'CODEX_ATTACHMENT_SCOPE');
  await assert.rejects(agent.attachmentReadV4({ ...params, workspacePath: '/unrelated', ref, offset: 0, limit: 7 }),
    error => error.code === 'CODEX_READ_ONLY_METHOD_UNAVAILABLE');
  assert.equal(fetches.length, 1);
});

test('malformed upload refs cannot mix reference modes or forward arbitrary query fields', async t => {
  const { page } = await fixture();
  const { agent, gets, fetches } = harness(t, page);
  const ref = projectConversationV4(page).rows.window[0].attachments[0].ref;
  for (const bad of [
    ref + '&attachmentId=' + attachmentId,
    ref + '&threadId=' + threadId,
    ref + '&turnId=turn-one&itemId=user-one&index=1',
    ref + '&path=/private/file.png',
    ref + '&cursor=one&cursor=two',
    ref + '#fragment',
    'https://external.invalid' + ref,
    backendPath,
  ]) {
    await assert.rejects(agent.attachmentReadV4({ ...params, ref: bad, offset: 0, limit: 7 }),
      error => ['CODEX_READ_ONLY_METHOD_UNAVAILABLE', 'MOBILE_IMAGE_SCOPE'].includes(error.code), bad);
  }
  assert.equal(fetches.length, 0);
  assert.equal(gets.length, 0);
});
