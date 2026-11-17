/** Shared-shell updates must not destroy drafts or an active child interaction. */
export function hubReloadSafe(frames){
  for(const frame of frames){
    if(!frame.getAttribute('src'))continue;
    try{
      const view=frame.contentWindow,doc=frame.contentDocument;
      if(!view||!doc?.body)return false;
      const visible=node=>Boolean(node.getClientRects?.().length);
      if(typeof view.__claudeMobileReloadSafe==='function'&&!view.__claudeMobileReloadSafe())return false;
      // The phone adapters know which attachment/send state cannot survive reload.
      // These guards remain authoritative even after their iframe is hidden.
      for(const name of ['__codexMobileReloadSafe','__dshMobileReloadSafe'])if(typeof view[name]==='function'&&view[name]()!==true)return false;
      if([...doc.querySelectorAll('[role="dialog"],[aria-busy="true"]')].some(visible))return false;
      for(const input of doc.querySelectorAll('textarea,input,[contenteditable]')){
        if(input.type==='file'){if(input.files?.length)return false;continue;}
        if(['hidden','button','submit','checkbox','radio','range','color'].includes(input.type))continue;
        const value=input.isContentEditable?input.textContent:input.value;
        if(typeof value==='string'&&value.replaceAll(String.fromCharCode(8203),'').trim())return false;
      }
      if([...doc.querySelectorAll('form img,[data-uploading="true"],button[aria-label="停止生成"],button[aria-label="停止"]')].some(visible))return false;
    }catch{return false;}
  }
  return true;
}
