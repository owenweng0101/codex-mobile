import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {pinnedTest, hasPinnedFrontend} from './pinned-fixture.mjs';
import {injectMobileShell} from '../backend/mobile.mjs';
import {patchMobileComposerActions} from '../backend/composer-actions.mjs';

const html = injectMobileShell('<html><head></head><body></body></html>');
const style = html.match(/<style id="dshm-mobile">([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script id="dshm-mobile-shell">([\s\S]*?)<\/script>/)[1];
const root = new URL('../frontend/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const entry = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-conversation/client.js&'));
const source = hasPinnedFrontend ? await readFile(new URL(entry[1].file, root), 'utf8') : '';
function region(start, text = source) {
  const at = text.indexOf(start);
  assert.ok(at >= 0, start);
  return text.slice(at, text.indexOf('\n\t\t//#endregion', at));
}

// Exercise the pinned component, not a duplicate of its send-state decisions.
function render({phase = 'plain', draft = 'hello', running = false, busyEnter = 'steer', attachments = [], uploads = {}, subagent = null, denied = [], stopAvailable = true, mobile = true} = {}) {
  const jsx = (type, props) => ({type, props});
  const classes = runInNewContext(region('var InputBar_module_css_default =') + '\nInputBar_module_css_default');
  const component = runInNewContext(region('const InputBar =', mobile ? patchMobileComposerActions(source) : source) + '\nInputBar', {
    react: {memo: fn => fn, useState: value => [value, () => {}], useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({current: value})},
    react_jsx_runtime: {jsx, jsxs: jsx}, InputBar_module_css_default: classes,
    clsx: (...names) => names.filter(Boolean).join(' '),
    resolveSubmitMode: (preferred, active) => active ? preferred : 'queue',
    DraftEditor: 'DraftEditor', ContextMeter: 'ContextMeter',
    _deepseek_ai_dsh_client_ui_primitives: new Proxy({}, {get: (_, key) => key}),
  });
  const input = {phase, draft, attachmentIds: attachments.map(a => a.id), queue: []};
  let submitted = 0, stopped = 0;
  const props = {
    useInput: fn => fn(input), useSession: fn => fn({running, subagent}), useNotices: fn => fn(undefined),
    useBusyEnter: fn => fn(busyEnter), useStopShortcut: fn => fn([]), useAccess: permission => !denied.includes(permission),
    useMenuLauncher: fn => fn(undefined), useProjection: () => undefined, useFileUploads: fn => fn(uploads),
    inputActions: {}, keyboard: {editor: null, submit() {submitted++;}}, resolveDraftAttachments: () => attachments,
    stop: stopAvailable ? () => {stopped++;} : undefined, t: key => key, renderSlot: () => null, sessionId: 'fixture', variant: 'composer',
  };
  const tree = component(props);
  const nodes = [];
  const visit = node => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of [node.props?.children].flat()) visit(child); };
  visit(tree);
  return {nodes, input, classes, get submitted() {return submitted;}, get stopped() {return stopped;}};
}

test('all primary-button labels share fixed geometry before observer tagging', () => {
  // The native sending/queued states change aria-label, not the primary identity.
  const primary = style.match(/\[data-composer-card\] button\[class~="JZLxKW_primary"\][^{]*\{([^}]+)\}/)?.[1];
  assert.ok(primary, 'sending must not fall through to desktop 34px / translateY(-2px)');
  for (const rule of ['height: 32px !important', 'width: 32px !important', 'transform: none !important']) assert.ok(primary.includes(rule), rule);
  assert.match(style, /:is\(\[data-dshm-toolbar\], \[data-composer-card\] > \[class~="JZLxKW_row"\]\) \{[^}]*padding-top: 4px !important/);
});

test('long drafts retain the original conversation and hero heights with internal scrolling', () => {
  const input = style.slice(style.indexOf('/* Keep both the editor'), style.indexOf('/* 输入框工具条'));
  assert.match(input, /--dshm-input-height: 36px/);
  assert.match(input, /\[class~="JZLxKW_hero"\][\s\S]*?--dshm-input-height: 52px/);
  for (const property of ['height', 'min-height', 'max-height']) {
    assert.equal(input.split(property + ': var(--dshm-input-height) !important').length - 1, property === 'height' ? 6 : 2);
  }
  assert.equal((input.match(/overflow-y: auto !important/g) || []).length, 2);
});

pinnedTest('pinned desktop primary geometry explains the transient mismatch without the mobile rule', () => {
  const at = source.indexOf('const css$1 =');
  const css = runInNewContext(source.slice(at, source.indexOf('\n\t\tconst tagId$1', at)) + '\ncss$1');
  const primary = css.match(/\.JZLxKW_primary\{([^}]+)\}/)[1];
  assert.match(primary, /width:34px/);
  assert.match(primary, /height:34px/);
  assert.match(primary, /transform:translateY\(-2px\)/);
});

pinnedTest('pinned idle, busy, queue, steer and stop controls keep native semantics and stable class', () => {
  const states = [
    [{draft: ''}, 'input.send', true],
    [{}, 'input.send', false],
    [{phase: 'adjudicating'}, 'input.send', true],
    [{phase: 'submitting'}, 'input.send', true],
    [{phase: 'sending'}, 'input.sending', true],
    [{running: true, draft: ''}, 'input.stop', false],
    [{running: true}, 'input.send.steer', false],
    [{running: true, busyEnter: 'queue'}, 'input.send.queue', false],
    [{attachments: [{id: 'file', kind: 'file'}], uploads: {file: {status: 'uploading'}}}, 'input.send', true],
    [{attachments: [{id: 'file', kind: 'file'}], uploads: {file: {status: 'error'}}}, 'input.send', true],
    [{draft: '', attachments: [{id: 'file', kind: 'file'}], uploads: {file: {status: 'ready'}}}, 'input.send', false],
  ];
  for (const [state, label, disabled] of states) {
    const f = render(state);
    const button = f.nodes.filter(n => n.type === 'button' && n.props.className === f.classes.primary).at(-1);
    assert.equal(button.props['aria-label'], label);
    assert.equal(button.props.disabled, disabled, label);
    assert.equal(button.props.className, 'JZLxKW_primary');
    assert.equal(button.props['aria-busy'], state.phase === 'sending');
    if (label !== 'input.stop') { button.props.onClick(); assert.equal(f.submitted, disabled ? 0 : 1); }
    else { button.props.onClick(); assert.equal(f.stopped, 1); }
    assert.equal(f.input.draft, state.draft ?? 'hello', 'render/send press cannot mutate the draft');
  }
});

pinnedTest('running follow-up submission retains exactly one usable Stop without moving or resending the draft', () => {
  for (const draft of ['', 'follow-up']) for (const busyEnter of ['steer', 'queue']) {
    const f = render({running: true, phase: 'sending', draft, busyEnter, attachments: [{id: 'image', kind: 'image'}]});
    const buttons = f.nodes.filter(n => n.type === 'button' && n.props.className === f.classes.primary);
    assert.equal(buttons.length, 1, 'running + sending must not render two circles');
    const button = buttons[0];
    assert.equal(button.props['aria-label'], 'input.stop');
    assert.equal(button.props.disabled, false);
    assert.equal(button.props['aria-busy'], true);
    assert.equal(button.props['data-sending'], '');
    button.props.onClick(); assert.equal(f.stopped, 1); assert.equal(f.submitted, 0);
    assert.equal(f.input.draft, draft); assert.deepEqual(f.input.attachmentIds, ['image']);
  }
});

pinnedTest('ordinary composer handoff never adds a second action and preserves Stop permissions', () => {
  const controls = f => f.nodes.filter(n => n.type === 'button' && n.props.className === f.classes.primary);
  const sequence = [
    [{draft: 'initial'}, 'input.send'],
    [{running: true, draft: ''}, 'input.stop'],
    [{running: true, draft: 'follow-up'}, 'input.send.steer'],
    [{running: true, draft: 'follow-up', phase: 'sending'}, 'input.stop'],
    [{running: true, draft: ''}, 'input.stop'],
    [{running: false, draft: ''}, 'input.send'],
  ];
  for (const [state, label] of sequence) {
    const buttons = controls(render(state)); assert.equal(buttons.length, 1); assert.equal(buttons[0].props['aria-label'], label);
  }
  const noCancel = controls(render({running: true, phase: 'sending', denied: ['session/cancel']}));
  assert.equal(noCancel.length, 1); assert.equal(noCancel[0].props['aria-label'], 'input.sending'); assert.equal(noCancel[0].props.disabled, true);
  const noPrompt = render({running: true, phase: 'sending', denied: ['session/prompt']});
  assert.equal(controls(noPrompt).length, 1); controls(noPrompt)[0].props.onClick(); assert.equal(noPrompt.stopped, 1); assert.equal(noPrompt.submitted, 0);
  assert.equal(controls(render({running: true, phase: 'sending', denied: ['session/prompt', 'session/cancel']})).length, 0);
  assert.equal(controls(render({running: true, phase: 'sending', stopAvailable: false}))[0].props.disabled, true);
  assert.equal(controls(render({running: true, phase: 'sending', mobile: false})).length, 2, 'unpatched native layout is the negative control');
});

pinnedTest('continuable subagent controls and non-running submission remain unchanged', () => {
  const signature = f => f.nodes.filter(n => n.type === 'button' && n.props.className === f.classes.primary).map(n => [n.props['aria-label'], n.props.disabled, n.props['aria-busy'], n.props['data-sending']]);
  for (const mode of ['continuable', 'reviewer']) for (const phase of ['plain', 'sending']) for (const draft of ['', 'text']) {
    const state = {running: true, phase, draft, subagent: {address: {mode}, parentAvailable: true}};
    assert.deepEqual(signature(render(state)), signature(render({...state, mobile: false})));
  }
  assert.deepEqual(signature(render({phase: 'sending'})), signature(render({phase: 'sending', mobile: false})));
});

test('mobile action patch fails closed if the reviewed InputBar boundaries change', () => {
  assert.throws(() => patchMobileComposerActions(''), /Pinned InputBar changed/);
});

pinnedTest('native failed sends retain text and attachments; success clears only once; stale receipts cannot clear another draft', () => {
  const Machine = runInNewContext(region('var SubmitMachine =') + '\nSubmitMachine', {AbortController});
  const machine = new Machine();
  const enter = {type: 'enter', mode: 'queue', draft: '中文\n'.repeat(200), occurrences: [], quotes: [], attachmentIds: ['image', 'file']};
  const [send] = machine.dispatch(enter);
  assert.equal(machine.phase, 'sending');
  assert.equal(send.attempt.draftSnapshot, enter.draft);
  assert.deepEqual([...send.attempt.attachmentIds], enter.attachmentIds);
  assert.equal(machine.dispatch(enter).length, 0, 'double tap is not replayed');
  const failed = machine.dispatch({type: 'sink-settled', attempt: send.attempt, ok: false, message: 'offline'});
  assert.equal(machine.phase, 'plain');
  assert.equal(failed.some(effect => effect.type === 'commit-draft'), false);
  const [retry] = machine.dispatch(enter);
  assert.equal(machine.dispatch({type: 'sink-settled', attempt: send.attempt, ok: true}).length, 0);
  const success = machine.dispatch({type: 'sink-settled', attempt: retry.attempt, ok: true});
  assert.equal(success.filter(effect => effect.type === 'commit-draft').length, 1);
  assert.equal(machine.dispatch({type: 'sink-settled', attempt: retry.attempt, ok: true}).length, 0);
});

test('command-chip backspace helper leaves IME and ordinary text editing to the native editor', () => {
  const start = script.indexOf('const sendBackspace =');
  const helper = script.slice(start, script.indexOf('let scheduled =', start));
  function fixture(selected = true) {
    let listener, timers = [], dispatched = 0;
    class Element {
      closest() { return this; }
      querySelector() { return {hasAttribute: () => selected}; }
      hasAttribute(name) { return name === 'data-composer-composing' && this.composing; }
      cloneNode() { return {querySelectorAll: () => [], textContent: ''}; }
      dispatchEvent() {dispatched++;}
      isConnected = true;
    }
    const editor = new Element();
    runInNewContext(helper, {Element, mobile: {matches: true}, document: {addEventListener(type, fn) {listener = fn;}}, KeyboardEvent: class {}, setTimeout(fn) {timers.push(fn);}});
    return {keydown(event, flush = true) {listener({key: 'Backspace', target: editor, isTrusted: true, ...event}); if (flush) this.flush();},
      flush() {while (timers.length) timers.shift()();}, tick() {timers.shift()?.();}, compose() {editor.composing = true;}, get dispatched() {return dispatched;}};
  }
  for (const event of [{isComposing: true}, {keyCode: 229}, {isTrusted: false}, {key: 'a'}]) {
    const f = fixture(); f.keydown(event); assert.equal(f.dispatched, 0, JSON.stringify(event));
  }
  const normal = fixture(); normal.keydown({}); assert.equal(normal.dispatched, 1, 'explicit chip deletion still works');
  const beforeFirstTimer = fixture(); beforeFirstTimer.keydown({}, false); beforeFirstTimer.compose(); beforeFirstTimer.flush();
  assert.equal(beforeFirstTimer.dispatched, 0, 'composition beginning during the 30ms delay wins');
  const beforeSecondTimer = fixture(false); beforeSecondTimer.keydown({}, false); beforeSecondTimer.tick(); beforeSecondTimer.compose(); beforeSecondTimer.flush();
  assert.equal(beforeSecondTimer.dispatched, 1, 'composition beginning during the second 40ms delay wins');
});
