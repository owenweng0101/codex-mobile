// A document load is not a view load: restoration/history may still be running.
// Keep the hub's one neutral overlay until the selected app has rendered its view.
export function installMobileHubReadiness(window) {
  function inspect(frame) {
    let doc, view;
    try { doc=frame.contentDocument; view=frame.contentWindow; } catch { return 'loading'; }
    if(!doc?.body)return 'loading';
    const report=view?.__mobileHubReadiness;
    if(typeof report==='function'){
      const state=report();
      return state==='ready'||state==='error'?state:'loading';
    }
    if(frame.dataset.frame==='dsh'){
      const boot=doc.querySelector('[data-dsh-boot]');
      if(boot)return boot.querySelector('[class*="_failed_"]')?'error':'loading';
      if(!doc.querySelector('[data-dshm-menu]'))return 'loading';
      const conversation=doc.querySelector('[data-dshm-conversation-state]');
      const state=conversation?.getAttribute('data-dshm-conversation-state');
      if(doc.documentElement.dataset.dshmDrawer==='open'){
        // Even an empty workspace list is valid once the catalogue has settled.
        const list=doc.querySelector('[data-dshm-workspace-state]');
        const phase=list?.getAttribute('data-dshm-workspace-state');
        return phase==='ready'?'ready':phase==='error'?'error':'loading';
      }
      if(state==='error')return 'error';
      if(state!=='ready')return 'loading';
      if(conversation.getAttribute('data-phase')==='hero')return 'ready';
      const history=conversation.querySelector('[data-dshm-history-state]');
      const phase=history?.getAttribute('data-dshm-history-state');
      if(phase==='error')return 'error';
      return phase==='open'&&history.hasAttribute('data-dshm-history-positioned')?'ready':'loading';
    }
    // An older Codex runtime already has a readiness/error boundary. Do not
    // treat an unmounted/empty document as ready during a rolling update.
    if(frame.dataset.frame==='codex'){
      const loading=doc.getElementById('codex-loading');
      if(loading)return loading.getAttribute('aria-busy')==='false'?'error':'loading';
      return view?.__CODEX_ORIGINAL_MOUNT__?'ready':'loading';
    }
    return 'loading';
  }
  function wait(frame,settled) {
    const doc=frame.contentDocument;
    let stopped=false,timer;
    const cancel=()=>{stopped=true;window.clearTimeout(timer);};
    const check=()=>{
      if(stopped||frame.contentDocument!==doc){cancel();return;}
      let state='loading';
      try { state=inspect(frame); } catch {}
      if(state==='ready'||state==='error'){cancel();settled(state);return;}
      timer=window.setTimeout(check,50);
    };
    check();
    return cancel;
  }
  window.waitMobileHubReady=wait;
  return {inspect,wait};
}
