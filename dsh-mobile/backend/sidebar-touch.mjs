// Never synthesize row clicks. Ignore a compatibility click after a scroll/drag,
// while allowing the very next deliberate tap and keyboard activation.
export function bindSidebarTouchGuard(target, isEnabled, getSidebar, now = Date.now) {
  let gesture = null;
  const inside = node => !!node && !!getSidebar()?.contains(node);
  const handlers = {
    pointerdown(event) {
      gesture = isEnabled() && inside(event.target) ? {
        id:event.pointerId, x:event.clientX, y:event.clientY, moved:false, ended:0
      } : null;
    },
    pointermove(event) {
      if (gesture?.id === event.pointerId && Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>10) gesture.moved=true;
    },
    pointerup(event) { if (gesture?.id === event.pointerId) gesture.ended=now(); },
    pointercancel(event) { if (gesture?.id === event.pointerId) { gesture.moved=true; gesture.ended=now(); } },
    scroll(event) { if (gesture && inside(event.target)) gesture.moved=true; },
    click(event) {
      if (!isEnabled() || !inside(event.target) || !gesture || event.detail===0) return;
      const suppress=gesture.moved && (!gesture.ended || now()-gesture.ended<800);
      gesture=null;
      if (suppress) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
  };
  for (const [name,handler] of Object.entries(handlers)) target.addEventListener(name,handler,true);
  return () => { for (const [name,handler] of Object.entries(handlers)) target.removeEventListener(name,handler,true); };
}
