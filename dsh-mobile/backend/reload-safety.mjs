// Draft attachments are memory-owned in the pinned UI. Neither an upload receipt
// nor persisted text restores their selection after reload. Never inspect layout:
// the hub may ask while this iframe is hidden behind another tab.
export function isDshMobileReloadSafe(document, view = globalThis) {
  try {
    const native = view.__dshMobileNativeReloadSafe;
    if (native !== undefined && (typeof native !== 'function' || native() !== true)) return false;
  } catch { return false; }
  return !document.querySelector([
    '[data-composer-card] [class~="pNt0EW_rail"]',
    '[data-composer-card] button[aria-busy="true"]',
    '[data-composer-card] button[data-sending]',
    '[data-composer-card] [data-composer-composing]',
    '[data-composer-card] [data-composer-input][data-phase="adjudicating"]',
    '[data-composer-card] [data-composer-input][data-phase="submitting"]',
    '[data-composer-card] [data-composer-input][data-phase="sending"]',
  ].join(', '));
}

// Expose only a synchronous boolean, never the resident draft objects. This
// reads every retained native input, including sessions no longer in the DOM.
export function installDshNativeReloadSafety(controller, view) {
  const registration = Symbol.for('dsh.mobile.reload-safety.register');
  let aggregate = view.__dshMobileNativeReloadSafe;
  if (typeof aggregate?.[registration] !== 'function') {
    const previous = aggregate, checks = new Set();
    aggregate = () => {
      try {
        if (previous !== undefined && (typeof previous !== 'function' || previous() !== true)) return false;
        for (const check of checks) if (check() !== true) return false;
        return true;
      } catch { return false; }
    };
    // Only registration is shared across evaluated plugin instances. The Set
    // and controller objects stay inside closures, not on the public window.
    Object.defineProperty(aggregate, registration, {value: check => {
      checks.add(check);
      let active = true;
      return () => {
        if (!active) return; active = false; checks.delete(check);
        if (checks.size !== 0 || view.__dshMobileNativeReloadSafe !== aggregate) return;
        if (previous === undefined) delete view.__dshMobileNativeReloadSafe;
        else view.__dshMobileNativeReloadSafe = previous;
      };
    }});
    view.__dshMobileNativeReloadSafe = aggregate;
  }
  const safe = () => {
    try {
      if (controller.draftAttachments.size > 0 || controller.pendingFileUploads.size > 0) return false;
      for (const shell of controller.input.mobileReloadShells) {
        const state = shell.state.getSnapshot();
        if (!['plain', 'claimed'].includes(state.phase) || state.attachmentIds.length > 0 || shell.editor.isComposing()
          || shell.editor.getRootElement()?.hasAttribute('data-composer-composing')) return false;
      }
      return true;
    } catch { return false; }
  };
  return aggregate[registration](safe);
}

export function patchConversationReloadSafety(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned conversation changed; review reload safety: ' + before);
    source = source.replace(before, after);
  };
  replace('shells = /* @__PURE__ */ new WeakMap();', 'shells = /* @__PURE__ */ new WeakMap();\n\t\t\tmobileReloadShells = new Set();');
  replace('this.shells.set(binding, shell);', 'this.shells.set(binding, shell);\n\t\t\t\tthis.mobileReloadShells.add(shell);');
  replace('this.shells.delete(binding);', 'this.shells.delete(binding);\n\t\t\t\t\t\tthis.mobileReloadShells.delete(shell);');
  replace('this.input = config.input;', 'this.input = config.input;\n\t\t\t\tctx.effect(() => (' + installDshNativeReloadSafety.toString() + ')(this, globalThis), "mobile reload safety");');
  return source;
}
