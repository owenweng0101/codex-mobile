// A local gate also protects phones whose outer hub document predates an update.
// It covers the whole child viewport until native history AND its first layout
// are ready; it never intercepts sending, paging, or later session navigation.
export function installDshLoadingGate({document,view,inspect,returnHome,timeoutMs=15000}) {
  const gate=document.getElementById('dshm-loading');
  if(!gate)return()=>{};
  let done=false,failed=false,errorDetail,timer,observer;
  const stop=()=>{if(done)return;done=true;view.clearTimeout(timer);observer?.disconnect();};
  const fail=message=>{
    // A timeout is not a cancelled native restore. Keep observing so a slow or
    // reconnected session can dismiss the error without another destructive reload.
    if(failed){if(errorDetail.textContent!==message)errorDetail.textContent=message;return;}
    failed=true;view.clearTimeout(timer);
    gate.setAttribute('role','alert');gate.textContent='';
    errorDetail=document.createElement('p');errorDetail.textContent=message;gate.appendChild(errorDetail);
    const actions=document.createElement('div');actions.className='dshm-recovery-actions';
    const home=document.createElement('button');home.type='button';home.textContent='返回首页';home.dataset.home='true';home.onclick=()=>returnHome();
    const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.onclick=()=>view.location.reload();
    actions.appendChild(home);actions.appendChild(retry);gate.appendChild(actions);
  };
  const check=()=>{
    if(done)return;
    const state=inspect();
    if(state==='ready'){stop();gate.remove();}
    else if(state==='error'){
      const error=document.querySelector?.('[data-dshm-session-restore="error"], .tnXGgG_openError, [data-dsh-boot] [class*="_failed_"]');
      fail(error?.textContent?.trim()||'当前会话暂时无法加载');
    }
  };
  observer=new view.MutationObserver(check);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-dshm-history-state','data-dshm-history-positioned','data-dshm-conversation-state','data-dshm-workspace-state','data-dshm-drawer']});
  timer=view.setTimeout(()=>{
    if(done)return;
    check();if(done)return;
    fail('加载超时，可重试或返回首页选择其他会话');
  },timeoutMs);
  check();
  // BFCache freezes this realm, it does not dispose it. Retain the observer and
  // recheck on return instead of leaving a permanently stopped loading overlay.
  view.addEventListener('pagehide',event=>{if(!event.persisted)stop();});
  view.addEventListener('pageshow',event=>{if(event.persisted)check();});
  return stop;
}
