import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {pinnedTest} from './pinned-fixture.mjs';
import {installDshDraftNavigationGuard, patchWorkspaceDraftNavigation} from '../backend/draft-navigation.mjs';
import {injectMobileShell} from '../backend/mobile.mjs';

function ui() {
  let safe = false, mobile = true, timer;
  const nodes = [], view = {clearTimeout() {}, setTimeout(fn) {timer = fn; return 1;}};
  const document = {querySelector: () => safe ? null : {}, body: {appendChild(node) {node.isConnected = true; nodes.push(node);}},
    createElement() {return {attrs: {}, setAttribute(name, value) {this.attrs[name] = value;}, remove() {this.isConnected = false;}};}};
  const stop = installDshDraftNavigationGuard({document, view, isMobile: () => mobile, isSafe: () => safe});
  return {view, document, nodes, stop, setSafe(value) {safe = value;}, setMobile(value) {mobile = value;}, timeout() {timer?.();}};
}

test('navigation warning is non-modal, reusable, and does not install broad click or keyboard listeners', () => {
  const f = ui(), allow = f.view.__dshMobileAllowNavigation;
  assert.equal(allow('A', 'B'), false); assert.match(f.nodes[0].textContent, /先发送或移除附件/);
  assert.equal(allow('A', 'C'), false); assert.equal(f.nodes.length, 1); assert.equal(f.nodes[0].attrs.role, 'status');
  assert.equal(allow('A', 'A'), true, 'returning to the current session keeps its draft');
  assert.equal(allow('A', {sessionId: 'A'}), false, 'do not equate unknown address objects with the active id');
  f.setSafe(true); assert.equal(allow('A', 'B'), true, 'plain text or removed attachments permit navigation');
  f.setSafe(false); f.setMobile(false); assert.equal(allow('A', 'B'), true);
  f.timeout(); assert.equal(f.nodes[0].isConnected, false); f.stop(); assert.equal(f.view.__dshMobileAllowNavigation, undefined);
  assert.doesNotMatch(installDshDraftNavigationGuard.toString(), /addEventListener|preventDefault|stopPropagation/);
  const html = injectMobileShell('<html><head></head><body></body></html>');
  assert.match(html, /\[data-dshm-draft-warning\][\s\S]*?pointer-events: none/);
});

test('navigation patch rejects unknown or ambiguous pinned methods', () => {
  assert.throws(() => patchWorkspaceDraftNavigation('unknown'), /review draft navigation/);
  assert.throws(() => patchWorkspaceDraftNavigation('openSession(target) {'.repeat(2)), /review draft navigation/);
});

async function workspaceSource() {
  const root = new URL('../frontend/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const [, record] = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-workspace/client.js&'));
  return readFile(new URL(record.file, root), 'utf8');
}
function navigation(source) {
  const f = ui(), calls = {retain: [], connect: [], begin: 0}, refs = new Map();
  let attachments = ['png-fixture', 'txt-fixture'];
  const store = value => ({getSnapshot: () => value, set(next) {value = next;}});
  const reference = id => {
    refs.set(id, (refs.get(id) || 0) + 1); let live = true;
    return {sessionId: id, release() {if (!live) return; live = false; refs.set(id, refs.get(id) - 1); if (id === 'A' && refs.get(id) === 0) attachments = [];}};
  };
  const sessions = {retain(id) {calls.retain.push(id); return reference(id);}, subagentAddress() {},
    list: store({phase: 'ready', ids: ['A', 'B'], byId: {A: {id: 'A'}, B: {id: 'B'}}})};
  const workspaces = {list: store({phase: 'ready', items: [{workspaceId: 'W', sessionIds: ['A', 'B']}], archivedSessionIds: []})};
  const at = source.indexOf('var UiWorkspaceService = class');
  const region = source.slice(at, source.indexOf('\n\t\t};', at) + '\n\t\t};'.length);
  const Service = runInNewContext(region + '\nUiWorkspaceService', {globalThis: f.view, AbortController, AbortSignal,
    _deepseek_ai_cordis: {Service: class {constructor(ctx) {this.ctx = ctx;}}}, _deepseek_ai_dsh_client_store: {createSnapshotStore: store}, recentWorkspace: () => 'W'});
  const service = new Service({effect() {}, layout: {beginNavigation() {calls.begin++; return new AbortController().signal;}, selectPanel() {}}}, {}, workspaces, sessions, {}, () => {});
  service.mainReference = reference('A');
  service.connectBlank = async id => {calls.connect.push(id); return 'B';};
  return {...f, service, calls, get attachments() {return attachments;}, removeAttachments() {attachments = []; f.setSafe(true);}, addAttachments() {attachments = ['new-png', 'new-txt']; f.setSafe(false);}};
}

pinnedTest('actual native navigation demonstrates why releasing the last mainView loses draft attachments', async () => {
  const f = navigation(await workspaceSource());
  await f.service.openWorkspaceSession('W');
  assert.equal(f.service.mainReference.sessionId, 'B');
  assert.deepEqual(f.attachments, [], 'unpatched navigation releases A without a document reload');
});

pinnedTest('all three actual navigation entry points refuse before retain, allocation or draft preparation', async () => {
  const patched = patchWorkspaceDraftNavigation(await workspaceSource()); new Function(patched);
  for (const invoke of [s => s.openSession('B'), s => s.openSession({sessionId: 'child'}), s => s.openWorkspaceSession('W'), s => s.openWorkspace('W'), s => s.startSession('W', {prompt: 'would replace draft'})]) {
    const f = navigation(patched);
    assert.equal(await invoke(f.service), undefined, 'preserve void / resolved Promise<void> contract');
    assert.deepEqual(f.calls, {retain: [], connect: [], begin: 0});
    assert.equal(f.service.mainReference.sessionId, 'A'); assert.equal(f.attachments.length, 2);
    assert.equal(f.nodes.length, 1);
  }
});

pinnedTest('attachments added during blank creation stay in A when the authorized B creation resolves', async () => {
  const f = navigation(patchWorkspaceDraftNavigation(await workspaceSource())); f.removeAttachments();
  let release;
  f.service.connectBlank = id => {f.calls.connect.push(id); return new Promise(resolve => {release = resolve;});};
  const pending = f.service.openWorkspaceSession('W');
  assert.equal(f.calls.connect.length, 1);
  f.addAttachments(); release('B'); await pending;
  assert.equal(f.service.mainReference.sessionId, 'A'); assert.equal(f.attachments.length, 2);
  assert.deepEqual(f.calls.retain, []); assert.deepEqual(f.calls.connect, ['W'], 'never allocate or retry a second blank');
  assert.equal(f.nodes.length, 1);
});

pinnedTest('current-session return and safe navigation keep native behavior, without changing archive cleanup', async () => {
  const patched = patchWorkspaceDraftNavigation(await workspaceSource());
  const current = navigation(patched); current.service.openSession('A'); assert.equal(current.attachments.length, 2); assert.deepEqual(current.calls.retain, ['A']);
  const safe = navigation(patched); safe.removeAttachments(); await safe.service.openWorkspaceSession('W');
  assert.equal(safe.service.mainReference.sessionId, 'B'); assert.deepEqual(safe.calls.connect, ['W']); assert.deepEqual(safe.calls.retain, ['B']);
  const archived = navigation(patched); archived.service.clearMain(); assert.equal(archived.service.mainReference, undefined, 'authoritative archive/root cleanup remains native');
  const original = await workspaceSource();
  assert.equal((patched.match(/__dshMobileAllowNavigation/g) || []).length, 4, 'three entry checks plus post-await race recheck');
  const cleanupRegion = source => {const start = source.indexOf('clearMain() {'); return source.slice(start, source.indexOf('replaceMain(target,', start));};
  assert.equal(cleanupRegion(patched), cleanupRegion(original));
});
