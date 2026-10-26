const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function goalProjection(goal, threadId) {
  if (goal == null) return null;
  if (goal.threadId !== threadId || typeof goal.objective !== 'string' || !statuses.has(goal.status)) throw new Error('本机目标状态无法核对，请刷新重试');
  return { threadId, objective: goal.objective, status: goal.status, tokensUsed: count(goal.tokensUsed), tokenBudget: count(goal.tokenBudget), timeUsedSeconds: count(goal.timeUsedSeconds), createdAt: count(goal.createdAt), updatedAt: count(goal.updatedAt) };
}

// This reader does not change the goal or interpret stopping a turn as pausing
// it. Native lifecycle mutations require a separate explicit user action.
export class GoalReader {
  constructor({ core, ttlMs = 1000, now = Date.now } = {}) { this.core = core; this.ttlMs = ttlMs; this.now = now; this.cache = new Map(); this.pending = new Map(); }
  async read(threadId, { fresh = false } = {}) {
    if (typeof threadId !== 'string' || !UUID.test(threadId)) throw Object.assign(new Error('请选择明确的会话'), { statusCode: 400 });
    const cached = this.cache.get(threadId);
    if (!fresh && cached && this.now() - cached.time < this.ttlMs) return structuredClone(cached.value);
    if (!this.pending.has(threadId)) {
      const request = this.core.call('thread/goal/get', { threadId }, 5000).then(response => {
        if (!response || !Object.hasOwn(response, 'goal')) throw new Error('本机未返回目标状态，请刷新重试');
        const value = { threadId, goal: goalProjection(response.goal, threadId) };
        this.cache.delete(threadId); this.cache.set(threadId, { time: this.now(), value });
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
        return value;
      }).finally(() => this.pending.delete(threadId));
      this.pending.set(threadId, request);
    }
    return structuredClone(await this.pending.get(threadId));
  }
}
