import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {pinnedTest, hasPinnedFrontend} from './pinned-fixture.mjs';
import {buildMobileProfile} from '../backend/mobile-profile.mjs';
import {patchMobileHistoryWindow, MOBILE_INITIAL_HISTORY_MESSAGES, MOBILE_OLDER_HISTORY_MESSAGES} from '../backend/history-window.mjs';

const root = new URL('../frontend/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
async function sourceFor(id) {
  const entry = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/' + id + '/client.js&'));
  return readFile(new URL(entry[1].file, root), 'utf8');
}
const sessionSource = hasPinnedFrontend ? await sourceFor('dsh-api-session-controller') : '';
const gatewaySource = hasPinnedFrontend ? await sourceFor('dsh-api-gateway') : '';
function region(source, start) {
  const at = source.indexOf(start); assert.ok(at >= 0, start);
  return source.slice(at, source.indexOf('\n\t\t//#endregion', at));
}
function queue() {
  const values = [], waiting = []; let closed = false;
  return {push(value) {const next = waiting.shift(); if (next) next({value, done: false}); else values.push(value);},
    close() {closed = true; for (const next of waiting.splice(0)) next({done: true});},
    next() {return values.length ? Promise.resolve({value: values.shift(), done: false}) : closed ? Promise.resolve({done: true}) : new Promise(resolve => waiting.push(resolve));},
    [Symbol.asyncIterator]() {return this;}};
}
function logFixture(turns = 200, steps = 1) {
  const log = [], add = (type, data = {}) => log.push({type: 'event', event: {seq: log.length, time: 1, type, data, surfaceOp: 'append'}});
  for (let turn = 0; turn < turns; turn++) {
    add('turn/start', {turn}); add('user/message', {content: 'question'});
    for (let step = 0; step < steps; step++) {add('tool/result', {text: '中'.repeat(1024)}); add('assistant/message', {content: 'response'});}
    add('turn/end', {turn});
  }
  return log;
}
// The fake Host is a resident journal: select backwards at the requested cursor,
// count append messages, and return the untouched contiguous selected records.
function page(log, request) {
  const end = Math.min(request.throughSeq === undefined ? log.length : request.throughSeq + 1, request.beforeSeq ?? log.length);
  let count = 0, turns = 0, cut = 0, visited = 0;
  for (let index = end - 1; index >= 0; index--) {
    visited++; const event = log[index].event;
    if (request.turnWindow && event.type === 'turn/start' && ++turns >= request.turnWindow.minTurns && count >= request.turnWindow.minMessages) {cut = index; break;}
    if (!['user/message', 'assistant/message'].includes(event.type) || event.surfaceOp !== 'append') continue;
    if (++count >= request.maxMessages) {cut = Math.min(event.seq, ...(event.sourceEventSeqs || [event.seq])); break;}
  }
  return {cursor: request.throughSeq ?? log.length - 1, records: log.slice(cut, end), hasMore: cut > 0, visited};
}
function runtime(source, {address = {kind: 'session', sessionId: 'fixture'}, log = logFixture()} = {}) {
  const requests = [], changes = [], failed = [], metrics = [], pending = queue(), controller = new AbortController();
  const remote = {
    $stream(options) {return {signal: controller.signal,
      async *[Symbol.asyncIterator]() {for await (const value of options.open(controller.signal)) yield {value, generation: 1, signal: controller.signal, accept() {}};},
      dispose() {pending.close();}, restart() {throw Error('not used');}};},
    session: {
      async *follow(request) {requests.push({kind: 'follow', request}); const selected = page(log, request); metrics.push({visited: selected.visited});
        yield {type: 'snapshot', ...selected, projections: {asOfSeq: log.length - 1, values: {inbox: {approval: 'preserved'}}}, assistantStream: {revision: 0}};
        yield* pending;
      },
      async page(request) {requests.push({kind: 'page', request}); return {ok: true, value: page(log, request)};},
    },
  };
  const Journal = runInNewContext(region(gatewaySource, 'var RemoteJournalStream = class') + '\nRemoteJournalStream', {protocolViolation$1: message => Error(message), RemoteStreamCarrierError: Error});
  const Stream = runInNewContext(region(source, 'var SessionEventStream = class') + '\nSessionEventStream', {
    _deepseek_ai_dsh_api_gateway_client: {RemoteJournalStream: Journal, RemoteStreamCarrierError: Error}, RemoteError: Error,
    historyRecordFirstSeq: record => record.event.seq, historyRecordLastSeq: record => record.event.seq,
    assertSessionWireEvent() {}, toSessionJournalChange: change => change,
  });
  const Session = runInNewContext(region(source, 'const ' + (source.includes('const MOBILE_INITIAL_HISTORY_PAGE_OPTIONS') ? 'MOBILE_INITIAL_HISTORY_PAGE_OPTIONS' : 'HISTORY_PAGE_OPTIONS') + ' =') + '\nSession', {
    SessionEventStream: Stream, SessionSeq: value => value, SessionLogOffset: value => value,
    _deepseek_ai_dsh_api_gateway_client: {isRemoteFailure: () => false},
  });
  const session = Object.create(Session.prototype);
  Object.assign(session, {remote, sessionId: 'fixture', openState: 'cold', openPromise: null, openGeneration: 0, loadingOlder: false, baseSeq: 0, hasMore: false,
    notifier: {markDirty() {}}, sessionAddress: () => address,
    acceptEventChange(change) {changes.push(change); if (change.type === 'replace' || change.type === 'prepend') {this.baseSeq = change.entries[0]?.event.seq ?? 0; this.hasMore = change.hasMore;}},
    failEventStream(_, __, error) {failed.push(error);},
  });
  return {session, log, requests, changes, failed, metrics, push: frame => pending.push(frame), async stop() {await session.events?.dispose();}};
}

test('history patch requires exact native open and older-page boundaries', () => {
  assert.equal(MOBILE_INITIAL_HISTORY_MESSAGES, 20); assert.equal(MOBILE_OLDER_HISTORY_MESSAGES, 40);
  assert.throws(() => patchMobileHistoryWindow('unknown'), /review mobile paging/);
  assert.throws(() => patchMobileHistoryWindow('const HISTORY_PAGE_OPTIONS = {'.repeat(2)), /review mobile paging/);
});

pinnedTest('initial follow fetches twenty messages once, retaining cursor and complete projection metadata', async () => {
  const f = runtime(patchMobileHistoryWindow(sessionSource));
  try {
    await Promise.all([f.session.open(), f.session.open()]);
    assert.equal(f.requests.length, 1, 'open does not issue a second full-history read');
    assert.equal(f.requests[0].request.maxMessages, 20); assert.equal(f.requests[0].request.turnWindow, undefined);
    assert.equal(f.requests[0].request.activate, true); assert.equal(f.requests[0].request.assistantStream, true);
    assert.equal(f.session.openState, 'open'); assert.equal(f.session.hasMore, true);
    const initial = f.changes[0];
    assert.equal(initial.entries.filter(r => ['user/message', 'assistant/message'].includes(r.event.type)).length, 20);
    assert.equal(f.session.events.currentCursor(), f.log.length - 1); assert.equal(initial.entries.at(-1), f.log.at(-1));
    assert.equal(initial.page.projections.values.inbox.approval, 'preserved');
    assert.equal(initial.page.assistantStream.revision, 0);
  } finally {await f.stop();}
});

pinnedTest('older pages use forty messages with the native exclusive cursor and no missing or duplicated events', async () => {
  const f = runtime(patchMobileHistoryWindow(sessionSource), {log: logFixture(35)});
  try {
    await f.session.open(); const selected = [...f.changes[0].entries];
    while (f.session.hasMore) {
      const before = f.session.baseSeq, calls = f.requests.length;
      await Promise.all([f.session.loadOlder(), f.session.loadOlder()]);
      assert.equal(f.requests.length, calls + 1, 'one in-flight older page per session');
      const request = f.requests.at(-1).request, change = f.changes.at(-1);
      assert.equal(request.maxMessages, 40); assert.equal(request.turnWindow, undefined);
      assert.equal(request.beforeSeq, before); assert.equal(request.throughSeq, f.log.length - 1);
      assert.equal(change.entries.at(-1).event.seq, before - 1);
      selected.unshift(...change.entries);
    }
    assert.deepEqual(selected.map(r => r.event.seq), f.log.map(r => r.event.seq));
    const count = f.requests.length; await f.session.loadOlder(); assert.equal(f.requests.length, count);
  } finally {await f.stop();}
});

pinnedTest('small first window preserves source groups, subagent address, live appends and gap-repair limits', async () => {
  const log = logFixture(30), sourceCut = page(log, {maxMessages: 20}).records[0].event.seq;
  log[sourceCut].event.sourceEventSeqs = [sourceCut - 3];
  const address = {kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable'};
  const f = runtime(patchMobileHistoryWindow(sessionSource), {log, address});
  try {
    await f.session.open(); assert.equal(f.session.baseSeq, sourceCut - 3);
    assert.equal(f.requests[0].request.address, address);
    assert.deepEqual(JSON.parse(JSON.stringify(f.session.events.repairPageRequest())), {maxMessages: 20});
    const entry = {type: 'event', event: {seq: log.length, type: 'assistant/message', time: 1, data: {text: 'live'}, surfaceOp: 'append'}};
    const observed = new Promise(resolve => {const previous = f.session.acceptEventChange; f.session.acceptEventChange = function(change) {previous.call(this, change); if (change.type === 'append') resolve(change);};});
    f.push(entry); const change = await observed; assert.equal(change.entry, entry);
    assert.equal(f.requests.length, 1, 'contiguous live events do not refetch old history');
    assert.equal(f.failed.length, 0);
  } finally {await f.stop();}
});

pinnedTest('native request budget reduces returned records and serialized bytes before React receives them', async () => {
  const old = runtime(sessionSource), small = runtime(patchMobileHistoryWindow(sessionSource));
  try {
    await old.session.open(); await small.session.open();
    const before = old.changes[0].page, after = small.changes[0].page;
    assert.equal(before.records.filter(r => ['user/message', 'assistant/message'].includes(r.event.type)).length, 50);
    assert.equal(after.records.filter(r => ['user/message', 'assistant/message'].includes(r.event.type)).length, 20);
    assert.ok(after.records.length < before.records.length * 0.41);
    assert.ok(Buffer.byteLength(JSON.stringify(after)) < Buffer.byteLength(JSON.stringify(before)) * 0.42);
    assert.ok(small.metrics[0].visited < old.metrics[0].visited * 0.41, 'resident selection scans a smaller tail, not every fixture record');
  } finally {await Promise.all([old.stop(), small.stop()]);}
});

pinnedTest('a long tool-heavy turn no longer expands first paint to two entire turns', async () => {
  const log = logFixture(4, 240), old = runtime(sessionSource, {log}), small = runtime(patchMobileHistoryWindow(sessionSource), {log});
  try {
    await old.session.open(); await small.session.open();
    const before = old.changes[0].entries, after = small.changes[0].entries;
    assert.equal(before.filter(r => ['user/message', 'assistant/message'].includes(r.event.type)).length, 482);
    assert.equal(after.filter(r => ['user/message', 'assistant/message'].includes(r.event.type)).length, 20);
    assert.equal(after.at(-1), log.at(-1)); assert.equal(small.session.hasMore, true);
    assert.ok(Buffer.byteLength(JSON.stringify(after)) < Buffer.byteLength(JSON.stringify(before)) * 0.05);
  } finally {await Promise.all([old.stop(), small.stop()]);}
});

pinnedTest('serve-time profile applies small history requests without editing pinned resources or explicit turn jumps', async () => {
  const patched = patchMobileHistoryWindow(sessionSource); new Function(patched);
  assert.ok(patched.includes('minMessages: 200'));
  assert.ok(patched.includes('...JUMP_PAGE_OPTIONS'));
  const html = await readFile(new URL('index.html', root), 'utf8');
  const profile = await buildMobileProfile(fileURLToPath(root), html, manifest);
  const boot = JSON.parse(profile.html.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
  const entry = boot.entries.find(e => e.id === '@deepseek-ai/dsh-api-session-controller');
  assert.equal(profile.bodies.get('/' + entry.url).toString(), patched);
  assert.equal(await sourceFor('dsh-api-session-controller'), sessionSource);
});
