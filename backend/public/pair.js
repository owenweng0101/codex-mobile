let info;const $=id=>document.getElementById(id);
async function refresh(){
 try{
  const response=await fetch('/local/info');info=await response.json();if(!response.ok)throw Error(info.error);
  $('pair-state').textContent=!info.ready?'电脑离线':info.url?'外网已连接':'正在恢复连接';
  $('route-description').textContent=info.fixedGateway?'已连接你的固定服务器，手机地址长期保留。':'当前仍是试用通道，地址可能变化。';
  if(info.qr){$('qr').src=info.qr;$('qr').classList.remove('hidden');$('copy').disabled=false;$('waiting').textContent=info.fixedGateway?'扫码连接，或保存手机链接以便下次打开。':'请扫描当前二维码。';}
  else{$('qr').classList.add('hidden');$('copy').disabled=true;$('waiting').textContent=info.tunnelError||'正在检查外网连接…';}
 }catch{$('qr').classList.add('hidden');$('copy').disabled=true;$('pair-state').textContent='正在恢复连接';$('waiting').textContent='正在等待本机服务恢复…';}
}
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(info.url);$('message').textContent='手机链接已复制';}catch{$('message').textContent=info.url;}};
$('local').onclick=()=>{if(info?.localUrl)window.open(info.localUrl,'_blank','noopener');};
$('revoke').onclick=async()=>{await fetch('/local/revoke',{method:'POST'});await refresh();$('message').textContent='旧链接已失效，请重新扫码。';};
refresh();setInterval(refresh,3000);
