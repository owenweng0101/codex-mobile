import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import QRCode from 'qrcode';
import {createIngress} from '../connection/ingress.mjs';
import {SakuraTunnel} from '../connection/sakura.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),config=JSON.parse(await readFile(join(root,'config.local.json'),'utf8'));
const state=join(root,'runtime'),children=[],probe=process.argv.includes('--probe');let tunnel,ingress,panel,stopping=false;
const ports=probe?[8797,18901]:[8787,8796,8797,18901];
for(const port of ports){const occupied=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});s.setTimeout(300);s.on('connect',()=>{s.destroy();resolve(true);});s.on('error',()=>resolve(false));s.on('timeout',()=>{s.destroy();resolve(false);});});if(occupied)throw Error('Port '+port+' is already in use. Stop the other installation first; this command never stops unrelated services.');}
for(const path of [join(state,'backend'),join(state,'adapter')])await mkdir(path,{recursive:true,mode:0o700});
async function stop(code=0){if(stopping)return;stopping=true;tunnel?.stop();for(const c of children)c.kill('SIGTERM');panel?.close();await ingress?.close();setTimeout(()=>process.exit(code),500).unref();}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
async function ready(port,path='/healthz'){
 for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:'+port+path,{signal:AbortSignal.timeout(500)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('Local service '+port+' did not become ready.');
}
function run(file,extra=[],env={}){const c=spawn(process.execPath,[join(root,file),...extra],{cwd:root,env:{...process.env,...env},stdio:'inherit'});children.push(c);c.on('error',()=>stop(1));c.on('exit',()=>{if(!stopping)stop(1);});return c;}
try{
 if(!probe){
  await stat(join(root,'adapter/frontend-stage/assets/index-BsmXQHMM.js'));
  run('backend/server.mjs',['--no-tunnel'],{CODEX_MOBILE_STATE_DIR:join(state,'backend'),CODEX_MOBILE_CWD:config.workspaceRoot||join(homedir(),'Documents'),CODEX_MOBILE_BIND:'127.0.0.1',PORT:'8787',...(config.codexBin?{CODEX_BIN:config.codexBin}:{})});await ready(8787);
  run('adapter/server.mjs',[],{CODEX_MOBILE_ADAPTER_STATE_DIR:join(state,'adapter'),CODEX_MOBILE_WORKSPACE_DIR:config.workspaceRoot||join(homedir(),'Documents/Codex/mobile-chats')});await ready(8796);
 }
 ingress=createIngress();ingress.setPublicOrigin(config.publicOrigin);if(!probe)ingress.setMode('codex-read');
 await new Promise((ok,no)=>{ingress.server.once('error',no);ingress.server.listen(8797,'127.0.0.1',ok);});
 if(config.tunnel?.type==='sakura')tunnel=new SakuraTunnel({...config.tunnel,instance:ingress.instance,origin:config.publicOrigin,onCandidate:origin=>ingress.setPublicOrigin(origin)}).start();
 else throw Error('Configure tunnel.type=sakura in config.local.json.');
 async function pairing(){
  if(tunnel.state.status!=='online')return{status:tunnel.state.status,qr:null};
  const entry=probe?config.publicOrigin+'/probe':(await fetch('http://127.0.0.1:8796/local/info',{signal:AbortSignal.timeout(2000)}).then(r=>r.json())).url;
  const phone=probe?entry:config.publicOrigin+'/'+new URL(entry).hash;
  return{status:'online',probe,qr:await QRCode.toDataURL(phone,{width:280,margin:3})};
 }
 panel=http.createServer(async(req,res)=>{
  const host=req.headers.host;if(!['127.0.0.1:18901','localhost:18901'].includes(host)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&req.headers.origin!=='http://'+host){res.writeHead(403);res.end();return;}
  res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
  if(req.method==='GET'&&req.url==='/api/mobile'){try{res.setHeader('content-type','application/json');res.end(JSON.stringify(await pairing()));}catch{res.writeHead(503);res.end('{"status":"offline","qr":null}');}return;}
  if(req.method==='GET'&&req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(await readFile(join(root,'web/pair.html')));return;}
  res.writeHead(404);res.end();
 });
 await new Promise((ok,no)=>{panel.once('error',no);panel.listen(18901,'127.0.0.1',ok);});console.log('Pairing panel: http://127.0.0.1:18901/ ('+(probe?'network probe only':'Codex connection')+')');
}catch(error){console.error(error.message);await stop(1);}
