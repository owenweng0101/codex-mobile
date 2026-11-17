// The pinned session scope owns File objects and releases them on the last
// native reference. Prevent destructive navigation before it creates/retains a
// different session; do not change the native reference/disposal lifecycle.
export function installDshDraftNavigationGuard({document, view, isMobile, isSafe}) {
  let toast, timer;
  const allow = (currentId, targetId) => {
    if (!isMobile() || typeof currentId === 'string' && currentId === targetId) return true;
    let safe = false;
    try { safe = isSafe() === true; } catch {}
    if (safe) return true;
    if (!toast?.isConnected) {
      toast = document.createElement('div');
      toast.setAttribute('data-dshm-draft-warning', '');
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      document.body.appendChild(toast);
    }
    toast.textContent = document.querySelector('[data-composer-card] [class~="pNt0EW_rail"]')
      ? '请先发送或移除附件，再切换会话'
      : '消息正在提交或输入尚未完成，请稍后切换会话';
    view.clearTimeout(timer);
    timer = view.setTimeout(() => toast?.remove(), 4500);
    return false;
  };
  view.__dshMobileAllowNavigation = allow;
  return () => {
    view.clearTimeout(timer); toast?.remove();
    if (view.__dshMobileAllowNavigation === allow) delete view.__dshMobileAllowNavigation;
  };
}

export function patchWorkspaceDraftNavigation(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned workspace changed; review draft navigation: ' + before);
    source = source.replace(before, after);
  };
  const guard = 'if (globalThis.__dshMobileAllowNavigation?.(this.mainReference?.sessionId) === false) return;';
  replace('openSession(target) {', 'openSession(target) {\n\t\t\t\tif (globalThis.__dshMobileAllowNavigation?.(this.mainReference?.sessionId, target) === false) return;');
  replace('async openWorkspaceSession(workspaceId, beforeOpen, reuse) {', 'async openWorkspaceSession(workspaceId, beforeOpen, reuse) {\n\t\t\t\t' + guard);
  replace('startSession(workspaceId, options) {', 'startSession(workspaceId, options) {\n\t\t\t\t' + guard);
  // Creation was allowed before its await, but a user can add an attachment
  // while it is in flight. Do not release that newly unsafe draft on completion.
  replace('if (navigation.aborted) return;\n\t\t\t\tthis.replaceMain(sessionId, navigation, "reveal", beforeOpen);',
    'if (navigation.aborted) return;\n\t\t\t\t' + guard + '\n\t\t\t\tthis.replaceMain(sessionId, navigation, "reveal", beforeOpen);');
  return source;
}
