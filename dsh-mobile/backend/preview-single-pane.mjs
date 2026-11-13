// Preserve every open file and the focused file when recovering a saved split.
export function singlePreviewPane(surface, emptyHistory) {
  const layout = surface.layout;
  const panes = [];
  const visit = id => {
    const node = layout.nodes[id];
    if (node.kind === 'pane') panes.push(node);
    else node.children.forEach(visit);
  };
  visit(layout.rootId);
  layout.floats.forEach(visit);
  if (panes.length === 1 && !layout.floats.length) return surface;
  const focused = panes.find(p => p.id === layout.activePaneId);
  const target = focused?.host === 'dock' ? focused : panes[0];
  const tabs = panes.flatMap(p => p.tabs);
  const activeTabId = focused?.activeTabId ?? target.activeTabId ?? tabs[0];
  const pane = {kind: 'pane', id: target.id, host: 'dock', tabs,
    ...(activeTabId ? {activeTabId} : {})};
  return {...surface, history: emptyHistory, layout: {...layout,
    nodes: {[pane.id]: pane}, rootId: pane.id, activePaneId: pane.id, floats: []}};
}

export function patchSinglePreviewPane(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned sidebar changed; review single-pane integration: ' + before.slice(0,60));
    source = source.replace(before, after);
  };
  const mobile = 'globalThis.matchMedia?.("(max-width: 720px)").matches';
  const helper = `function dshmSinglePreview(surface) { return ${mobile} ? (${singlePreviewPane.toString()})(surface, _deepseek_ai_dsh_client_ui_dockkit.EMPTY_HISTORY) : surface; }\n`;
  replace('function readSidebarLayout(sessionId) {', helper + 'function readSidebarLayout(sessionId) {');
  replace('layout: parsed.layout,', 'layout: dshmSinglePreview(parsed).layout,');
  replace('const updated = next(existing ?? createSurface());', 'const updated = dshmSinglePreview(next(existing ?? createSurface()));');
  replace('splitPane: (d, sessionId, paneId, settled) => {', 'splitPane: (d, sessionId, paneId, settled) => { if (' + mobile + ') return;');
  replace('canSplit: (0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout)', 'canSplit: !(' + mobile + ') && (0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout)');
  replace('splitBlock(target) {', 'splitBlock(target) { if (' + mobile + ') return "width";');
  return source;
}
