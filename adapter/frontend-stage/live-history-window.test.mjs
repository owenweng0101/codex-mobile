import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationReadServices } from './conversation-read.mjs';
import {Emitter} from '../vendor/rpc.mjs';
import { k as applyDeltas, w as frameSchema } from '../../vendor/zcode-web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js';

const sessionId = '00000000-0000-4000-8000-000000000085';
const params = { workspacePath: '/fixture/live-history', sessionId };
const ids = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

function fixture(t) {
  const native = new Emitter();
  const page = {
    thread: { id: sessionId, cwd: params.workspacePath, createdAt: 1 },
    turns: Array.from({ length: 42 }, (_, i) => ({
      id: `turn-${i}`, status: 'completed', items: [
        { id: `user-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${i}` }] },
        { id: `answer-${i}`, type: 'agentMessage', text: `Answer ${i}` },
      ],
    })),
    activeTurn: 'live-turn',
  };
  page.turns.push({ id: 'live-turn', status: 'inProgress', items: [
    { id: 'live-answer', type: 'agentMessage', text: 'Streaming' },
  ] });
  const service = createConversationReadServices({
    api: { get: async path => {
      assert.equal(path, `/api/history?threadId=${sessionId}`);
      return structuredClone(page);
    } },
    baseServices: {
      project: { readTree: async () => ({ projects: [], tasks: [
        { taskId: sessionId, workspacePath: params.workspacePath },
      ] }) },
      'zcode-task': { onDynamicTaskEvent: () => native.event },
    },
  });
  const agent = service.channels['zcode-agent'];
  const frames = []; let applied;
  const listener = agent.onDynamicConversationFrame(params)(frame => {frames.push(frame);applied=frame.frame.payload.kind==='snapshot'?frame.frame.payload.snapshot:{...applyDeltas(applied,frame.frame.payload.deltas),seq:frame.frame.toSeq};});
  t.after(() => { listener.dispose(); service.dispose(); native.dispose(); });
  async function stream(update) {
    // Allow the previous refresh's finally handler to clear its inflight guard.
    await new Promise(resolve => setImmediate(resolve));
    update(page.turns.at(-1));
    const frame = await new Promise((resolve, reject) => {
      const subscription = agent.onDynamicConversationFrame(params)(value => {
        clearTimeout(timer); subscription.dispose(); resolve(value);
      });
      const timer = setTimeout(() => {
        subscription.dispose(); reject(new Error('Native update did not publish a frame'));
      }, 2000);
      native.fire({ type: 'task_snapshot_updated' });
    });
    assert.ok(['online','recovery'].includes(frame.deliveryKind));
    assert.equal(frameSchema.safeParse(frame.frame).success, true);
    return applied;
  }
  return { agent, frames, stream };
}

test('85-row live history keeps loaded older rows across streaming, append and resync', async t => {
  const { agent, frames, stream } = fixture(t);
  const { ack } = await agent.subscribeConversationV4(params);
  const initial = frames[0].frame.payload.snapshot;
  assert.equal(frames[0].deliveryKind, 'initial');
  assert.equal(initial.rows.totalCount, 85);
  assert.deepEqual(initial.rows.window.map(row => row.rowId), ids(26, 85));

  const older = await agent.conversationRowsRangeV4({ ...params, beforeRowId: 26, limit: 60 });
  assert.deepEqual(older.rows.map(row => row.rowId), ids(1, 25));
  assert.equal(older.hasMore, false);
  const updated = await stream(turn => { turn.items[0].text += ' continues'; });
  assert.deepEqual(updated.rows.window.map(row => row.rowId), ids(1, 85));
  assert.deepEqual(updated.rows.window.slice(0, 25), older.rows);
  assert.equal(updated.rows.window.at(-1).text, 'Streaming continues');
  assert.equal(updated.logEpoch, initial.logEpoch);
  assert.ok(updated.seq > initial.seq);

  const appended = await stream(turn => {
    turn.items.push({ id: 'next-live-answer', type: 'agentMessage', text: 'Next update' });
  });
  assert.deepEqual(appended.rows.window.map(row => row.rowId), ids(1, 86));
  assert.equal(appended.rows.totalCount, 86);
  await agent.resyncConversationV4({ ...params, subscriptionId: ack.subscriptionId });
  assert.deepEqual(frames.at(-1).frame.payload.snapshot.rows.window.map(row => row.rowId), ids(1, 86));
});

test('partial paging retains its earliest boundary without loading unseen rows or moving it forward', async t => {
  const { agent, stream } = fixture(t);
  await agent.subscribeConversationV4(params);
  const unpaged = await stream(turn => { turn.items[0].text += ' first'; });
  assert.deepEqual(unpaged.rows.window.map(row => row.rowId), ids(26, 85));
  const older = await agent.conversationRowsRangeV4({ ...params, beforeRowId: 26, limit: 10 });
  assert.deepEqual(older.rows.map(row => row.rowId), ids(16, 25));
  assert.equal(older.hasMore, true);
  // An overlapping later request must not discard the earlier page.
  await agent.conversationRowsRangeV4({ ...params, beforeRowId: 60, limit: 5 });
  const updated = await stream(turn => { turn.items[0].text += ' second'; });
  assert.deepEqual(updated.rows.window.map(row => row.rowId), ids(16, 85));
  assert.equal(updated.rows.firstRowId, 1);
  assert.equal(updated.rows.totalCount, 85);
});
