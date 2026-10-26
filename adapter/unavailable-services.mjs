// Register original channel names so an unsupported call fails through the
// original RPC error path instead of waiting indefinitely for a future channel.
export function rejectMissingChannels(services){
  const names=['broadcast','coding-plan-subscription','window-controller','marketing-touch','onboarding-record','zcode-agent','client-scenes','subagents','git','settings-sync','zcode-session','file','media-preview','terminal','file-watcher','skills','plugins','commands','hooks','memory','output-style','feedback','client-config','usage-stats'];
  for(const channel of names)if(!services[channel])services[channel]=new Proxy({}, {get(_target,method){
    if(typeof method!=='string')return;
    return()=>{throw Object.assign(Error('此 Codex 接入版本尚未开放 '+channel+'.'+method),{code:'CODEX_ADAPTER_UNSUPPORTED'});};
  }});
  return services;
}
