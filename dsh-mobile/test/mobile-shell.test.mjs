import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectMobileShell } from '../backend/mobile.mjs';

/**
 * 注入脚本曾经因为正则转义在模板串里被吃掉而整体报错，页面上一片空白。
 * 这里直接解析注入产物，保证语法与关键样式不会悄悄坏掉。
 */

const html = injectMobileShell('<!doctype html><html><head></head><body><div id="root"></div></body></html>');

const script = html.match(/<script id="dshm-mobile-shell">([\s\S]*?)<\/script>/u)?.[1];
const style = html.match(/<style id="dshm-mobile">([\s\S]*?)<\/style>/u)?.[1];

test('emits one shell script and one style block', () => {
  assert.equal(typeof script, 'string');
  assert.equal(typeof style, 'string');
  assert.ok(script.length > 500);
  assert.ok(style.length > 500);
});

test('brand row has its final geometry before shell tagging or becoming visible', () => {
  assert.match(html, /<html data-dshm-mobile>/);
  assert.match(style, /\[class~="kB3qhq_logoRow"\],[\s\S]*?height: 44px !important/);
  assert.match(style, /\[data-dshm-logo\] \{ padding-left: 12px !important/);
  assert.match(style, /\[class\*="_sectionLabel"\] \{ margin-left: 1px/);
  const tagLogo = script.slice(script.indexOf('if (!taggedLogo'), script.indexOf('// 清除目标'));
  assert.match(tagLogo, /querySelector\('\[class~="kB3qhq_logoRow"\]'\)/);
  assert.doesNotMatch(tagLogo, /getBoundingClientRect/);
  const layout = script.slice(script.indexOf('function layout()'), script.indexOf('function tagChrome()'));
  assert.ok(layout.indexOf('sidebar = nextSidebar') < layout.indexOf('tagChrome();'));
});

test('the injected script parses in a browser-like global', () => {
  // 只编译不执行：语法错误会在这里抛出。
  assert.doesNotThrow(() => new Function(`"use strict";\n${script}`));
});

test('the injected stylesheet has balanced braces', () => {
  const open = (style.match(/\{/gu) ?? []).length;
  const close = (style.match(/\}/gu) ?? []).length;
  assert.equal(open, close);
});

test('keeps the mobile-only rules that hide desktop chrome', () => {
  for (const marker of [
    'data-dshm-toolbar',
    'data-dshm-crumbs',
    'data-dshm-tabs',
    'data-dshm-stats',
    'aria-label="用 访达 打开"',
    'aria-label="打开右侧边栏"',
    'aria-label="插件"',
    'width: 100vw',
  ]) {
    assert.ok(style.includes(marker), marker);
  }
});

test('the stats tag can never land on the composer seat', () => {
  // 提问/审批卡片占用输入位时，统计行会收成 0 宽；旧规则会一路往上爬到输入区，
  // 把整块输入区（含提问卡片）标成统计行再隐藏，手机上就无法作答。
  assert.match(style, /\[data-dshm-stats\]:not\(\[data-composer-seat\]\)/u);
  assert.match(script, /row !== composerSeat/u);
  assert.match(script, /\[data-question-key\]/u);
  assert.match(script, /removeAttribute\('data-dshm-stats'\)/u);
});

test('only session rows close the drawer, never workspace rows', () => {
  assert.match(script, /hasAttribute\('aria-selected'\)/u);
  assert.match(script, /closest\('\[role="treeitem"\]'\)/u);
});

test('the toggle icon is a back arrow and tracks the drawer state', () => {
  assert.match(script, /返回会话/u);
  assert.match(script, /会话与项目列表/u);
  assert.doesNotMatch(script, /M4 7h16M4 12h16M4 17h16/u);
});

test('the list page is driven by the shell, not by clicking the host toggle', () => {
  // 会话点击必须只改自己的状态，不能再程序化点应用的开关，否则会打断导航。
  assert.match(script, /function openList\(\)/u);
  assert.match(script, /function closeList\(\)/u);
  const listener = script.slice(script.indexOf('应用先处理完整点击'));
  assert.match(listener, /setTimeout\(closeList, 120\)/u);
  assert.doesNotMatch(listener.slice(0, 400), /button\.click\(\)/u);
});

test('navigation uses native clicks, never a timed synthetic row click or early new-session dismissal', () => {
  assert.doesNotMatch(script, /row\.dispatchEvent\(new MouseEvent/);
  assert.doesNotMatch(script, /swallowClickUntil/);
  assert.match(script, /menu\.addEventListener\('click', activate\)/);
  assert.match(script, /label\.endsWith\('中新建会话'\)/);
  assert.match(style, /margin-inline-end: 8px !important/);
});

test('the model menu keeps its own two levels', () => {
  // 菜单第一级是「模型 / 推理等级」。早先脚本会替用户点「模型」那一行，
  // 结果推理等级整行被跳过，手机上看不到任何强度档位。
  assert.doesNotMatch(script, /expandModelMenu/u);
  assert.doesNotMatch(script, /menuitemradio/u);
  assert.doesNotMatch(script, /querySelectorAll\('\[role="menuitem"\]'\)/u);
});

test('goal clearing relies on the goal bar, not on typing /goal clear', () => {
  // 输入框是 Lexical，execCommand 写不进命令；旧的自造按钮点了没反应。
  assert.doesNotMatch(script, /data-dshm-goal-clear/u);
  assert.doesNotMatch(script, /sendCommand/u);
  assert.match(style, /\[data-goal-bar\] button/u);
});

test('a selected command chip is deleted by the same backspace', () => {
  // Lexical 的 decorator chip 第一下退格只选中、不删除；脚本补发一次退格。
  assert.match(script, /data-composer-command/u);
  assert.match(script, /data-selected/u);
  assert.match(script, /KeyboardEvent\('keydown'/u);
});

test('the icon buttons centre their glyph instead of trusting UA padding', () => {
  const rule = style.slice(style.indexOf('button[aria-label="添加文件或调用指令"]'), style.indexOf('data-goal-bar'));
  assert.match(rule, /padding: 0 !important/u);
  assert.match(rule, /place-items: center !important/u);
  assert.match(rule, /appearance: none !important/u);
});

test('repeated injection stays single-shot', () => {
  const once = injectMobileShell('<html><head></head><body></body></html>');
  assert.equal((once.match(/dshm-mobile-shell/gu) ?? []).length, 1);
  assert.equal((once.match(/id="dshm-mobile"/gu) ?? []).length, 1);
});

test('html previews are re-hosted with srcdoc inside the same sandbox', () => {
  // iOS 不让 sandbox="allow-scripts" 的框架加载父页面的 blob: 地址，HTML 预览整片空白。
  assert.match(script, /iframe\[data-html-preview\]\[src\^="blob:"\]/u);
  assert.match(script, /setAttribute\('srcdoc', text\)/u);
  assert.match(script, /data-dshm-inlined/u);
  // 不放宽隔离：脚本里不能出现给框架加 allow-same-origin 的写法。
  assert.doesNotMatch(script, /allow-same-origin/u);
});

test('the preview drawer is an attachment viewer: no open-in-app, collapse drawn as exit-fullscreen', () => {
  assert.ok(style.includes('[aria-label^="用 "][aria-label$=" 打开"]'));
  assert.match(style, /\[aria-label="收起右侧边栏"\]::before/u);
  assert.match(style, /mask: url\("data:image\/svg\+xml/u);
});

test('the attachment path toolbar is hidden and the html frame fills the reader', () => {
  // 文件名已由标签栏承载；地址、刷新和格式行不再占据手机阅读空间。
  assert.match(style, /\[data-document-preview\] > div:first-child \{\s*display: none !important/u);
  assert.match(style, /\[data-textpreview-path\] \{[^}]*text-overflow: ellipsis !important/u);
  assert.match(style, /\[data-textpreview-tool\] \{[^}]*appearance: none !important/u);
  assert.match(script, /window\.innerHeight - top - safeBottom/u);
});

test('the back arrow never lands on 新会话 and never flashes before the header exists', () => {
  // 只在完整 click 后换页，不能 pointerdown 换页再吞掉用户接下来的新建点击。
  assert.match(script, /menu\.addEventListener\('click', activate\)/u);
  assert.doesNotMatch(script, /menu\.addEventListener\('pointerdown', activate/u);
  // 刷新时标题栏还没渲染：不再把无样式的按钮挂到 body 上。
  assert.doesNotMatch(script, /document\.body\)\.appendChild\(menu\)/u);
  assert.doesNotMatch(style, /data-dshm-anchor="body"/u);
});
