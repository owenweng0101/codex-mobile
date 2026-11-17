import test from 'node:test';
import assert from 'node:assert/strict';
import {hubHtml} from '../backend/lib/ui.mjs';

const html=hubHtml();

test('tapping the already selected capsule refreshes instead of re-selecting',()=>{
  const branch=/const next = button\.dataset\.tab;\s*\n\s*if\(next === current\)\{ refreshActive\(\); return; \}/.test(html);
  assert.ok(branch,'the active tab must route to refreshActive before switching tabs');
  assert.match(html,/function refreshActive\(\)\{/);
});

test('refresh reloads the current iframe and keeps its own URL on failure',()=>{
  assert.match(html,/frame\.contentWindow\.location\.reload\(\)/);
  assert.match(html,/frame\.src=frame\.src/);
  assert.match(html,/if\(!frame\.dataset\.loaded\)\{entries=null;load\(\);return;\}/,'an entry that never loaded is re-fetched instead of reloaded');
});

test('a DSH reload closes the shell drawer again only when it was closed before',()=>{
  assert.match(html,/frame\.dataset\.refreshDrawer=drawer===null\?'':drawer/);
  assert.match(html,/if\(frame\.dataset\.frame!=='dsh'\|\|state!=='closed'\)return;/);
  // The drawer belongs to the DSH phone shell (mobile.mjs listOpen); the host
  // app's collapse button only re-expands it through the shell's layout pass.
  const shellMenu=html.indexOf("doc.querySelector('[data-dshm-menu]')");
  const hostButton=html.indexOf('button[aria-label="收起侧边栏"]');
  assert.ok(shellMenu>=0,'the shell menu must be the first control the hub tries');
  assert.ok(hostButton>shellMenu,'the host collapse button may only stay as a fallback');
});
