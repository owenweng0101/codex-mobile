import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {pinnedTest, hasPinnedFrontend} from './pinned-fixture.mjs';
import {injectMobileShell} from '../backend/mobile.mjs';

const html = injectMobileShell('<html><head></head><body></body></html>');
const style = html.match(/<style id="dshm-mobile">([\s\S]*?)<\/style>/)[1];
const script = html.match(/<script id="dshm-mobile-shell">([\s\S]*?)<\/script>/)[1];
const root = new URL('../frontend/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const entry = Object.entries(manifest.resources).find(([key]) => key.startsWith('/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&'));
const source = hasPinnedFrontend ? await readFile(new URL(entry[1].file, root), 'utf8') : '';
function region(start) {
  const at = source.indexOf(start); assert.ok(at >= 0, start);
  return source.slice(at, source.indexOf('\n\t\t//#endregion', at));
}

test('mobile restores the one native return-to-bottom control and centres it without owning scrolling', () => {
  const hidden = style.slice(style.indexOf('/* 手机上无意义的桌面控件'), style.indexOf('/* 固定版在 hover:none'));
  assert.doesNotMatch(hidden, /回到底部/);
  const slot = style.match(/\[class~="tnXGgG_toBottomSlot"\] \{([^}]+)\}/)?.[1];
  assert.ok(slot); assert.match(slot, /justify-content: center !important/); assert.match(slot, /padding-right: 0 !important/);
  assert.doesNotMatch(slot, /position:|bottom:|z-index:|display:|pointer-events:/, 'native composer-relative placement and click-through slot remain authoritative');
  const button = style.match(/button\[class~="tnXGgG_toBottom"\] \{([^}]+)\}/)?.[1];
  assert.ok(button); assert.match(button, /width: 28px !important/); assert.match(button, /height: 28px !important/); assert.match(button, /margin-top: -28px !important/);
  assert.match(button, /border: 1px solid var\(--hub-line/);
  assert.match(button, /background: var\(--hub-panel/);
  assert.match(button, /color: var\(--hub-ink/);
  assert.match(button, /0 1px 3px 0 rgb\(0 0 0 \/ \.1\), 0 1px 2px -1px/);
  assert.match(style, /tnXGgG_toBottom"\]::before \{[^}]*width: 16px;[^}]*height: 16px;/);
  assert.match(style, /d='M12%205v14'/, 'the icon has Codex’s full downward stem, not just a chevron');
  assert.match(style, /tnXGgG_toBottom"\]::after \{[^}]*inset: -8px;/, '28px circle plus 8px per side preserves a 44px hit target');
  assert.doesNotMatch(script, /tnXGgG_toBottom|回到底部/, 'no second button or synthetic scrolling listener');
  assert.match(style, /padding-bottom: env\(safe-area-inset-bottom, 0px\)/);
});

pinnedTest('native button exists only away from the tail and uses the original callback', () => {
  const at = source.indexOf('!scroll.followingTail &&');
  const end = source.indexOf('\n\t\t\t\t\tfileOpenError', at);
  assert.ok(at > 0 && end > at);
  const expression = source.slice(at, end).trim().replace(/,$/, '');
  let calls = 0; const returnToBottom = () => {calls++;};
  const render = followingTail => runInNewContext(expression, {scroll: {followingTail, returnToBottom},
    react_jsx_runtime: {jsx: (type, props) => ({type, props})},
    ChatView_module_css_default: {toBottomSlot: 'tnXGgG_toBottomSlot', toBottom: 'tnXGgG_toBottom'},
    t: key => key, _deepseek_ai_dsh_client_ui_primitives: {IconChevronDownOutlineRegular: 'native-down-arrow'}});
  assert.equal(render(true), false);
  const slot = render(false), button = slot.props.children;
  assert.equal(button.type, 'button'); assert.equal(button.props['aria-label'], 'chat.toBottom');
  assert.equal(button.props.onClick, returnToBottom); button.props.onClick(); assert.equal(calls, 1);
  assert.equal(render(true), false, 'at the tail the native element unmounts rather than remaining a hidden hit target');
});

pinnedTest('return-to-bottom cancels older navigation, follows the latest content and keeps live tail following', () => {
  const calls = [], saved = [];
  const Reading = runInNewContext(region('var ChatReading = class') + '\nChatReading', {});
  let floor = 12000;
  const viewport = {latestTurn: 80, scrollToBottom(_follow, behavior) {calls.push(['scroll', floor, behavior]); return {position: null, metrics: {top: floor, floor}};}};
  const follow = {setFollowing(value) {calls.push(['following', value]);}};
  const reading = new Reading(viewport, {save: value => saved.push(value)}, {followingTail: false, initialized: true, activeTurn: 5}, state => calls.push(['state', state.followingTail]), follow);
  const start = source.indexOf('const returnToBottom =');
  const end = source.indexOf('\n\t\t\treturn {', start);
  const callback = runInNewContext(source.slice(start, end) + '\nreturnToBottom', {
    react: {useCallback: fn => fn}, cancelPendingFollow: () => calls.push(['cancel-motion']),
    navigation: {cancel: () => calls.push(['cancel-jump'])}, reading,
  });
  callback();
  assert.deepEqual(calls.slice(0, 3), [['cancel-motion'], ['cancel-jump'], ['scroll', 12000, 'instant']]);
  assert.equal(reading.state.followingTail, true); assert.equal(reading.state.activeTurn, 80); assert.deepEqual(saved, [null]);
  floor = 12500; viewport.latestTurn = 81; reading.onResize();
  assert.ok(calls.some(call => call[0] === 'scroll' && call[1] === 12500));
  assert.equal(reading.state.followingTail, true); assert.equal(reading.state.activeTurn, 81);
  assert.doesNotMatch(source.slice(start, end), /loadOlder|loadThrough|\.submit|\.prompt/);
});

pinnedTest('fixed native slot stays above the measured composer and below its menus', () => {
  const at = source.indexOf('const css$16 =');
  const css = runInNewContext(source.slice(at, source.indexOf('\n\t\tconst tagId$16', at)) + '\ncss$16', {require: {asset: path => path}});
  assert.match(css, /\.tnXGgG_toBottomSlot\{[^}]*z-index:8/);
  assert.match(css, /\.tnXGgG_toBottomSlot\{[^}]*pointer-events:none/);
  assert.match(css, /\[data-conversation-scroll\] \.tnXGgG_toBottomSlot\{[^}]*bottom:calc\(var\(--dsh-composer-height,152px\) \+ 16px\)/);
  assert.match(css, /\[data-conversation-scroll\] \.tnXGgG_toBottomSlot\{[^}]*position:sticky/);
  assert.match(css, /\.tnXGgG_toBottom\{[^}]*pointer-events:auto/);
});
