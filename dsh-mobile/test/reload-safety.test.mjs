import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {isDshMobileReloadSafe, installDshNativeReloadSafety, patchConversationReloadSafety} from '../backend/reload-safety.mjs';
import {injectMobileShell} from '../backend/mobile.mjs';
import {pinnedTest} from './pinned-fixture.mjs';

function documentWith(...presentSelectors) {
  return {querySelector(selector) {return selector.split(', ').find(part => presentSelectors.includes(part)) ? {} : null;}};
}

test('reload safety protects sending and all draft attachment states even in a hidden iframe', () => {
  const rail = '[data-composer-card] [class~="pNt0EW_rail"]';
  for (const kind of ['image draft', 'file uploading', 'file ready', 'upload failed']) {
    const doc = documentWith(rail); doc.hidden = true;
    assert.equal(isDshMobileReloadSafe(doc), false, kind);
  }
  for (const state of ['button[aria-busy="true"]', 'button[data-sending]', '[data-composer-composing]', ...['adjudicating', 'submitting', 'sending'].map(phase => `[data-composer-input][data-phase="${phase}"]`)]) {
    assert.equal(isDshMobileReloadSafe(documentWith('[data-composer-card] ' + state)), false, state);
  }
});

test('plain drafts, idle editors and finished transcript attachments do not block reload', () => {
  for (const selectors of [[], ['[data-composer-card] [data-composer-input][data-phase="plain"]'], ['[data-composer-card] [data-composer-input][data-phase="claimed"]'], ['[data-chat] [class~="pNt0EW_rail"]'], ['[data-chat-running]'], ['[data-composer-card] button[aria-busy="false"]']]) {
    assert.equal(isDshMobileReloadSafe(documentWith(...selectors)), true);
  }
});

test('the injected synchronous hook reports safety without reloading, navigating or relying on iframe visibility', () => {
  const html = injectMobileShell('<html><head></head><body></body></html>');
  const script = html.match(/<script id="dshm-mobile-shell">([\s\S]*?)<\/script>/)[1];
  const begin = script.indexOf('window.__dshMobileReloadSafe =');
  const hook = script.slice(begin, script.indexOf('const localReadiness', begin));
  assert.doesNotMatch(hook, /getBoundingClientRect|offsetHeight|innerHeight|\.reload\(|setPage|setTimeout/);
  const window = {};
  runInNewContext(hook, {window, document: documentWith('[data-composer-card] button[data-sending]')});
  assert.equal(window.__dshMobileReloadSafe(), false);
});

test('native safety getter failures fail closed and cleanup cannot overwrite a newer owner', () => {
  const document = documentWith();
  for (const native of [() => false, () => undefined, () => {throw Error('unknown');}, 'invalid']) {
    assert.equal(isDshMobileReloadSafe(document, {__dshMobileNativeReloadSafe: native}), false);
  }
  const view = {};
  const stop = installDshNativeReloadSafety({draftAttachments: new Map(), pendingFileUploads: new Set(), input: {}}, view);
  assert.equal(view.__dshMobileNativeReloadSafe(), false, 'unknown registry is not empty proof');
  const newer = () => true; view.__dshMobileNativeReloadSafe = newer; stop(); assert.equal(view.__dshMobileNativeReloadSafe, newer);
});

test('every live controller participates in reload safety and disposal never revives a dead owner', () => {
  const make = () => ({draftAttachments: new Map(), pendingFileUploads: new Set(), input: {mobileReloadShells: new Set()}});
  for (const order of [[0, 1], [1, 0]]) {
    const view = {}, a = make(), b = make();
    a.draftAttachments.set('A', {});
    const stops = [installDshNativeReloadSafety(a, view), installDshNativeReloadSafety(b, view)];
    assert.equal(view.__dshMobileNativeReloadSafe(), false, 'empty B cannot replace unsafe A');
    a.draftAttachments.clear(); assert.equal(view.__dshMobileNativeReloadSafe(), true);
    a.pendingFileUploads.add('later upload'); assert.equal(view.__dshMobileNativeReloadSafe(), false, 'old controller remains live after installing B');
    a.pendingFileUploads.clear();
    const shell = {state: {getSnapshot: () => ({phase: 'sending', attachmentIds: []})}, editor: {isComposing: () => false, getRootElement: () => null}};
    a.input.mobileReloadShells.add(shell); assert.equal(view.__dshMobileNativeReloadSafe(), false);
    a.input.mobileReloadShells.clear();
    b.input.mobileReloadShells.add({state: {getSnapshot: () => ({phase: 'plain', attachmentIds: []})}, editor: {isComposing: () => true}});
    assert.equal(view.__dshMobileNativeReloadSafe(), false);
    stops[order[0]]();
    assert.equal(view.__dshMobileNativeReloadSafe(), order[0] === 1, 'only surviving controller decides');
    stops[order[1]](); assert.equal(view.__dshMobileNativeReloadSafe, undefined);
    stops[order[0]](); assert.equal(view.__dshMobileNativeReloadSafe, undefined, 'cleanup is idempotent');
  }
});

test('registration tokens detach disposed controllers, retain duplicate registrations and fail closed independently', () => {
  const view = {}, controller = {pendingFileUploads: new Set(), input: {mobileReloadShells: new Set()}};
  let reads = 0, dead = false;
  Object.defineProperty(controller, 'draftAttachments', {get() {reads++; if (dead) throw Error('disposed controller accessed'); return new Map();}});
  const a = installDshNativeReloadSafety(controller, view), b = installDshNativeReloadSafety(controller, view);
  assert.equal(view.__dshMobileNativeReloadSafe(), true); assert.equal(reads, 2);
  a(); reads = 0; assert.equal(view.__dshMobileNativeReloadSafe(), true); assert.equal(reads, 1);
  const stale = view.__dshMobileNativeReloadSafe; b(); dead = true; reads = 0;
  assert.equal(stale(), true); assert.equal(reads, 0, 'no disposed closures remain registered');
  const good = {draftAttachments: new Map(), pendingFileUploads: new Set(), input: {mobileReloadShells: new Set()}};
  const broken = installDshNativeReloadSafety(controller, view), healthy = installDshNativeReloadSafety(good, view);
  assert.equal(view.__dshMobileNativeReloadSafe(), false); broken(); assert.equal(view.__dshMobileNativeReloadSafe(), true);
  healthy(); assert.equal(view.__dshMobileNativeReloadSafe, undefined);
});

test('unknown or duplicate native patch boundaries fail closed instead of losing reload protection', () => {
  assert.throws(() => patchConversationReloadSafety('unknown'), /review reload safety/);
  assert.throws(() => patchConversationReloadSafety('shells = /* @__PURE__ */ new WeakMap();'.repeat(2)), /review reload safety/);
});

pinnedTest('safety selectors match the actual pinned composer rail and send-state attributes', async () => {
  const root = new URL('../frontend/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const sourceFor = async name => {
    const [, record] = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-' + name + '/client.js&'));
    return readFile(new URL(record.file, root), 'utf8');
  };
  const attachments = await sourceFor('attachment');
  assert.match(attachments, /"rail": "pNt0EW_rail"/);
  assert.match(attachments, /railItems\.length > 0 && [\s\S]*?className: ComposerAttachments_module_css_default\.rail/);
  const conversation = await sourceFor('conversation');
  assert.match(conversation, /"data-composer-card": true/);
  assert.match(conversation, /"aria-busy": sending,\s*"data-sending": sending \? "" : void 0/);
  assert.match(conversation, /"data-composer-input": true/);
  assert.match(conversation, /"data-phase": phase/);
  assert.match(conversation, /toggleAttribute\("data-composer-composing", composing \|\| editor.isComposing\(\)\)/);
  const draft = conversation.slice(conversation.indexOf('function snapshotDraft('), conversation.indexOf('function copyReference('));
  assert.doesNotMatch(draft, /attachmentIds|attachments/);
  assert.match(conversation, /draftAttachments = \/\* @__PURE__ \*\/ new Map\(\)/);
});

pinnedTest('separately constructed native ConversationControllers share protection and release in any order', async () => {
  const root = new URL('../frontend/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const [, record] = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&'));
  const patched = patchConversationReloadSafety(await readFile(new URL(record.file, root), 'utf8'));
  const at = patched.indexOf('var ConversationController = class');
  const region = patched.slice(at, patched.indexOf('\n\t\t//#endregion', at));
  for (const order of [[0, 1], [1, 0]]) {
    const realm = {_deepseek_ai_cordis: {Service: class {}}, revokePreview() {},
      _deepseek_ai_dsh_client_store: {createSnapshotStore: value => ({getSnapshot: () => value, set(next) {value = next;}})}};
    const Controller = runInNewContext(region + '\nConversationController', realm);
    function create() {
      const cleanups = [];
      const controller = new Controller({effect(setup) {cleanups.push(setup());}}, {input: {mobileReloadShells: new Set()}, blocks: {}, maxConcurrentFileUploads: 1});
      return {controller, async dispose() {for (const cleanup of cleanups) await cleanup();}};
    }
    const a = create(); a.controller.draftAttachments.set('A-image', {kind: 'image', previewUrl: 'blob:fixture'});
    const guard = realm.__dshMobileNativeReloadSafe, b = create();
    assert.equal(realm.__dshMobileNativeReloadSafe, guard, 'another native instance registers rather than overwrites');
    assert.equal(guard(), false);
    a.controller.draftAttachments.clear(); assert.equal(guard(), true);
    a.controller.pendingFileUploads.add(Promise.resolve()); assert.equal(guard(), false);
    const instances = [a, b];
    await instances[order[0]].dispose();
    assert.equal(guard(), order[0] === 0, 'disposal removes only the originating controller');
    await instances[order[1]].dispose();
    assert.equal(realm.__dshMobileNativeReloadSafe, undefined);
    assert.equal(guard(), true, 'stale reference contains no disposed controller checks');
  }
});

pinnedTest('actual retained InputHub tracks every shell and releases its safety reference on disposal', async () => {
  const root = new URL('../frontend/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const [, record] = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&'));
  const patched = patchConversationReloadSafety(await readFile(new URL(record.file, root), 'utf8'));
  new Function(patched);
  assert.match(patched, /ctx.effect\(\(\) => \(function installDshNativeReloadSafety/);
  const at = patched.indexOf('var InputHub = class');
  const region = patched.slice(at, patched.indexOf('\n\t\t//#endregion', at));
  const Hub = runInNewContext(region + '\nInputHub', {
    readConversationDraft: () => ({text: '', references: []}),
    SessionInputShell: class {
      phase = 'plain'; attachmentIds = []; composing = false; disposed = false;
      state = {getSnapshot: () => ({phase: this.phase, attachmentIds: this.attachmentIds})};
      editor = {isComposing: () => this.composing, getRootElement: () => null};
      setDraft() {} dispose() {this.disposed = true; return [];}
    },
  });
  const hub = new Hub({get: () => ({releaseDraftAttachment() {}})}, () => '');
  function binding(id) {
    const disposers = [];
    return {sessionId: id, session: {projections: {faceOf: () => ({})}}, ctx: {on: () => () => {}, effect(setup) {disposers.push(setup());}, inject() {}}, dispose() {for (const fn of disposers) fn();}};
  }
  const a = binding('A'), b = binding('B');
  const shellA = hub.shellFor(a), shellB = hub.shellFor(b);
  assert.equal(hub.shellFor(a), shellA, 'native resident facade identity is unchanged');
  assert.equal(hub.mobileReloadShells.size, 2);
  const controller = {input: hub, draftAttachments: new Map(), pendingFileUploads: new Set()};
  const view = {}, stop = installDshNativeReloadSafety(controller, view), emptyB = documentWith();
  assert.equal(isDshMobileReloadSafe(emptyB, view), true);
  controller.draftAttachments.set('A-image', {}); assert.equal(isDshMobileReloadSafe(emptyB, view), false, 'B has no rail but A still owns an attachment');
  controller.draftAttachments.delete('A-image'); assert.equal(isDshMobileReloadSafe(emptyB, view), true);
  controller.pendingFileUploads.add('A-upload'); assert.equal(isDshMobileReloadSafe(emptyB, view), false);
  controller.pendingFileUploads.clear();
  shellA.phase = 'sending'; assert.equal(isDshMobileReloadSafe(emptyB, view), false);
  shellA.phase = 'plain'; shellA.composing = true; assert.equal(isDshMobileReloadSafe(emptyB, view), false);
  shellA.composing = false; assert.equal(isDshMobileReloadSafe(emptyB, view), true);
  a.dispose(); assert.equal(shellA.disposed, true); assert.equal(hub.mobileReloadShells.size, 1); assert.equal(hub.mobileReloadShells.has(shellA), false);
  b.dispose(); assert.equal(shellB.disposed, true); assert.equal(hub.mobileReloadShells.size, 0);
  stop(); assert.equal(view.__dshMobileNativeReloadSafe, undefined);
});
