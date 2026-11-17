import { patchImagePreviewTouch } from './image-preview-touch.mjs';
import { patchSinglePreviewPane } from './preview-single-pane.mjs';
import { patchPdfCompatibility } from './pdf-compat.mjs';
import { patchWorkspaceRestoration, patchConversationRestoration, patchChatReadiness } from './session-restore.mjs';
import { patchConversationReloadSafety } from './reload-safety.mjs';
import { patchWorkspaceDraftNavigation } from './draft-navigation.mjs';
import { patchMobileComposerActions } from './composer-actions.mjs';
import { patchMobileHistoryWindow } from './history-window.mjs';
import { patchInitialReadableWindow } from './initial-readable-window.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Explicit mobile-owned list. Desktop plugin installation never extends it.
const allowed = new Set(JSON.parse(await readFile(new URL('./mobile-modules.json', import.meta.url), 'utf8')));
// Exact lazy assets referenced by the already pinned modules, not new plugins.
const lazyAssets = JSON.parse(await readFile(new URL('./mobile-assets.json', import.meta.url), 'utf8'));
export async function buildMobileProfile(root, source, manifest) {
  const pattern = /globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s;
  const match = source.match(pattern);
  if (!match) throw new Error('Pinned frontend boot manifest missing');
  const boot = JSON.parse(match[1]);
  const originalIds = new Set(boot.entries.map(e => e.id));
  const entries = boot.entries.filter(e => allowed.has(e.id));
  if (entries.length !== allowed.size) throw new Error('Mobile module list does not match pinned snapshot');
  for (const entry of entries) for (const dependency of [...(entry.inject || []), ...(entry.external || []).map(x => x.replace(/\/client$/, ''))]) {
    if (originalIds.has(dependency) && !allowed.has(dependency)) throw new Error(`Missing mobile dependency: ${entry.id} -> ${dependency}`);
  }
  const resources = {}, bodies = new Map();
  const lazyBodies = [];
  for (const key of lazyAssets) {
    const record = manifest.resources[key];
    if (!record) throw new Error('Missing pinned lazy asset: ' + key);
    let body = await readFile(resolve(root, record.file));
    if (createHash('sha256').update(body).digest('hex') !== record.sha256) throw new Error('Pinned lazy asset hash mismatch: ' + key);
    if (key.includes('/client.pdf.js?')) body = Buffer.from(patchPdfCompatibility(body.toString()));
    lazyBodies.push({key, record, body, hash:createHash('sha256').update(body).digest('hex')});
  }
  for (const entry of entries) {
    const key = '/' + entry.url, record = manifest.resources[key];
    if (!record) throw new Error('Missing pinned mobile module: ' + entry.id);
    let body = await readFile(resolve(root, record.file));
    const patch = entry.id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' ? patchImagePreviewTouch
      : entry.id === '@deepseek-ai/dsh-client-ui-sidebar-right' ? patchSinglePreviewPane
      : entry.id === '@deepseek-ai/dsh-client-ui-workspace' ? source => patchWorkspaceDraftNavigation(patchWorkspaceRestoration(source))
      : entry.id === '@deepseek-ai/dsh-client-ui-conversation' ? source => patchMobileComposerActions(patchConversationReloadSafety(patchConversationRestoration(source)))
      : entry.id === '@deepseek-ai/dsh-client-ui-chat' ? source => patchInitialReadableWindow(patchChatReadiness(source))
      : entry.id === '@deepseek-ai/dsh-api-session-controller' ? patchMobileHistoryWindow : null;
    if (patch) {
      body = Buffer.from(patch(body.toString()));
      if (entry.id === '@deepseek-ai/dsh-client-ui-sidebar-documentpreview') {
        // The loader gives sibling chunks the owner's revision. Include their
        // contents in that revision so iOS never reuses an older cached chunk.
        body = Buffer.concat([body, Buffer.from('\n// mobile lazy assets: '+lazyBodies.map(asset=>asset.hash).join(',')+'\n')]);
      }
      const hash = createHash('sha256').update(body).digest('hex');
      entry.url = entry.url.replace(/&rev=[^&]+/, '&rev=' + hash.slice(0,16));
      entry.rev = hash.slice(0,16);
      resources['/' + entry.url] = { ...record, sha256: hash };
      bodies.set('/' + entry.url, body);
    } else {
      resources[key] = record;
      bodies.set(key, body);
    }
  }
  for (const asset of lazyBodies) {
    const owner = entries.find(entry=>asset.key.startsWith('/plugins/'+entry.id+'/'));
    if (!owner) throw new Error('Missing mobile owner for lazy asset: '+asset.key);
    const key = asset.key.replace(/([?&]rev=)[^&]+/, '$1'+owner.rev);
    const {body, record, hash} = asset;
    resources[key] = {...record, sha256:hash};
    bodies.set(key, body);
  }
  const batches = [];
  for (const batch of boot.batches) {
    const ids = batch.entries.filter(id => allowed.has(id));
    if (!ids.length) continue;
    // Rebuild from reviewed per-module files, never from the desktop host.
    const body = Buffer.concat(ids.flatMap(id => [bodies.get('/' + entries.find(e => e.id === id).url), Buffer.from('\n;\n')]));
    const hash = createHash('sha256').update(body).digest('hex');
    const url = 'plugins/??mobile-' + batch.phase + '.js&rev=' + hash.slice(0,16);
    resources['/' + url] = { type: 'text/javascript; charset=utf-8', sha256: hash };
    bodies.set('/' + url, body);
    batches.push({ ...batch, url, rev: hash.slice(0,16), entries: ids });
  }
  const updated = { ...boot, rev: createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0,16), entries, batches };
  let html = source.replace(pattern, 'globalThis["__DSH_BOOT__"] = ' + JSON.stringify(updated) + '</script>');
  html = html.replace(/<link\b[^>]*href="plugins\/[^\"]*"[^>]*>/g, '');
  html = html.replace(/<script\b[^>]*src="plugins\/[^\"]*"[^>]*><\/script>/g, '');
  const tags = batches.map(b => b.phase === 'bootstrap'
    ? `<script src="${b.url.replaceAll('&','&amp;')}"></script>`
    : `<link rel="preload" as="script" href="${b.url.replaceAll('&','&amp;')}">`).join('');
  html = html.replace('<link rel="manifest"', '<link crossorigin="use-credentials" rel="manifest"');
  html = html.replace('<script>globalThis["__DSH_BOOT__"]', tags + '<script>globalThis["__DSH_BOOT__"]');
  return { html, resources, bodies, entries: entries.map(e => e.id), originalCount: boot.entries.length };
}
