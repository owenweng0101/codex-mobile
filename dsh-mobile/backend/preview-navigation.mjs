// A close or a newer file click supersedes every pending preview transition.
export function bindPreviewNavigation(document, root, mobile) {
  let pending = [];
  const cancel = () => {
    for (const timer of pending) clearTimeout(timer);
    pending = [];
  };
  const open = () => {
    const col = document.querySelector('[data-rightbar-col]');
    if (col?.querySelectorAll('[role="tab"]').length) root.setAttribute('data-dshm-rightbar', 'open');
  };
  const click = event => {
    if (!mobile.matches || !(event.target instanceof Element)) return;
    if (event.target.closest('[data-rightbar-col] [data-sidebar-right-toggle], [data-rightbar-col] button[aria-label="收起右侧边栏"]')) {
      cancel();
      pending = [setTimeout(() => root.setAttribute('data-dshm-rightbar', 'closed'), 120)];
      return;
    }
    if (!event.target.closest('[aria-label^="在侧边栏"], button[class*="fileLink"], button[class*="fileMention"]')) return;
    cancel();
    pending = [setTimeout(open, 150), setTimeout(open, 600)];
  };
  document.addEventListener('click', click, true);
  return () => { cancel(); document.removeEventListener('click', click, true); };
}
