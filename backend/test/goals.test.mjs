import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalReader } from '../goals.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const fixture = () => ({ threadId: id, objective: '完成长期任务', status: 'active', tokensUsed: 1234, tokenBudget: null, timeUsedSeconds: 90, createdAt: 100, updatedAt: 200, secret: 'never-return' });
test('goal reads deduplicate and refresh real state without exposing extra fields', async () => {
  let release, calls = 0, time = 0;
  const core = { call(method, params) { calls++; assert.equal(method, 'thread/goal/get'); assert.deepEqual(params, { threadId: id }); return new Promise(resolve => release = resolve); } };
  const reader = new GoalReader({ core, now: () => time });
  const a = reader.read(id), b = reader.read(id); assert.equal(calls, 1); release({ goal: fixture() });
  const [first, second] = await Promise.all([a, b]); assert.equal(JSON.stringify(first).includes('never-return'), false);
  first.goal.status = 'paused'; assert.equal(second.goal.status, 'active'); assert.equal((await reader.read(id)).goal.status, 'active');
  time = 1001; const next = reader.read(id); release({ goal: { ...fixture(), status: 'paused' } }); assert.equal((await next).goal.status, 'paused'); assert.equal(calls, 2);
});
test('missing goals are explicit; errors do not fabricate a state or poison recovery', async () => {
  let mode = 'error'; const core = { async call() { if (mode === 'error') throw new Error('offline'); if (mode === 'missing') return {}; return { goal: null }; } };
  const reader = new GoalReader({ core }); await assert.rejects(reader.read(id), /offline/); mode = 'missing'; await assert.rejects(reader.read(id), /未返回目标状态/);
  mode = 'null'; assert.deepEqual(await reader.read(id), { threadId: id, goal: null });
});
test('goal identity, lifecycle and usage are checked without making mutations', async () => {
  let goal = { ...fixture(), threadId: 'another' }, calls = 0;
  const reader = new GoalReader({ core: { async call(method) { calls++; assert.equal(method, 'thread/goal/get'); return { goal }; } } });
  await assert.rejects(reader.read('../invalid'), /明确的会话/); assert.equal(calls, 0);
  await assert.rejects(reader.read(id), /无法核对/); goal = { ...fixture(), status: 'made-up' }; await assert.rejects(reader.read(id), /无法核对/);
  goal = { ...fixture(), tokensUsed: -1, timeUsedSeconds: Infinity }; const read = await reader.read(id); assert.equal(read.goal.tokensUsed, null); assert.equal(read.goal.timeUsedSeconds, null);
});
