// Replay only the read-only file RPC. Never retry writes, turns or approvals.
export function installFileReadRecovery(win) {
  const original=win.fetch;
  const recovered=async function(input,init) {
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,win.location.href);
    const method=String(init?.method??input.method??'GET').toUpperCase();
    if(url.origin!==win.location.origin||!url.pathname.endsWith('/api/workspaceFiles/readBytes')||method!=='POST')return original.call(win,input,init);
    const request=input instanceof Request?new Request(input,init):new Request(url,init);
    for(let attempt=0;;attempt++){
      request.signal.throwIfAborted();
      try{
        const response=await original.call(win,request.clone());
        if(attempt===2||![502,503,504].includes(response.status))return response;
        await response.body?.cancel();
      }catch(error){if(request.signal.aborted||attempt===2||!(error instanceof TypeError))throw error;}
      await new Promise((resolve,reject)=>{
        const abort=()=>{clearTimeout(timer);reject(request.signal.reason);};
        const timer=setTimeout(()=>{request.signal.removeEventListener('abort',abort);resolve();},attempt===0?250:750);
        request.signal.addEventListener('abort',abort,{once:true});
        if(request.signal.aborted)abort();
      });
    }
  };
  win.fetch=recovered;
  return ()=>{if(win.fetch===recovered)win.fetch=original;};
}
