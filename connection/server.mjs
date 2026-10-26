import http from 'node:http';
import {mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import QRCode from 'qrcode';
import {createIngress} from './ingress.mjs';
import {CpolarTunnel} from './cpolar.mjs';
import {SakuraTunnel} from './sakura.mjs';
import {controlSocketPath} from './control-client.mjs';

const stateDir=join(homedir(),'Library/Application Support/CodexMobileCpolar');
await mkdir(stateDir,{recursive:true,mode:0o700});await chmod(stateDir,0o700);
const gateway=createIngress(),configPath=join(stateDir,'cpolar.yml');let tunnel,stopping=false;
try{const settings=JSON.parse(await readFile(join(stateDir,'preferences.json'),'utf8'));if(settings.mode==='codex-read')gateway.setMode('codex-read');}catch{}
const state=()=>({...(tunnel?.state||{status:'waiting-account',origin:null,verifiedAt:null}),mode:gateway.mode});
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));}
function local(req){return req.headers.host==='localhost'&&!Object.keys(req.headers).some(k=>k.startsWith('x-forwarded-')||['forwarded','via','cf-ray'].includes(k))&&!req.headers.origin&&req.headers['sec-fetch-site']!=='cross-site';}
async function saveState(value){await writeFile(join(stateDir,'state.json'),JSON.stringify({...value,instance:gateway.instance},null,2),{mode:0o600});}
async function startTunnel(){
 if(tunnel)return;let sakura;
 try{sakura=JSON.parse(await readFile(join(stateDir,'sakura.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const common={instance:gateway.instance,onCandidate:origin=>gateway.setPublicOrigin(origin)};
 if(sakura)tunnel=new SakuraTunnel({...sakura,...common});
 else{const config=await readFile(configPath,'utf8');if(!/authtoken:\s*"[A-Za-z0-9_-]{16,}"/.test(config))return;tunnel=new CpolarTunnel({binary:join(stateDir,'cpolar'),configPath,port:8797,...common});}
 tunnel.on('state',value=>{saveState({...value,mode:gateway.mode}).catch(()=>{});console.log((value.provider||'cpolar')+' state: '+value.status);});tunnel.start();
}
const localSockets=new Set();
const control=http.createServer(async(req,res)=>{
 try{
  res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'none'; img-src data:; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
  if(!local(req))return json(res,403,{error:'本机入口访问受限'});
  if(req.method==='GET'&&req.url==='/local/status'){
   const value=state();let phoneUrl=value.origin;
   if(phoneUrl&&value.mode==='codex-read'){
    const response=await fetch('http://127.0.0.1:8796/local/info',{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)throw Error('原版界面的本机服务未就绪');const info=await response.json();const secret=new URL(info.url).hash;
    if(!/^#[A-Za-z0-9_-]{43}$/.test(secret))throw Error('配对信息异常');phoneUrl+='/'+secret;
   }
   return json(res,200,{...value,phoneUrl,probeUrl:value.origin?value.origin+'/probe':null,qr:phoneUrl?await QRCode.toDataURL(phoneUrl,{width:320,margin:3,errorCorrectionLevel:'M'}):null});
  }
  if(req.method==='POST'&&req.url==='/local/mode'){
   let body='';for await(const data of req){body+=data;if(body.length>200)throw Error('请求过大');}
   const mode=JSON.parse(body).mode;if(mode==='codex-read'&&state().status!=='online')return json(res,409,{error:'国内隧道尚未验证'});
   gateway.setMode(mode);await writeFile(join(stateDir,'preferences.json'),JSON.stringify({mode}),{mode:0o600});await saveState(state());return json(res,200,{mode});
  }
  if(req.method==='POST'&&req.url==='/local/account-ready'){
   const config=await readFile(configPath,'utf8');if(!/authtoken:\s*"[A-Za-z0-9_-]{16,}"/.test(config))return json(res,409,{error:'账号配置未就绪'});
   await chmod(configPath,0o600);await startTunnel();return json(res,200,{started:true});
  }
  return json(res,404,{error:'不存在'});
 }catch(error){return json(res,503,{error:error.message});}
});
control.on('connection',s=>{localSockets.add(s);s.on('close',()=>localSockets.delete(s));});
await new Promise((resolve,reject)=>{gateway.server.once('error',reject);gateway.server.listen(8797,'127.0.0.1',resolve);});
await rm(controlSocketPath,{force:true});
await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(controlSocketPath,resolve);});
await chmod(controlSocketPath,0o600);
await saveState(state());console.log('Phone connection panel: http://127.0.0.1:18901/');
try{await startTunnel();}catch{console.error('Phone tunnel configuration is unavailable');}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopping)return;stopping=true;tunnel?.stop();await gateway.close();for(const s of localSockets)s.destroy();control.close(()=>process.exit(0));});
