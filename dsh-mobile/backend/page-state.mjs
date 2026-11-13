// Only explicit mobile navigation writes this per-tab state. Backgrounding,
// reconnecting and shell layout passes must never turn a list into a chat.
export function createMobilePageState(options = {}) {
  let storage = options.storage, history = options.history;
  if (!Object.hasOwn(options, 'storage')) try { storage = globalThis.sessionStorage; } catch {}
  if (!Object.hasOwn(options, 'history')) try { history = globalThis.history; } catch {}
  const key = 'dsh-mobile-current-page-v1';
  const valid = value => value === 'list' || value === 'chat';
  let page = 'chat';
  try { const saved = storage?.getItem(key); if (valid(saved)) page = saved; } catch {}
  try { const saved = history?.state?.dshMobilePage; if (valid(saved)) page = saved; } catch {}
  return {
    get page() { return page; },
    setPage(value) {
      if (!valid(value)) throw new TypeError('Invalid mobile page');
      page = value;
      try { storage?.setItem(key, value); } catch {}
      try { history?.replaceState?.({ ...history.state, dshMobilePage: value }, ''); } catch {}
    },
  };
}
