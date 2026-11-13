// Runs inside the existing opaque HTML-preview iframe; no parent access or
// additional sandbox permissions. Ordinary one-finger scrolling stays native.
export function installPreviewZoom() {
  const root = document.documentElement;
  if (root.hasAttribute('data-dshm-zoom')) return;
  let scale = 1, pinch = null, gesture = null, pan = null;
  const clamp = value => Math.min(4, Math.max(0.2, value));
  const center = touches => ({ x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 });
  const distance = touches => Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
  const begin = point => {
    // Freeze the responsive layout width so pinch scales the document instead
    // of reflowing its text on every movement.
    if (!root.style.width) root.style.width = window.innerWidth + 'px';
    return { scale, x: (window.scrollX + point.x) / scale, y: (window.scrollY + point.y) / scale };
  };
  const apply = (value, anchor, point) => {
    scale = clamp(value);
    root.style.setProperty('zoom', String(scale));
    root.setAttribute('data-dshm-zoom', String(scale));
    window.scrollTo(Math.max(0, anchor.x * scale - point.x), Math.max(0, anchor.y * scale - point.y));
  };
  root.setAttribute('data-dshm-zoom', '1');
  const style = document.createElement('style');
  style.textContent = 'html{touch-action:none!important;overflow:auto!important;overscroll-behavior:contain}';
  document.head.append(style);
  const options = { passive: false, capture: true };
  document.addEventListener('touchstart', event => {
    if (event.touches.length === 1) {
      if (event.target.closest?.('a,button,input,textarea,select,[contenteditable]')) return;
      pan = {x:event.touches[0].clientX,y:event.touches[0].clientY}; return;
    }
    if (event.touches.length !== 2) return;
    pan = null; event.preventDefault();
    pinch = { ...begin(center(event.touches)), distance: Math.max(1, distance(event.touches)) };
  }, options);
  document.addEventListener('touchmove', event => {
    if (event.touches.length === 1 && pan) {
      event.preventDefault(); const t=event.touches[0];
      window.scrollTo(window.scrollX+pan.x-t.clientX,window.scrollY+pan.y-t.clientY);
      pan={x:t.clientX,y:t.clientY}; return;
    }
    if (event.touches.length !== 2 || !pinch) return;
    event.preventDefault();
    apply(pinch.scale * distance(event.touches) / pinch.distance, pinch, center(event.touches));
  }, options);
  for (const type of ['touchend', 'touchcancel']) document.addEventListener(type, event => {
    if (event.touches.length < 2) pinch = null;
    pan = event.touches.length === 1 ? {x:event.touches[0].clientX,y:event.touches[0].clientY} : null;
  }, options);
  // Safari can report its native gesture events in addition to touch events.
  document.addEventListener('gesturestart', event => {
    event.preventDefault();
    gesture = begin({ x: event.clientX || innerWidth / 2, y: event.clientY || innerHeight / 2 });
  }, options);
  document.addEventListener('gesturechange', event => {
    event.preventDefault();
    if (!pinch && gesture && Number.isFinite(event.scale)) apply(gesture.scale * event.scale, gesture, { x: event.clientX || innerWidth / 2, y: event.clientY || innerHeight / 2 });
  }, options);
  document.addEventListener('gestureend', event => { event.preventDefault(); gesture = null; }, options);
}

export const PREVIEW_ZOOM_SCRIPT = '(' + installPreviewZoom.toString() + ')();';
