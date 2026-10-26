// Scoped to the preview surface; toolbar controls keep their normal gestures.
export function attachImageGestures(image) {
  const surface = image?.parentElement;
  if (!surface) return () => {};
  const old = { touchAction: surface.style.touchAction, transform: image.style.transform, origin: image.style.transformOrigin };
  let scale = 1, x = 0, y = 0, gesture = null, lastTap = null, tap = null;
  surface.style.touchAction = 'none';
  image.style.transformOrigin = 'center center';
  const controls = target => target?.closest?.('button,[role="menuitem"],a');
  const point = touches => {
    const a = touches[0], b = touches[1] || a;
    const rect = surface.getBoundingClientRect();
    return { x: (a.clientX + b.clientX) / 2 - rect.left - rect.width / 2,
      y: (a.clientY + b.clientY) / 2 - rect.top - rect.height / 2,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
  };
  const draw = () => {
    // Keep the fitted image reachable, including after rotating the phone.
    const limitX = Math.max(0, (image.offsetWidth * scale - surface.clientWidth) / 2);
    const limitY = Math.max(0, (image.offsetHeight * scale - surface.clientHeight) / 2);
    x = Math.max(-limitX, Math.min(limitX, x));
    y = Math.max(-limitY, Math.min(limitY, y));
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const begin = touches => { gesture = touches.length ? { ...point(touches), scale, tx: x, ty: y, count: touches.length } : null; };
  const start = event => {
    if (controls(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    begin(event.touches);
    tap = event.touches.length === 1 ? { ...point(event.touches), time: Date.now() } : null;
    if (event.touches.length > 1) lastTap = null;
  };
  const move = event => {
    if (!gesture) return;
    event.preventDefault(); event.stopPropagation();
    if (event.touches.length !== gesture.count) { begin(event.touches); return; }
    const p = point(event.touches);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > 8) tap = null;
    scale = gesture.count > 1 && gesture.distance > 0
      ? Math.max(1, Math.min(8, gesture.scale * p.distance / gesture.distance)) : gesture.scale;
    const ratio = scale / gesture.scale;
    x = p.x - (gesture.x - gesture.tx) * ratio;
    y = p.y - (gesture.y - gesture.ty) * ratio;
    draw();
  };
  const end = event => {
    if (!gesture) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.touches.length && tap && Date.now() - tap.time < 300) {
      if (lastTap && tap.time - lastTap.time < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 24) {
        scale = 1; x = y = 0; draw(); lastTap = null;
      } else lastTap = tap;
    }
    tap = null; begin(event.touches);
  };
  const cancel = () => { gesture = tap = lastTap = null; };
  const reset = () => { cancel(); scale = 1; x = y = 0; draw(); };
  const events = { touchstart: start, touchmove: move, touchend: end, touchcancel: cancel };
  for (const [name, handler] of Object.entries(events)) surface.addEventListener(name, handler, { passive: false });
  image.addEventListener('load', reset);
  return () => {
    for (const [name, handler] of Object.entries(events)) surface.removeEventListener(name, handler);
    image.removeEventListener('load', reset);
    surface.style.touchAction = old.touchAction;
    image.style.transform = old.transform; image.style.transformOrigin = old.origin;
  };
}
