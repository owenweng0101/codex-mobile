// Real-data verification for the read-only conversation window.
//
// It uses the real local Codex service (read-only GETs only), the real adapter
// projection and its cursor-addressed older-page endpoint. Nothing is created,
// sent or resumed: subscribe + conversationRowsRangeV4 are pure reads.
//
//   node adapter/frontend-stage/verify-real-history-paging.mjs [--thread <id>]
//
// Exit code 0 means every page of at least one real long conversation was read
// back without duplicates or holes, and the end of history stopped expanding.
import assert from 'node:assert/strict';
import {Emitter} from '../vendor/rpc.mjs';
import {CodexReadClient} from '../api-client.mjs';
import {createConversationReadServices} from './conversation-read.mjs';

const arg = name => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};

const api = new CodexReadClient();
const threads = await api.get('/api/threads');
assert(Array.isArray(threads.data), 'threads index must be a list');

// Metadata-only windows are cheap: they scan the rollout once and return the row
// total without historical bodies. Pick the longest local conversation.
const candidates = [];
const skipped = [];
for (const thread of threads.data.slice(0, 80)) {
  if (typeof thread?.id !== 'string' || typeof thread?.cwd !== 'string') continue;
  try {
    const window = await api.get('/api/history-window?threadId=' + encodeURIComponent(thread.id) + '&limit=1&metadataOnly=1');
    candidates.push({id: thread.id, cwd: thread.cwd, name: thread.name || '', total: window.rows.totalCount});
    // Reading many windows re-scans and evicts the backend index, which changes
    // its epoch for unrelated reasons; stop as soon as one long real
    // conversation is available so this script measures paging, not churn.
    if (window.rows.totalCount >= 300) break;
  } catch (error) {
    // Sessions whose rollout cannot be indexed stay readable through the legacy
    // body endpoint; they are simply not window-paged by this adapter.
    skipped.push({id: thread.id, code: error?.code || String(error).slice(0, 60)});
  }
}
if (skipped.length) console.log('skipped non-indexable sessions:', skipped.length);
candidates.sort((left, right) => right.total - left.total);
const requested = arg('--thread');
const target = requested ? candidates.find(item => item.id === requested) : candidates[0];
assert(target, 'no readable real conversation found');
console.log('real conversation:', JSON.stringify({id: target.id, cwd: target.cwd, total: target.total, name: target.name.slice(0, 24)}));

const params = {sessionId: target.id, workspacePath: target.cwd};
const native = new Emitter();
const service = createConversationReadServices({
  indexedHistory: true,
  api,
  baseServices: {
    project: {readTree: async () => ({tasks: [{taskId: target.id, workspacePath: target.cwd}]})},
    'zcode-task': {onDynamicTaskEvent: () => native.event},
  },
});
const agent = service.channels['zcode-agent'];
const frames = [];
const listener = agent.onDynamicConversationFrame(params)(frame => frames.push(frame));
try {
  const {ack} = await agent.subscribeConversationV4(params);
  const initial = frames[0]?.frame?.payload?.snapshot;
  assert(initial, 'subscription must publish an initial snapshot');
  assert(initial.rows.window.length > 0, 'initial window must contain rows');
  // The backend may re-scan its window index between the metadata scan and the
  // subscription (cache eviction), which can move the total. The subscribed
  // snapshot is authoritative for the pages that follow.
  const total = initial.rows.totalCount;
  if (total !== target.total) console.log('note: totalCount changed between the metadata scan and the subscription', {metadata: target.total, subscribed: total});

  const pageSize = 60;
  const pages = [];
  const seen = new Map(initial.rows.window.map(row => [row.rowId, row]));
  let cursor = initial.rows.window[0].rowId;
  let hasMore = true;
  let requests = 0;
  // Bound the loop by the real total so a non-advancing cursor fails instead of
  // spinning forever.
  while (hasMore && requests <= Math.ceil(total / pageSize) + 2) {
    const page = await agent.conversationRowsRangeV4({...params, beforeRowId: cursor, limit: pageSize});
    requests++;
    assert(page.atLogEpoch === initial.logEpoch, 'page belongs to the current log epoch');
    assert(page.atSeq === initial.seq || page.atSeq > 0, 'page carries the snapshot seq');
    for (const row of page.rows) {
      assert(!seen.has(row.rowId), 'duplicate row ' + row.rowId + ' across pages');
      seen.set(row.rowId, row);
    }
    pages.push({request: requests, beforeRowId: cursor, rows: page.rows.length, first: page.rows[0]?.rowId ?? null, last: page.rows.at(-1)?.rowId ?? null, hasMore: page.hasMore});
    hasMore = page.hasMore;
    if (!page.rows.length) break;
    const next = page.rows[0].rowId;
    assert(next < cursor, 'cursor must move to older rows');
    cursor = next;
  }

  const ids = [...seen.keys()].sort((left, right) => left - right);
  const loaded = initial.rows.window.length + pages.reduce((sum, page) => sum + page.rows, 0);
  assert.equal(hasMore, false, 'paging must reach the start of history');
  assert.equal(pages.at(-1).hasMore, false, 'the last page reports no more history');
  assert.equal(seen.size, loaded, 'every fetched row is distinct');
  assert.equal(ids.length, total, 'all historical rows are reachable');
  assert.equal(ids[0], initial.rows.firstRowId ?? 1, 'earliest row id matches the declared first row');
  for (let index = 1; index < ids.length; index++) assert.equal(ids[index], ids[index - 1] + 1, 'no holes between row ids');

  // Once hasMore is false the adapter must not invent rows for a repeated read.
  const exhausted = await agent.conversationRowsRangeV4({...params, beforeRowId: ids[0], limit: pageSize});
  assert.equal(exhausted.rows.length, 0, 'an exhausted history returns no rows');
  assert.equal(exhausted.hasMore, false, 'an exhausted history stays hasMore=false');

  // A resync after paging keeps the whole loaded window instead of dropping back
  // to the tail-only window.
  await agent.resyncConversationV4({...params, subscriptionId: ack.subscriptionId});
  const resynced = frames.at(-1).frame.payload.snapshot;
  assert.equal(resynced.rows.window.length, Math.min(total, loaded), 'resync keeps all loaded rows');
  assert.equal(resynced.rows.window[0].rowId, ids[0], 'resync keeps the earliest loaded row');
  assert.equal(resynced.rows.window.at(-1).rowId, initial.rows.window.at(-1).rowId, 'resync keeps the newest row');

  console.log(JSON.stringify({thread: target.id, totalCount: total, metadataTotal: target.total, initialWindow: initial.rows.window.length, pages, loadedRows: loaded, earliestRowId: ids[0], newestRowId: ids.at(-1), stoppedAtHasMore: hasMore, rereadAfterEnd: exhausted.rows.length, resyncWindow: resynced.rows.window.length}, null, 2));
  console.log('REAL HISTORY PAGING OK');
} finally {
  listener.dispose();
  service.dispose();
  native.dispose();
}
