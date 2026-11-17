import {pinnedTest as test,hasPinnedFrontend} from './pinned-fixture.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { patchWorkspaceRestoration, patchConversationRestoration, patchChatReadiness } from '../backend/session-restore.mjs';
import { buildMobileProfile } from '../backend/mobile-profile.mjs';
import { fileURLToPath } from 'node:url';

const root = new URL('../frontend/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
async function sourceFor(name) {
  const entry = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-' + name + '/client.js&'));
  return readFile(new URL(entry[1].file, root), 'utf8');
}
const workspace = hasPinnedFrontend ? patchWorkspaceRestoration(await sourceFor('workspace')) : null;
const conversation = hasPinnedFrontend ? patchConversationRestoration(await sourceFor('conversation')) : null;

function store(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, set(next) { value = next; for (const fn of listeners) fn(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
function navigation() {
  const start = workspace.indexOf('var UiWorkspaceService = class');
  const end = workspace.indexOf('\n\t\t};', start) + '\n\t\t};'.length;
  const Service = runInNewContext(workspace.slice(start, end) + '\nUiWorkspaceService', {
    _deepseek_ai_cordis: { Service: class { constructor(ctx) { this.ctx = ctx; } } },
    _deepseek_ai_dsh_client_store: { createSnapshotStore: store },
    AbortController, AbortSignal, console: { warn() {} }
  });
  const sessions = { list: store({ phase: 'pending', ids: [], byId: {} }) };
  const workspaces = { list: store({ phase: 'pending', items: [], archivedSessionIds: [] }) };
  const service = new Service({ effect() {}, layout: { selectPanel() {} } }, {}, workspaces, sessions, {}, () => {});
  return { service, sessions, workspaces };
}
function render({ status = 'pending', sessionId, mobile = true, session, summaryBlank } = {}) {
  const start = conversation.indexOf('function ConversationMainPanel(props)');
  const end = conversation.indexOf('\n\t\t//#endregion', start);
  const jsx = (type, props) => ({ type, props });
  const component = runInNewContext(conversation.slice(start, end) + '\nConversationMainPanel', {
    globalThis: { matchMedia: () => ({ matches: mobile }) },
    react_jsx_runtime: { jsx, jsxs: jsx },
    ConversationRoot_module_css_default: { root: 'conversation-root' },
    CONTENT_SLOTS: {}, conversationPhase: () => summaryBlank ? 'blank' : 'active'
  });
  return component({ sessionId, useSession: fn => fn(session), useConversation: fn => fn(session ? {} : undefined),
    useSessions: fn => fn({ byId: sessionId ? { [sessionId]: { blank: summaryBlank } } : {} }),
    useMobileRestoration: fn => fn(status), renderSlot: name => name,
    renderFactorySlot: (name, props) => ({ type: name, props }) });
}

test('startup waits for both lists and the actual async restoration, without rendering a new-session hero', async () => {
  const { service, sessions, workspaces } = navigation();
  let resolveRestore, calls = 0;
  service.restoreSelection = () => { calls++; return new Promise(resolve => { resolveRestore = resolve; }); };
  const stop = service.watchNavigation();
  assert.equal(calls, 0);
  workspaces.list.set({ phase: 'ready', items: [], archivedSessionIds: [] });
  assert.equal(calls, 0);
  sessions.list.set({ phase: 'ready', ids: [], byId: {} });
  assert.equal(calls, 1);
  const pending = render({ status: service.mobileRestoration.getSnapshot() });
  assert.equal(pending.props['data-phase'], 'settling');
  assert.equal(pending.props.children[1].props['data-dshm-session-restore'], 'pending');
  resolveRestore();
  await Promise.resolve();
  assert.equal(service.mobileRestoration.getSnapshot(), 'ready');
  assert.equal(render({ status: 'ready' }).props.children[1].props.hero, true);
  stop();
});

test('saved existing session is restored without creating a blank; manual navigation releases the gate', async () => {
  const { service } = navigation();
  service.selection.set({ sessionId: 'existing' });
  const retained = [];
  service.sessions.retain = id => { retained.push(id); return { sessionId: id, release() {} }; };
  service.sessions.subagentAddress = () => undefined;
  await service.restoreSelection({ items: [], archivedSessionIds: [] }, { byId: { existing: { id: 'existing', blank: false } } });
  assert.deepEqual(retained, ['existing']);
  assert.equal(service.mobileRestoration.getSnapshot(), 'ready');
  assert.equal(render({ status: 'ready', sessionId: 'existing', session: { openState: 'open' } }).props['data-phase'], 'active');
  service.mobileRestoration.set('pending');
  service.openSession('explicit');
  assert.equal(service.mobileRestoration.getSnapshot(), 'ready');
});

test('restoration completion is not history completion and successful restoration has no extra label', () => {
  const pending = render({ status: 'pending' });
  assert.equal(pending.props.children[1].props.children, null);
  assert.equal(pending.props['data-dshm-conversation-state'], 'pending');
  assert.equal(render({ status: 'ready', sessionId: 'saved', session: {openState:'loading'} }).props['data-dshm-conversation-state'], 'loading');
  assert.equal(render({ status: 'ready', sessionId: 'saved', session: {openState:'open'} }).props['data-dshm-conversation-state'], 'ready');
  assert.equal(render({ status: 'ready', sessionId: 'saved', session: {openState:'error'} }).props['data-dshm-conversation-state'], 'error');
});

test('history readiness markers come from native open state and first layout, not text or older paging', async () => {
  const original = await sourceFor('chat');
  const patched = patchChatReadiness(original);
  new Function(patched);
  assert.match(patched, /"data-dshm-history-state": openState/);
  assert.match(patched, /"data-dshm-history-positioned": scroll.initialized \? "" : void 0/);
  assert.throws(() => patchChatReadiness('unknown'), /review history readiness/);
});

test('restoration errors are visible, and a subsequent list update can recover', async () => {
  const { service, sessions, workspaces } = navigation();
  service.restoreSelection = async () => { throw new Error('offline'); };
  const stop = service.watchNavigation();
  workspaces.list.set({ phase: 'ready', items: [], archivedSessionIds: [] });
  sessions.list.set({ phase: 'ready', ids: [], byId: {} });
  await Promise.resolve();
  assert.equal(service.mobileRestoration.getSnapshot(), 'error');
  assert.match(render({ status: 'error' }).props.children[1].props.children, /恢复失败/);
  service.restoreSelection = async () => {};
  sessions.list.set(sessions.list.getSnapshot());
  await Promise.resolve();
  assert.equal(service.mobileRestoration.getSnapshot(), 'ready');
  stop();
});

test('genuine blank sessions and desktop rendering retain their original hero', () => {
  assert.equal(render({ sessionId: 'blank', session: { openState: 'open' }, summaryBlank: true }).props.children[1].props.hero, true);
  assert.equal(render({ mobile: false }).props.children[1].props.hero, true);
});

test('served module profile carries the restoration hook and patched revisions without changing the snapshot', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const profile = await buildMobileProfile(fileURLToPath(root), html, manifest);
  const boot = JSON.parse(profile.html.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)[1]);
  for (const name of ['workspace', 'conversation']) {
    const entry = boot.entries.find(entry => entry.id === '@deepseek-ai/dsh-client-ui-' + name);
    const body = profile.bodies.get('/' + entry.url).toString();
    new Function(body);
    assert.ok(body.includes('mobileRestoration'));
    assert.notEqual(body, await sourceFor(name));
  }
  const chatEntry = boot.entries.find(entry => entry.id === '@deepseek-ai/dsh-client-ui-chat');
  const chatBody = profile.bodies.get('/' + chatEntry.url).toString();
  assert.match(chatBody, /data-dshm-history-positioned/);
  new Function(chatBody);
  assert.match(workspace, /data-dshm-workspace-state/);
  const start = conversation.indexOf('const registerConversationRoot =');
  const end = conversation.indexOf('const registerConversationContent =', start);
  const snapshot = store('pending');
  const options = runInNewContext(conversation.slice(start, end) + '\nregisterConversationRoot()', {
    slots: { register: options => options }, ConversationRoot() {}, workspaceNavigation: { mobileRestoration: snapshot }
  });
  assert.equal(options.inject().hooks.mobileRestoration, snapshot);
  assert.throws(() => patchWorkspaceRestoration('unknown'), /review session restoration/);
  assert.throws(() => patchConversationRestoration('unknown'), /review session restoration/);
});
