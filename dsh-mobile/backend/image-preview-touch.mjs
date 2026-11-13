// Adapter for the pinned viewer's own zoom state and controls (mobile only).
export function bindImagePreviewTouch(node, getScale, showZoom, commit, showControls) {
  let state = null, changed = false, image = false, gestureScale = null;
  const supported = () => window.matchMedia('(max-width: 820px)').matches
    && !!node.querySelector('[data-image-preview], [data-pdf-preview]');
  const point = touches => touches.length > 1 ? {x:(touches[0].clientX+touches[1].clientX)/2,y:(touches[0].clientY+touches[1].clientY)/2} : {x:touches[0].clientX,y:touches[0].clientY};
  const distance = touches => Math.hypot(touches[1].clientX-touches[0].clientX,touches[1].clientY-touches[0].clientY);
  const begin = touches => {state={point:point(touches),scale:getScale(),distance:touches.length>1?Math.max(1,distance(touches)):null};};
  const start = event => {
    if (!window.matchMedia('(max-width: 820px)').matches) return;
    image = !!node.querySelector('[data-image-preview]');
    if (!image && !node.querySelector('[data-pdf-preview]')) return;
    if (!image && event.touches.length < 2) { state=null; return; }
    begin(event.touches);showControls();
    if(event.touches.length>1)gestureScale=null;
    // Contained images are draggable on desktop. Stop WebKit's native image
    // drag from cancelling this touch sequence before the second finger lands.
    if(image || event.touches.length>1)event.preventDefault();
  };
  const move = event => {
    if(!state||!event.touches.length)return;
    event.preventDefault();
    const next=point(event.touches);
    if(event.touches.length>1&&state.distance!==null){showZoom(state.scale*distance(event.touches)/state.distance,state.point.x,state.point.y);changed=true;}
    node.scrollLeft+=state.point.x-next.x;node.scrollTop+=state.point.y-next.y;
    state.point=next;
  };
  const end = event => {
    if(changed){commit(getScale());changed=false;}
    if(event.touches.length && (image || event.touches.length > 1))begin(event.touches);else state=null;
  };
  const gestureStart = event => {
    if(!supported())return;
    event.preventDefault();showControls();
    gestureScale=state?.distance!=null?null:getScale();
  };
  const gestureChange = event => {
    if(!supported())return;
    event.preventDefault();
    if(gestureScale===null||state?.distance!=null)return;
    showZoom(gestureScale*event.scale,event.clientX,event.clientY);changed=true;
  };
  const gestureEnd = event => {
    if(gestureScale===null)return;
    event.preventDefault();gestureScale=null;
    if(changed){commit(getScale());changed=false;}
  };
  const options={passive:false,capture:true};
  node.addEventListener('touchstart',start,options);node.addEventListener('touchmove',move,options);
  node.addEventListener('touchend',end,options);node.addEventListener('touchcancel',end,options);
  node.addEventListener('gesturestart',gestureStart,options);node.addEventListener('gesturechange',gestureChange,options);node.addEventListener('gestureend',gestureEnd,options);
  return ()=>{state=null;gestureScale=null;node.removeEventListener('touchstart',start,true);node.removeEventListener('touchmove',move,true);node.removeEventListener('touchend',end,true);node.removeEventListener('touchcancel',end,true);node.removeEventListener('gesturestart',gestureStart,true);node.removeEventListener('gesturechange',gestureChange,true);node.removeEventListener('gestureend',gestureEnd,true);};
}

export function patchImagePreviewTouch(source) {
  const marker = 'node.addEventListener("wheel", wheel, { passive: false });';
  const cleanup = 'node.removeEventListener("wheel", wheel);';
  if (source.split(marker).length !== 2 || source.split(cleanup).length !== 2) throw new Error('Pinned image viewer changed; review touch integration');
  const clamp = 'Math.max(_deepseek_ai_dsh_client_ui_primitives.DOCUMENT_ZOOM.minimum, next)';
  if (source.split(clamp).length !== 2) throw new Error('Pinned zoom limits changed; review touch integration');
  source = source.replace(clamp, 'Math.max(0.05, next)');
  return source.replace(marker, 'const releaseMobileTouch = ('+bindImagePreviewTouch.toString()+')(node, () => zoomRef.current, showZoom, scale => { props.onPreference({kind:"fixed",scale}); scheduleControlsHide(); }, showControls);\n'+marker)
    .replace(cleanup,'releaseMobileTouch();\n'+cleanup);
}
