import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {pinnedTest, hasPinnedFrontend} from './pinned-fixture.mjs';
import {createInitialReadableWindow, isInitialChatNodeReadable, isInitialPendingInputReadable, patchInitialReadableWindow} from '../backend/initial-readable-window.mjs';
import {patchChatReadiness} from '../backend/session-restore.mjs';

function fixture(options = {}) {
  const frames = new Map(); let serial = 0, calls = 0, changes = 0;
  const owner = createInitialReadableWindow({schedule(fn) {frames.set(++serial, fn); return serial;}, cancel: id => frames.delete(id), changed() {changes++;}});
  let input = {sessionId: 'A', openState: 'open', readable: false, hasMore: true, loadingOlder: false, firstSeq: 900,
    loadOlder: () => {calls++; return options.load?.(f) ?? Promise.resolve();}};
  const f = {owner, frames, get input() {return input;}, update(patch = {}) {input = {...input, ...patch}; owner.update(input);},
    get calls() {return calls;}, get changes() {return changes;}, get status() {return owner.status(input);},
    async frame() {const item = frames.entries().next().value; if (item) {frames.delete(item[0]); item[1]();} await new Promise(setImmediate);},
    async drain() {for (let count = 0; frames.size && count < 10; count++) await this.frame(); assert.equal(frames.size, 0, 'bounded scheduling');}};
  return f;
}

test('readable first twenty or a nonempty pending user bubble never prefetches older history', async () => {
  const f = fixture(); f.update({readable: true}); await f.drain();
  assert.equal(f.calls, 0); assert.equal(f.status.waiting, false); assert.equal(f.status.message, null);
  const settling = fixture(); settling.update(); assert.equal(settling.status.waiting, true);
  settling.update({readable: true}); await settling.drain(); assert.equal(settling.calls, 0, 'wait one frame for native node assembly before judging');
});

test('only unreadable initial windows fill and stop at the first readable result', async () => {
  const f = fixture({load(f) {f.update({firstSeq: 860, readable: true});}});
  f.update(); assert.equal(f.status.waiting, true); await f.drain();
  assert.equal(f.calls, 1); assert.equal(f.status.waiting, false); assert.equal(f.status.message, null);
  f.update({readable: false}); await f.drain(); assert.equal(f.calls, 1, 'not a perpetual auto-pager after initial completion');
});

test('automatic filling has two-page budget and exposes a bounded no-body state, not an infinite loader', async () => {
  const f = fixture({load(f) {f.update({firstSeq: f.input.firstSeq - 40});}});
  f.update(); await f.drain();
  assert.equal(f.calls, 2); assert.equal(f.owner.pages, 2); assert.equal(f.status.waiting, false);
  assert.equal(f.status.message, '这段暂无对话正文');
  f.update({firstSeq: 700}); await f.drain(); assert.equal(f.calls, 2);
});

test('native end, no progress, and rejected page settle without retry loops or hiding errors', async () => {
  const exhausted = fixture({load(f) {f.update({hasMore: false});}}); exhausted.update(); await exhausted.drain();
  assert.equal(exhausted.calls, 1); assert.equal(exhausted.status.message, null);
  const noProgress = fixture(); noProgress.update(); await noProgress.drain();
  assert.equal(noProgress.calls, 1); assert.match(noProgress.status.message, /重试/); assert.equal(noProgress.status.waiting, false);
  const failed = fixture({load() {return Promise.reject(Error('具体读取错误'));}}); failed.update(); await failed.drain();
  assert.equal(failed.calls, 1); assert.match(failed.status.message, /具体读取错误/); assert.equal(failed.status.waiting, false);
});

test('reader intent, session replacement and disposal cancel automatic continuation without cancelling shared native I/O', async () => {
  const untouched = fixture(); untouched.update(); untouched.owner.interrupt(); await untouched.drain(); assert.equal(untouched.calls, 0);
  let resolve;
  const f = fixture({load() {return new Promise(done => {resolve = done;});}});
  f.update(); await f.frame(); assert.equal(f.calls, 1); f.owner.interrupt(); resolve(); await f.drain();
  assert.equal(f.calls, 1); assert.equal(f.status.waiting, false);
  const replaced = fixture({load() {return new Promise(done => {resolve = done;});}});
  replaced.update(); await replaced.frame(); replaced.update({sessionId: 'B', readable: true}); const changes = replaced.changes;
  resolve(); await replaced.drain(); assert.equal(replaced.calls, 1); assert.equal(replaced.changes, changes);
  const disposed = fixture(); disposed.update(); disposed.owner.dispose(); await disposed.drain(); assert.equal(disposed.calls, 0);
  disposed.update({readable: true}); assert.equal(disposed.status.waiting, false, 'effect replay can reattach without stale callbacks');
});

test('same-session effect replay retains spent budget and reader intent', async () => {
  const f = fixture({load(f) {f.update({firstSeq: f.input.firstSeq - 40});}});
  f.update(); await f.frame(); assert.equal(f.calls, 1);
  f.owner.dispose(); f.update(); await f.drain(); assert.equal(f.calls, 2); assert.equal(f.owner.pages, 2);
  f.owner.dispose(); f.update(); await f.drain(); assert.equal(f.calls, 2, 'a completed budget never resets on replay');
  const reader = fixture(); reader.update(); reader.owner.interrupt(); reader.owner.dispose(); reader.update(); await reader.drain();
  assert.equal(reader.calls, 0); assert.equal(reader.status.waiting, false);
});

test('replay during a native page rejoins that request rather than issuing a duplicate', async () => {
  let resolve;
  const f = fixture({load(f) {if (f.calls === 1) return new Promise(done => {resolve = done;}); f.update({firstSeq: 820});}});
  f.update(); await f.frame(); assert.equal(f.calls, 1);
  f.owner.dispose(); f.update(); await f.drain(); assert.equal(f.calls, 1); assert.equal(f.owner.pages, 1);
  f.update({firstSeq: 860}); resolve({beforeSeq: 900, afterSeq: 860}); await new Promise(setImmediate); await f.drain();
  assert.equal(f.calls, 2); assert.equal(f.owner.pages, 2);
});

test('raw native cursor progress can advance through hidden rows without changing visible order', async () => {
  let cursor = 900;
  const f = fixture({load() {const beforeSeq = cursor; cursor -= 40; return Promise.resolve({beforeSeq, afterSeq: cursor});}});
  f.update({firstSeq: null}); await f.drain();
  assert.equal(f.calls, 2); assert.equal(f.status.message, '这段暂无对话正文');
});

test('a genuine native retry starts a new budget even if React batches away its loading render', async () => {
  for (const showLoading of [true, false]) {
    const f = fixture({load(f) {f.update({firstSeq: f.input.firstSeq - 40});}});
    f.update({openState: 'error'}); if (showLoading) f.update({openState: 'loading'});
    assert.equal(f.owner.status({...f.input, openState: 'open'}).waiting, true, 'the new open render is gated before its layout effect resets the epoch');
    f.update({openState: 'open'}); await f.drain();
    assert.equal(f.calls, 2); assert.equal(f.owner.pages, 2);
    f.update({openState: 'loading'}); f.update({openState: 'open'}); await f.drain();
    assert.equal(f.calls, 4); assert.equal(f.owner.pages, 2);
  }
});

test('a cold/error native state cannot trigger autofill', async () => {
  for (const openState of ['cold', 'loading', 'error']) {
    const f = fixture(); f.update({openState}); await f.drain(); assert.equal(f.calls, 0); assert.equal(f.status.waiting, false);
  }
});

const root = new URL('../frontend/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const entry = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&'));
const original = hasPinnedFrontend ? await readFile(new URL(entry[1].file, root), 'utf8') : '';
const region = (source, start) => {const at = source.indexOf(start); assert.ok(at >= 0); return source.slice(at, source.indexOf('\n\t\t//#endregion', at));};

pinnedTest('actual ChatReading restores valid anchors but follows latest when the old anchor left the small mobile window', () => {
  const patched = patchInitialReadableWindow(patchChatReadiness(original)); new Function(patched);
  for (const mobile of [true, false]) for (const valid of [true, false]) {
    const Reading = runInNewContext(region(patched, 'var ChatReading = class') + '\nChatReading', {globalThis: {matchMedia: () => ({matches: mobile})}});
    let restored = 0, followed = 0; const saved = [];
    const viewport = {latestTurn: 90, anchor: () => valid ? {} : null, restore() {restored++; return {position: {anchorKey: 'old'}, metrics: {top: 50, floor: 5000}};},
      scrollToBottom() {followed++; return {position: null, metrics: {top: 5000, floor: 5000}};}, capturePosition: () => null,
      readScroll: () => ({metrics: {top: 50, floor: 5000}}), readVisibleTurn: () => 2};
    const follow = {setFollowing() {}, nearBottom: metrics => metrics.floor - metrics.top < 25};
    const reading = new Reading(viewport, {read: () => ({anchorKey: 'old', scrollTop: 50}), save: value => saved.push(value)}, {followingTail: false, initialized: false, activeTurn: 2}, () => {}, follow);
    reading.restore();
    assert.equal(followed, mobile && !valid ? 1 : 0); assert.equal(restored, mobile && !valid ? 0 : 1);
    if (mobile && !valid) {assert.equal(reading.state.followingTail, true); assert.deepEqual(saved, [null]);}
  }
});

pinnedTest('actual running ChatView fills tool-only first twenty until a real user or assistant body arrives', async () => {
  const patched = patchInitialReadableWindow(patchChatReadiness(original));
  const visible = runInNewContext(region(original, 'function isVisibleChatNode(') + '\nisVisibleChatNode');
  const reply = runInNewContext(region(original, 'function hasAssistantReplyContent(') + '\nhasAssistantReplyContent');
  const partsStart = original.indexOf('function contentParts(');
  const contentParts = runInNewContext(original.slice(partsStart, original.indexOf('function retrySeconds(', partsStart)) + '\ncontentParts');
  const localStart = original.indexOf('function isLocalSubmission(');
  const isLocalSubmission = runInNewContext(original.slice(localStart, original.indexOf('function isTranscriptEcho(', localStart)) + '\nisLocalSubmission');
  function check({node, allNodes, running = false, pendingSubmissions = [], inbox}) {
    let input;
    const jsx = (type, props) => ({type, props});
    const component = runInNewContext(region(patched, 'function ChatView({') + '\nChatView', {
      react: {useCallback: fn => fn, useMemo: fn => fn(), useState: value => [value, () => {}], useEffect() {}, useRef: value => ({current: value})},
      react_jsx_runtime: {jsx, jsxs: jsx},
      useInitialReadableWindow: (_, next) => {input = next; return {waiting: false, message: null, interrupt() {}};},
      isInitialChatNodeReadable, isInitialPendingInputReadable, contentParts, isLocalSubmission, isVisibleChatNode: visible, hasAssistantReplyContent: reply,
      turnProcessAlwaysOpen() {}, turnProcessOpen() {}, isAtOrOutside() {}, mergeTurnRailItems: () => [],
      useChatScroll: () => ({initialized: true, followingTail: true, columnRef: {}, listRef: {}}),
      useTextInteraction: () => ({active: null}), TurnNavigator: 'TurnNavigator',
      observedInputs: () => ({rpcIds: new Set(), lastInputTurn: undefined}),
      ChatView_module_css_default: new Proxy({}, {get: (_, key) => String(key)}),
      _deepseek_ai_dsh_client_ui_primitives: {MarkdownDelegateProvider: 'MarkdownDelegateProvider'},
    });
    const list = allNodes ?? (node ? [node] : []), order = list.map((_, i) => 'n' + i);
    const nodes = new Map(list.map((value, i) => ['n' + i, {...value, anchorSeq: 80 + i}]));
    nodes.process = () => undefined;
    component({sessionId: 'A', useStore: fn => fn({turnProcesses: []}), useContextMenu: () => ({getTriggerProps() {}}),
      useChat: fn => fn({order, nodes, navigation: {items: () => []}}), useConversation: fn => fn({views: {grouped: () => undefined}}),
      usePresentation: fn => fn({collapseTiming: 'completion', mode: 'grouped'}), useProjection: name => name === 'inbox' ? inbox : undefined,
      useSessions: fn => fn({byId: {A: {cwd: '/fixture'}}}), useSession: fn => fn({running, pendingSubmissions, openState: 'open', openError: null, hasMore: true, loadingOlder: false}),
      useInteractionIds: fn => fn([]), renderSlot: () => [], t: key => key, loadOlder() {},
    });
    return input.readable;
  }
  const user = {kind: 'user', visibility: 'visible', data: {content: [{type: 'text', text: 'a real user question'}]}};
  const assistant = {kind: 'assistant-step', visibility: 'visible', data: {blocks: [{kind: 'text', text: 'a real reply'}]}};
  assert.equal(check({node: user}), true);
  assert.equal(check({node: {...user, visibility: 'hidden'}}), false);
  assert.equal(check({node: {...user, data: {content: []}}}), false);
  assert.equal(check({node: assistant}), true);
  const tools = Array.from({length: 20}, (_, i) => ({kind: 'assistant-step', visibility: 'visible', data: {blocks: [{kind: i % 2 ? 'tool-call' : 'reasoning', text: 'process only'}]}}));
  assert.equal(check({running: true}), false, 'running/status is not history body');
  assert.equal(check({running: true, allNodes: tools}), false, 'all twenty tool/thinking records remain unreadable');
  for (const body of [user, assistant]) {
    const f = fixture({load(f) {f.update({firstSeq: 860, readable: check({running: true, allNodes: [body, ...tools]})});}});
    f.update({readable: check({running: true, allNodes: tools})}); assert.equal(f.status.waiting, true);
    await f.drain(); assert.equal(f.calls, 1); assert.equal(f.status.waiting, false);
    const normal = fixture(); normal.update({readable: check({running: true, node: body})}); await normal.drain(); assert.equal(normal.calls, 0);
  }
  assert.equal(check({pendingSubmissions: [{requestId: 'p', placement: 'transcript', text: '', attachments: []}]}), false);
  assert.equal(check({pendingSubmissions: [{requestId: 'p', placement: 'transcript', text: '   ', attachments: []}]}), false);
  assert.equal(check({pendingSubmissions: [{requestId: 'p', placement: 'transcript', text: 'a pending user message', attachments: []}]}), true);
  assert.equal(check({pendingSubmissions: [{requestId: 'p', placement: 'transcript', text: '', attachments: [{type: 'image', value: {previewUrl: 'blob:fixture'}}]}]}), true);
  assert.equal(check({pendingSubmissions: [{requestId: 'p', placement: 'queued', text: 'not rendered in chat', attachments: []}]}), false);
  assert.equal(check({inbox: {'next-step': [{id: 'p', source: {kind: 'user'}, content: []}]}}), false);
  assert.equal(check({inbox: {'next-step': [{id: 'p', source: {kind: 'user'}, content: [{type: 'text', text: 'pending steer'}]}]}}), true);
});

pinnedTest('final-answer-only folds do not count hidden intermediate replies, while actual manual expansion is respected', () => {
  const native = {
    isVisibleChatNode: runInNewContext(region(original, 'function isVisibleChatNode(') + '\nisVisibleChatNode'),
    hasAssistantReplyContent: runInNewContext(region(original, 'function hasAssistantReplyContent(') + '\nhasAssistantReplyContent'),
    turnProcessAlwaysOpen: runInNewContext(region(original, 'function turnProcessAlwaysOpen(') + '\nturnProcessAlwaysOpen'),
    turnProcessOpen: runInNewContext(region(original, 'function storedTurnProcessEntry(') + '\nturnProcessOpen'),
    isAtOrOutside: runInNewContext(region(original, 'const DEPTH =') + '\nisAtOrOutside'),
  };
  const node = {kind: 'assistant-step', visibility: 'visible', groupTree: 'process', anchorSeq: 50,
    data: {step: 2, blocks: [{kind: 'text', text: 'intermediate reply'}]},
    location: {kind: 'step', turn: {turn: 1, status: 'closed', end: {data: {reason: {kind: 'completed'}}}}}};
  const spec = {turn: 1, processStartSeq: 10, answerAnchorSeq: 100, answerStep: 3};
  const nodes = {process: () => ({turn: 1, turnStarted: true, turnClosed: true, spec}), bottomSource: () => ({getSnapshot: () => true})};
  const policy = {foldCompletedTurns: true, foldedReplies: 'final'}, store = {turnProcesses: []};
  assert.equal(isInitialChatNodeReadable(node, 'n', nodes, policy, store, false, native), false);
  assert.equal(isInitialChatNodeReadable(node, 'n', nodes, {...policy, foldedReplies: 'all'}, store, false, native), true);
  assert.equal(isInitialChatNodeReadable(node, 'n', nodes, policy, {turnProcesses: [{turn: 1, answerStep: 3}]}, false, native), true);
  assert.equal(isInitialChatNodeReadable(node, 'n', nodes, policy, {turnProcesses: [{turn: 1, answerStep: 3, collapsed: true}]}, false, native), false);
  assert.equal(isInitialChatNodeReadable(node, 'n', nodes, policy, store, true, native), true);
  assert.equal(isInitialChatNodeReadable({...node, anchorSeq: 100, data: {...node.data, step: 3}}, 'n', nodes, policy, store, false, native), true);
});

pinnedTest('history loader wrapper reports raw before/after cursor without changing the native operation', async () => {
  const patched = patchInitialReadableWindow(patchChatReadiness(original));
  const start = patched.indexOf('loadOlder: () => {'), end = patched.indexOf('loadThrough:', start);
  let calls = 0; const session = {baseSeq: 900, async loadOlder() {calls++; this.baseSeq = 860;}};
  const load = runInNewContext('({' + patched.slice(start, end) + '}).loadOlder', {session});
  assert.deepEqual(JSON.parse(JSON.stringify(await load())), {beforeSeq: 900, afterSeq: 860}); assert.equal(calls, 1);
});

pinnedTest('readability uses actual native body content rather than running status, with local pager copy only', () => {
  const patched = patchInitialReadableWindow(patchChatReadiness(original));
  assert.match(patched, /isVisibleChatNode\(node\)/); assert.match(patched, /hasAssistantReplyContent\(node.data.blocks\)/);
  assert.doesNotMatch(patched, /readable: running|readable: pendingInputs.length > 0/);
  assert.match(patched, /readable: pendingInputs.some\(\(item\) => isInitialPendingInputReadable/);
  assert.match(patched, /mobileInitialWindow.waiting \? "loading" : openState/);
  assert.match(patched, /if \(event.movedByReader\) content.current.input.onInitialReadIntent\?\.\(\)/);
  assert.match(patched, /intent: \(\) => \{\s*content.current.input.onInitialReadIntent\?\.\(\)/);
  assert.match(patched, /return session.loadOlder\(\)/);
  assert.match(patched, /children: loadingOlder \? "加载中…" : "加载更多"/);
  assert.ok(patched.includes('children: t("chat.loadingHistory")'), 'global initial loading copy is untouched');
  assert.throws(() => patchInitialReadableWindow('unknown'), /review initial readable window/);
});
