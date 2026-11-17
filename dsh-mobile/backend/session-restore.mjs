// Adapt the pinned UI at serve time; never replace the captured frontend.
export function patchWorkspaceRestoration(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned workspace changed; review session restoration: ' + before);
    source = source.replace(before, after);
  };
  replace('\n\t\t\tmainReference;', '\n\t\t\tmobileRestoration = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)("pending");\n\t\t\tmainReference;');
  replace('initial = "connecting";', 'initial = "connecting";\n\t\t\t\t\tthis.mobileRestoration.set("pending");');
  // Both the already-selected path and the completed restoration can release the gate.
  if (source.split('initial = "done";').length !== 3) throw new Error('Pinned workspace changed; review session restoration completion');
  source = source.replaceAll('initial = "done";', 'initial = "done"; this.mobileRestoration.set("ready");');
  replace('initial = "waiting";\n\t\t\t\t\t\tconsole.warn', 'initial = "waiting";\n\t\t\t\t\t\tthis.mobileRestoration.set(this.mainReference === void 0 ? "error" : "ready");\n\t\t\t\t\t\tconsole.warn');
  // An explicit user navigation wins even if startup restoration is still waiting.
  replace('this.mainReference = reference;', 'this.mainReference = reference;\n\t\t\t\tthis.mobileRestoration.set("ready");');
  replace('className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),', 'className: clsx(WorkspaceBrowser_module_css_default.root, !wide && WorkspaceBrowser_module_css_default.rail),\n\t\t\t\t"data-dshm-workspace-state": list.phase === "ready" && workspaceReady ? "ready" : "loading",');
  return source;
}

// Expose actual initial-history and scroll-layout readiness, not label text.
// Older-history paging does not change openState and must not reopen the splash.
export function patchChatReadiness(source) {
  const before = 'className: ChatView_module_css_default.root,';
  if (source.split(before).length !== 2) throw new Error('Pinned chat changed; review history readiness');
  return source.replace(before, before + '\n\t\t\t\t\t\t"data-dshm-history-state": openState,\n\t\t\t\t\t\t"data-dshm-history-positioned": scroll.initialized ? "" : void 0,');
}

export function patchConversationRestoration(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned conversation changed; review session restoration: ' + before);
    source = source.replace(before, after);
  };
  replace('const shellPhase = session === void 0', 'const restoration = props.useMobileRestoration((state) => state);\n\t\t\tconst restoring = globalThis.matchMedia?.("(max-width: 720px)").matches && sessionId === void 0 && restoration !== "ready";\n\t\t\tconst shellPhase = session === void 0');
  replace('const phase = settling ? "settling" : hero ? "hero" : "active";', 'const phase = restoring || settling ? "settling" : hero ? "hero" : "active";');
  replace('className: ConversationRoot_module_css_default.root,', 'className: ConversationRoot_module_css_default.root,\n\t\t\t\t"data-dshm-conversation-state": restoring ? restoration : settling || openState === "loading" || sessionId !== void 0 && session === void 0 ? "loading" : openState === "error" ? "error" : "ready",');
  replace('children: [renderSlot("conversation.header", {}), renderFactorySlot("conversation.content", {', 'children: [renderSlot("conversation.header", {}), restoring ? (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t"data-dshm-session-restore": restoration,\n\t\t\t\t\trole: "status",\n\t\t\t\t\tchildren: restoration === "error" ? "会话恢复失败，请返回列表重试" : null\n\t\t\t\t}) : renderFactorySlot("conversation.content", {');
  replace('name: "main.conversation",\n\t\t\t\tchildren:', 'name: "main.conversation",\n\t\t\t\tinject: () => ({ hooks: { mobileRestoration: workspaceNavigation.mobileRestoration } }),\n\t\t\t\tchildren:');
  return source;
}
