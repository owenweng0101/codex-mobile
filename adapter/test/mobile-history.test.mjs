import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMobileHistory, resolveMobileImagePath,projectAssistantText } from '../mobile-history.mjs';
import { desktopHistory } from '../../backend/desktop-bridge.mjs';
import { displayTurn } from '../../backend/view.mjs';
import { rolloutItem } from '../../backend/core.mjs';

const threadId = '00000000-0000-0000-0000-000000000001', turnId = 'turn-1';
const native = (itemId, index = 1) => ({ type: 'image', status: 'candidate', reference: { threadId, turnId, itemId, index }, url: '/api/thread-media?' + new URLSearchParams({ threadId, turnId, itemId, index }) });

test('assistant local Markdown images use scoped HTTP previews without rewriting other reply content',()=>{
 const page=fixture(),item={id:'a-image',type:'agentMessage',text:'看图\n![月球](/work/moon.png)\n保留正文'};
 item.inlineImages=[{...native(item.id,0),start:3,end:item.text.indexOf('\n保留'),alt:'月球'}];page.turns[0].items.push(item);
 const message=projectMobileHistory(page).messages.find(m=>m.id===item.id),image=message.images[0];
 assert.equal(resolveMobileImagePath(page,new URL(image.url,'http://local').searchParams),item.inlineImages[0].url);
 assert.equal(projectAssistantText(item,message.images),'看图\n![月球]('+image.url+'&preview=1)\n保留正文');
});
function fixture() {
  return { thread: { id: threadId, name: 'Fixture', cwd: '/fixture', model: 'model', path: '/private/rollout.jsonl' }, settings: { model: 'model', effort: 'low' }, desktopConnected: true, nextCursor: 'rollout:older', activeTurn: null, turns: [{ id: turnId, items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '原文 ZCode\n第二行' }, native('u1')] },
    { id: 'c1', type: 'agentMessage', phase: 'commentary', text: 'internal progress' },
    { id: 't1', type: 'commandExecution', command: 'secret tool detail' },
    { id: 'a1', type: 'agentMessage', text: '答复 **保持原样**。' },
    { id: 'g1', type: 'imageGeneration', status: 'completed', media: native('g1', 0) },
  ] }] };
}

test('commentary remains ordinary conversation text and tool rows contain only a short label', () => {
  const output = projectMobileHistory(fixture());
  assert.deepEqual(output.messages.map(message => [message.id, message.role, message.kind, message.text]), [['u1', 'user', 'message', '原文 ZCode\n第二行'], ['c1', 'assistant', 'message', 'internal progress'], ['t1', 'assistant', 'tool', '执行命令'], ['a1', 'assistant', 'message', '答复 **保持原样**。'], ['g1', 'assistant', 'message', '']]);
  assert.doesNotMatch(JSON.stringify(output), /secret tool detail/);
  assert.equal(output.thread.path, undefined);
  assert.equal(output.nextCursor, 'rollout:older');
  assert.deepEqual(output.settings, { model: 'model', effort: 'low' });
  assert.equal(output.desktopConnected, true);
});

test('canonical backend turn -> displayTurn -> mobile retains running commentary, reasoning, and inline image scope', () => {
  const startedAt = 1792969200123;
  const text = '正在检查 **实际结果**。\n![图](/work/result.png)\n下一步继续核对。';
  const history = desktopHistory({ id: threadId, turnHistory: { kind: 'canonical', history: {
    islands: [{ entries: [{ key: 'live', value: 'live' }] }],
    entitiesByKey: { live: { turnId, status: 'inProgress', turnStartedAtMs: startedAt, items: [
      { id: 'live-comment', type: 'agentMessage', phase: 'commentary', text },
      { id: 'reason', type: 'reasoning', summary: ['检查输入', '核对输出'], content: ['private reasoning'] },
      { id: 'tool', type: 'commandExecution', status: 'inProgress', command: 'private command', aggregatedOutput: 'private log'.repeat(1000) },
    ] } },
  } } });
  const page = { ...history, desktopConnected: true, turns: history.turns.map(turn => displayTurn(turn, { threadId })), nextCursor: 'rollout:older' };
  assert.equal(page.turns[0].startedAt, startedAt / 1000);
  const cursor = 'rollout:1000+older/图';
  const output = projectMobileHistory(page, { cursor });
  assert.equal(output.activeTurn, turnId);
  assert.equal(output.activeTurnStartedAt, startedAt);
  assert.equal(output.nextCursor, 'rollout:older');
  const [commentary, reasoning, tool] = output.messages;
  assert.equal(commentary.text, text);
  assert.equal(commentary.kind, 'message');
  assert.equal(commentary.status, 'inProgress');
  assert.equal(commentary.createdAt, null, 'turn start must not be fabricated as item creation time');
  assert.equal(commentary.images.length, 1);
  const image = commentary.images[0], params = new URL(image.url, 'http://mobile.invalid').searchParams;
  assert.equal(params.get('cursor'), cursor);
  assert.equal(params.get('itemId'), commentary.id);
  assert.equal(resolveMobileImagePath(page, params), page.turns[0].items[0].inlineImages[0].url);
  assert.equal(projectAssistantText(commentary, commentary.images), text.replace('![图](/work/result.png)', '![图](' + image.url + '&preview=1)'));
  params.set('turnId', 'other-turn');
  assert.throws(() => resolveMobileImagePath(page, params), error => error.code === 'MOBILE_IMAGE_SCOPE');
  assert.equal(reasoning.kind, 'reasoning');
  assert.equal(reasoning.text, '检查输入\n核对输出');
  assert.equal(tool.kind, 'tool');
  assert.equal(tool.status, 'inProgress');
  assert.equal(tool.text, '执行命令');
  assert.doesNotMatch(JSON.stringify(output), /private reasoning|private command|private log/);
});

test('completed rollout commentary is preserved verbatim alongside the final answer', () => {
  const items = [
    { id: 'progress', type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: '实际运行正文\n继续处理' }] },
    { id: 'final', type: 'AgentMessage', phase: 'final_answer', content: '完成。' },
  ].map(rolloutItem);
  const page = { thread: { id: threadId }, turns: [displayTurn({ id: turnId, status: 'completed', items }, { threadId })] };
  const output = projectMobileHistory(page);
  assert.deepEqual(output.messages.map(({ kind, text, status }) => ({ kind, text, status })), [
    { kind: 'message', text: '实际运行正文\n继续处理', status: 'completed' },
    { kind: 'message', text: '完成。', status: 'completed' },
  ]);
});

test('active turn timer uses only the matching real start in seconds, milliseconds, or ISO form', () => {
  const page = fixture(), ms = 1792969200123;
  page.activeTurn = turnId;
  for (const startedAt of [ms / 1000, ms, new Date(ms).toISOString()]) {
    page.turns[0].startedAt = startedAt;
    assert.equal(projectMobileHistory(page).activeTurnStartedAt, ms);
  }
  page.thread.createdAt = ms / 1000;
  page.thread.updatedAt = ms / 1000;
  page.turns[0].completedAt = ms / 1000;
  page.turns[0].durationMs = 1000;
  for (const startedAt of [undefined, null, '', 'unknown', true, -1, Infinity, NaN, {}, 1e30]) {
    page.turns[0].startedAt = startedAt;
    assert.equal(projectMobileHistory(page).activeTurnStartedAt, null);
  }
  page.turns[0].startedAt = ms / 1000;
  page.activeTurn = 'newer-turn-not-on-this-page';
  assert.equal(projectMobileHistory(page).activeTurnStartedAt, null, 'older pages cannot borrow another turn start');
  page.activeTurn = null;
  assert.equal(projectMobileHistory(page).activeTurnStartedAt, null);
  page.turns[0].items[1].createdAt = ms / 1000;
  assert.equal(projectMobileHistory(page).messages.find(message => message.id === 'c1').createdAt, ms);
});

test('all backend tool types remain bounded labels and statuses without commands, diffs, arguments or logs', () => {
  const types = ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'contextCompaction'];
  const page = fixture();
  page.turns[0].items = types.map((type, index) => ({ id: 'tool-' + index, type, status: 'failed', command: 'secret', aggregatedOutput: 'secret'.repeat(10000), changes: [{ path: '/private/file', diff: 'secret' }], tool: 'secret', query: 'secret', arguments: { secret: true }, result: 'secret' }));
  const output = projectMobileHistory(page);
  assert.equal(output.messages.length, types.length);
  for (const message of output.messages) {
    assert.equal(message.kind, 'tool');
    assert.equal(message.status, 'failed');
    assert.ok(message.text.length < 20);
    assert.deepEqual(message.images, []);
  }
  assert.doesNotMatch(JSON.stringify(output), /secret|\/private/);
});

test('queue projection exposes only same-thread display and operation identifiers, not private execution fields', () => {
  const page = fixture(), createdAt = 1792969200123;
  page.queue = { threadId, paused: true, error: 'private diagnostic', items: [
    { id: 'request-1', requestId: 'request-1', text: '稍后发送', createdAt, status: 'uncertain', error: 'private stack', attachments: ['a'.repeat(48)], files: ['/private/file'], sandbox: 'private policy', approvalPolicy: 'private policy' },
  ] };
  const queue = projectMobileHistory(page).queue;
  assert.equal(queue.threadId, threadId);
  assert.equal(queue.paused, true);
  assert.ok(queue.error);
  assert.deepEqual(queue.items, [{ id: 'request-1', text: '稍后发送', createdAt, status: 'uncertain', error: '发送未完成，请核对后重试。', attachmentCount: 1, fileCount: 1 }]);
  assert.doesNotMatch(JSON.stringify(queue), /private|sandbox|approvalPolicy/);
  page.queue.threadId = 'foreign-thread';
  assert.equal(projectMobileHistory(page).queue, null);
  delete page.queue;
  assert.equal(projectMobileHistory(page).queue, null);
});

test('user and generated images retain exact native references through same-origin URLs', () => {
  const page = fixture(), output = projectMobileHistory(page);
  for (const message of output.messages.filter(message => message.images.length)) {
    const image = new URL(message.images[0].url, 'http://mobile.invalid');
    assert.equal(image.pathname, '/mobile/api/image');
    assert.equal(image.searchParams.get('threadId'), threadId);
    assert.equal(image.searchParams.get('itemId'), message.id);
    const backend = resolveMobileImagePath(page, image.searchParams);
    assert.ok(backend.startsWith('/api/thread-media?'));
    assert.equal([...new URL(backend, image).searchParams.keys()].length, 4);
  }
});

test('upload images remain viewable and are scoped to attachment references present in this history', () => {
  const page = fixture(), attachmentId = 'a'.repeat(48);
  page.turns[0].items[0].content.push({ type: 'attachment', kind: 'image', id: attachmentId, name: 'photo.png', url: '/api/attachment?id=' + attachmentId });
  const image = projectMobileHistory(page).messages[0].images[1];
  assert.equal(image.name, 'photo.png');
  assert.equal(resolveMobileImagePath(page, new URL(image.url, 'http://mobile.invalid').searchParams), '/api/attachment?id=' + attachmentId);
  assert.throws(() => resolveMobileImagePath(page, { threadId, attachmentId: 'b'.repeat(48) }), error => error.statusCode === 403);
});

test('older-page image URLs retain the history cursor but do not forward it to native image API', () => {
  const page = fixture(), cursor = 'rollout:1000';
  const image = projectMobileHistory(page, { cursor }).messages[0].images[0];
  const params = new URL(image.url, 'http://mobile.invalid').searchParams;
  assert.equal(params.get('cursor'), cursor);
  assert.ok(!resolveMobileImagePath(page, params).includes('cursor'));
});

test('foreign URLs, mismatched references and duplicate/extra query fields cannot escape the image proxy', () => {
  const page = fixture();
  page.turns[0].items[0].content.push({ type: 'image', url: 'https://external.example/secret.png' }, { type: 'image', url: 'data:image/png;base64,secret' }, { ...native('another-item'), reference: { ...native('u1').reference, threadId: 'other-thread' } });
  assert.equal(projectMobileHistory(page).messages[0].images.length, 1);
  const params = new URL(projectMobileHistory(page).messages[0].images[0].url, 'http://mobile.invalid').searchParams;
  params.append('threadId', threadId);
  assert.throws(() => resolveMobileImagePath(page, params), error => error.statusCode === 403);
  params.delete('threadId'); params.set('threadId', threadId); params.set('path', '/private/file.png');
  assert.throws(() => resolveMobileImagePath(page, params), error => error.statusCode === 403);
});
