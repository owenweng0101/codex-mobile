// Keep the normal 20-message opening request. Only an unreadable first window
// may request at most two native 40-message pages (100 messages total, not a byte
// or raw-event cap). Native source groups and realtime baselines remain intact.
export function createInitialReadableWindow({schedule, cancel, changed, maxPages = 2}) {
  let input, epoch = 0, generation = 0, frame = null, disposed = false, pending = false, settled = null;
  let done = false, pages = 0, reason = null, error = null;
  const clearFrame = () => {if (frame !== null) cancel(frame); frame = null;};
  const finish = value => {if (done) return; done = true; reason = value; clearFrame(); if (!disposed) changed();};
  const later = fn => {if (frame !== null || disposed) return; frame = schedule(() => {frame = null; fn();});};
  const step = () => {
    if (disposed || done || pending || input?.loadingOlder || input?.openState !== 'open') return;
    if (input.readable || !input.hasMore) {finish('ready'); return;}
    if (settled !== null) {
      const {before, result} = settled; settled = null;
      // The raw cursor, not the first visible node, detects a failed/no-op page:
      // hidden protocol rows can advance history without moving visible order.
      const advanced = Number.isFinite(result?.beforeSeq) && Number.isFinite(result?.afterSeq)
        ? result.afterSeq < result.beforeSeq : before !== null && input.firstSeq !== null && input.firstSeq < before;
      if (!advanced) {finish('no-progress'); return;}
    }
    if (pages >= maxPages) {finish('limited'); return;}
    const token = epoch, mount = generation, before = input.firstSeq, load = input.loadOlder;
    let started = false; pending = true;
    Promise.resolve().then(() => {
      if (disposed || done || epoch !== token || generation !== mount) return;
      started = true; pages++; changed(); return load();
    }).then(result => {
      if (epoch !== token) return;
      pending = false;
      if (started) settled = {before, result};
      // Effect replay can reattach to this same native request. It never resets
      // the spent budget or reader intent, nor dispatches a duplicate page.
      if (!disposed && !done) later(step);
    }, failure => {
      if (epoch !== token) return;
      pending = false; error = failure?.message || String(failure); finish('error');
    });
  };
  return {
    update(next) {
      disposed = false;
      const reopening = input && input.openState !== next.openState && (next.openState === 'cold' || next.openState === 'loading' || input.openState === 'error' && next.openState === 'open');
      if (!input || input.sessionId !== next.sessionId || reopening || input.openState === 'open' && next.openState !== 'open') {
        epoch++; generation++; clearFrame(); pending = false; settled = null; done = false; pages = 0; reason = null; error = null;
      }
      input = next;
      if (done) return;
      if (next.openState === 'error') {finish('native-error'); return;}
      if (next.openState !== 'open') return;
      if (next.readable || !next.hasMore) {finish('ready'); return;}
      if (!pending && !next.loadingOlder) later(step);
    },
    status(next) {
      const own = input?.sessionId === next.sessionId && !(input.openState === 'error' && next.openState === 'open');
      const unreadable = next.openState === 'open' && !next.readable && next.hasMore;
      return {
        waiting: unreadable && !(own && done),
        message: !unreadable || !own ? null : reason === 'limited' ? '这段暂无对话正文'
          : reason === 'no-progress' ? '暂未加载到更早对话，可重试加载更多'
          : reason === 'error' ? '加载失败：' + error : null,
      };
    },
    interrupt() {generation++; finish('reader');},
    dispose() {disposed = true; generation++; clearFrame();},
    get pages() {return pages;},
  };
}

// Match the content inputs that the native pending user bubbles actually render.
export function isInitialPendingInputReadable(item, native) {
  if (native.isLocalSubmission(item)) {
    if (item.placement !== 'transcript' && item.placement !== 'steering') return false;
    return typeof item.text === 'string' && item.text.trim() !== '' || (item.attachments?.length ?? 0) > 0;
  }
  const parts = native.contentParts(item.content ?? []);
  return parts.text.trim() !== '' || parts.attachments.length > 0 || parts.rest.length > 0;
}

// Match the native ChatNodeSeat's response-row visibility without expanding a
// reader's folded process. The helpers and per-node process state stay native.
export function isInitialChatNodeReadable(node, key, nodes, policy, store, deferCollapse, native) {
  if (node === undefined || !native.isVisibleChatNode(node)) return false;
  const reply = node.kind === 'assistant-step' && native.hasAssistantReplyContent(node.data.blocks);
  if (node.kind !== 'user' && node.kind !== 'steering' && !reply) return false;
  if (node.kind === 'user' || node.kind === 'steering') {
    const parts = native.contentParts(node.data.content ?? []);
    if (parts.text.trim() === '' && parts.attachments.length === 0 && parts.rest.length === 0) return false;
  }
  const process = nodes.process(key), spec = process?.spec;
  if (!spec || !policy.foldCompletedTurns || process.turn !== spec.turn || !process.turnStarted && !process.turnClosed) return true;
  if (reply && policy.foldedReplies === 'all') return true;
  const live = !process.turnClosed;
  const open = live || process.hasInterleavedInput === true || native.turnProcessAlwaysOpen(node)
    || native.turnProcessOpen(store, spec, nodes.bottomSource(key).getSnapshot() === true && deferCollapse);
  const member = !native.isAtOrOutside(node, 'turn') && node.anchorSeq >= spec.processStartSeq
    && (live || spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq);
  return !member || open;
}

export function useInitialReadableWindow(react, input) {
  const [, redraw] = react.useState(0);
  const owner = react.useRef(null);
  if (owner.current === null) owner.current = createInitialReadableWindow({
    schedule: fn => requestAnimationFrame(fn), cancel: id => cancelAnimationFrame(id), changed: () => redraw(value => value + 1),
  });
  const controller = owner.current;
  react.useLayoutEffect(() => {controller.update(input);}, [controller, input.sessionId, input.openState, input.readable, input.hasMore, input.loadingOlder, input.firstSeq, input.loadOlder]);
  react.useEffect(() => () => controller.dispose(), [controller]);
  return {...controller.status(input), interrupt: controller.interrupt};
}

export function patchInitialReadableWindow(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned chat changed; review initial readable window: ' + before);
    source = source.replace(before, after);
  };
  replace('function ChatView({', createInitialReadableWindow.toString() + '\n\t\t' + isInitialPendingInputReadable.toString() + '\n\t\t' + isInitialChatNodeReadable.toString() + '\n\t\t' + useInitialReadableWindow.toString() + '\n\t\tfunction ChatView({ useStore,');
  replace('if (saved === null) {\n\t\t\t\t\tthis.followTail();',
    'if (saved === null || globalThis.matchMedia?.("(max-width: 720px)").matches && this.viewport.anchor(saved.anchorKey) === null) {\n\t\t\t\t\tthis.followTail();');
  replace('const scroll = useChatScroll({',
    'const mobilePresentation = usePresentation((policy) => policy);\n\t\t\tconst mobileChatState = useStore((state) => state);\n\t\t\tconst mobileInitialWindow = useInitialReadableWindow(react, { sessionId, openState, hasMore, loadingOlder, firstSeq, loadOlder, readable: pendingInputs.some((item) => isInitialPendingInputReadable(item, { isLocalSubmission, contentParts })) || order.some((key) => isInitialChatNodeReadable(nodeStore.get(key), key, nodeStore, mobilePresentation, mobileChatState, deferCollapse, { isVisibleChatNode, hasAssistantReplyContent, turnProcessAlwaysOpen, turnProcessOpen, isAtOrOutside, contentParts })) });\n\t\t\tconst scroll = useChatScroll({\n\t\t\t\tonInitialReadIntent: mobileInitialWindow.interrupt,');
  replace('transcriptView } = input;', 'transcriptView, onInitialReadIntent } = input;');
  replace('if (!content.current.opened) return;\n\t\t\t\t\t\tif (!event.movedByReader',
    'if (!content.current.opened) return;\n\t\t\t\t\t\tif (event.movedByReader) content.current.input.onInitialReadIntent?.();\n\t\t\t\t\t\tif (!event.movedByReader');
  replace('intent: () => {\n\t\t\t\t\t\tcancelPendingFollow();', 'intent: () => {\n\t\t\t\t\t\tcontent.current.input.onInitialReadIntent?.();\n\t\t\t\t\t\tcancelPendingFollow();');
  replace('transcriptView,\n\t\t\t\t\t...navigationInput', 'transcriptView,\n\t\t\t\t\tonInitialReadIntent,\n\t\t\t\t\t...navigationInput');
  replace('"data-dshm-history-state": openState,', '"data-dshm-history-state": mobileInitialWindow.waiting ? "loading" : openState,');
  replace('children: loadingOlder ? t("loading") : t("chat.loadOlder")', 'children: loadingOlder ? "加载中…" : "加载更多"');
  replace('hasMore && (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\t\t\t\tclassName: ChatView_module_css_default.older,',
    'mobileInitialWindow.message !== null && (0, react_jsx_runtime.jsx)("div", { className: ChatView_module_css_default.hint, role: "status", children: mobileInitialWindow.message }),\n\t\t\t\t\t\t\t\t\thasMore && (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\t\t\t\tclassName: ChatView_module_css_default.older,');
  replace('session.loadOlder();', 'const beforeSeq = session.baseSeq; return session.loadOlder().then(() => ({ beforeSeq, afterSeq: session.baseSeq }));');
  return source;
}
