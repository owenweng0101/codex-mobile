import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,join,sep} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {createAttachmentUploadServices} from './attachment-upload.mjs';
import {CodexWriteClient} from './write-client.mjs';
import {shareReadApi} from './read-services/shared-reads.mjs';
import {createWriteServices} from './write-services/index.mjs';
import {ModelSelections} from './write-services/model-selections.mjs';
import {createMobileApi} from './mobile-api.mjs';
import {Pairing,sameOrigin} from './auth.mjs';
import {attachOriginalRpc} from './rpc-server.mjs';
import {workspaceInfo,resolveNavigation} from './navigation.mjs';
import {rejectMissingChannels} from './unavailable-services.mjs';
import {wrapReadControllers} from './read-services/controllers.mjs';
import {createSupportServices} from './frontend-stage/support-services.mjs';
import {wrapReadEvents} from './read-services/events.mjs';
import {createQueuedAttachmentResolver} from './queued-attachments.mjs';
import {createConversationReadServices} from './frontend-stage/conversation-read.mjs';

const root=resolve(import.meta.dirname),port=Number(process.env.CODEX_MOBILE_ADAPTER_PORT||8796),origin='http://127.0.0.1:'+port;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid loopback adapter port');
const web=resolve(root,'../vendor/zcode-web');
const stateDir=process.env.CODEX_MOBILE_ADAPTER_STATE_DIR||join(homedir(),'Library/Application Support/ZCodeCodexBridge');
await mkdir(stateDir,{recursive:true,mode:0o700});
let token;try{token=(await readFile(join(stateDir,'pair-token'),'utf8')).trim();if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw Error();}catch{token=randomBytes(32).toString('base64url');await writeFile(join(stateDir,'pair-token'),token,{mode:0o600});}
const pairing=new Pairing({token}),api=shareReadApi(new CodexWriteClient()),calls=[],modelSelections=new ModelSelections(stateDir);
const {createReadServices}=await import('./read-services/index.mjs');
const {createPlatformServices}=await import('./frontend-stage/platform-services.mjs');
const sharedServices={...await createPlatformServices({api,stateDir}),...await createReadServices({api})};
// Register an actual, server-owned workspace before its first conversation
// exists. Global drafts must not inherit the currently selected project.
const conversationWorkspacePath=process.env.CODEX_MOBILE_WORKSPACE_DIR||join(homedir(),'Documents/Codex/mobile-chats');
await mkdir(conversationWorkspacePath,{recursive:true});
const readTree=sharedServices.project.readTree.bind(sharedServices.project);
sharedServices.project.readTree=async(...args)=>({...await readTree(...args),conversationWorkspacePath});
const uploads=createAttachmentUploadServices({api,scope:async(p,sessionId)=>{
  const tree=await sharedServices.project.readTree();
  const known=tree.conversationWorkspacePath===p.workspacePath||tree.tasks.some(t=>t.workspacePath===p.workspacePath)||(tree.projects||[]).some(x=>(x.roots||[]).some(r=>r.rootPath===p.workspacePath));
  if(!known)throw Error('附件工作区未授权');
  if(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId||'')){const page=await api.get('/api/history?threadId='+encodeURIComponent(sessionId));if(page.thread?.cwd!==p.workspacePath||page.thread?.archived)throw Error('附件会话不属于当前工作区');}
  return true;
}});
const resolveAttachment=createQueuedAttachmentResolver({api,resolveUploaded:p=>uploads.resolveAttachment(p)});
const mobileApi=createMobileApi({api,baseServices:sharedServices,ledgerDir:join(stateDir,'commands'),uploads,resolveAttachment,modelSelections,conversationWorkspacePath});
function createConnection(){
  const supported={...sharedServices,...createSupportServices({api,baseServices:sharedServices,writable:true})};
  supported['zcode-agent']=new Proxy(supported['zcode-agent'],{get(target,key,receiver){return Object.keys(uploads).includes(key)?uploads[key]:Reflect.get(target,key,receiver);}});
  const controller=wrapReadControllers(supported,{api});
  const readEvents=wrapReadEvents(controller.channels,{api,pollMs:250,useLongPolling:true});
  const controllerChanges=readEvents.changes(()=>controller.refresh().catch(()=>{}));
  const conversations=createConversationReadServices({indexedHistory:true,deferInitialFrame:true,api,baseServices:readEvents.channels,eventAdapter:readEvents,writable:true,modelSelections,resolveAttachment});
  const writes=createWriteServices({autoSteerActive:false,api,baseServices:conversations.channels,ledgerDir:join(stateDir,'commands'),modelSelections,resolveAttachment,native:{interruptExpected:params=>api.post('/api/interrupt-expected',params)},revisionGuard:params=>conversations.validateRevision(params),onChanged:async params=>{await sharedServices.project.readTree({refresh:true});await readEvents.pollNow();await conversations.refreshWorkspace(params);}});
  return{services:rejectMissingChannels(writes.channels),dispose(){conversations.dispose();controllerChanges.dispose();readEvents.dispose();controller.dispose();}};
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.wasm':'application/wasm'};
function json(res,status,value,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(value));}
async function readBody(req){let s='';for await(const part of req){s+=part;if(s.length>2048)throw Error('请求过大');}return JSON.parse(s);}
async function navigationContext(){const [tree,status]=await Promise.all([sharedServices.project.readTree(),api.get('/api/status')]);return{tree,status,getTaskMeta:params=>sharedServices['zcode-task'].getTaskMeta(params)};}
async function serverInfo(){const {tree,status}=await navigationContext();return workspaceInfo(tree,status,{readOnly:false});}
const server=createServer(async(req,res)=>{
  try{
    if(!sameOrigin(req.headers,origin))return json(res,403,{error:'只允许本机同源连接'});
    const url=new URL(req.url,origin);
    if(req.method==='GET'&&url.pathname==='/healthz')return json(res,200,{service:'codex-original-zcode-bridge',readOnly:false});
    if(req.method==='GET'&&url.pathname==='/local/info')return json(res,200,{url:origin+'/#'+pairing.token,readOnly:false});
    if(req.method==='POST'&&url.pathname==='/api/pair'){
      const session=pairing.pair((await readBody(req)).token);
      return session?json(res,200,{paired:true},{'set-cookie':'codex_native_pair='+session+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'}):json(res,401,{error:'配对链接已失效'});
    }
    if(url.pathname.startsWith('/mobile/api/')){
      if(!pairing.allows(req.headers))return json(res,401,{error:'请先扫描模型网关中的二维码'});
      return await mobileApi(req,res,url);
    }
    // Old bookmarks also open the single ZCode interface. Never serve a second UI.
    if(url.pathname.startsWith('/mobile/')&&!['/mobile/','/mobile/index.html'].includes(url.pathname))return json(res,410,{error:'该旧版资源已移除，请返回首页'});
    if(url.pathname.startsWith('/api/')||url.pathname==='/__audit'){
      if(!pairing.allows(req.headers))return json(res,401,{error:'请先配对'});
      if(req.method==='GET'&&url.pathname==='/api/server-info')return json(res,200,await serverInfo());
      if(req.method==='POST'&&url.pathname==='/api/navigation')return json(res,200,await resolveNavigation(await readBody(req),await navigationContext()));
      if(req.method==='GET'&&url.pathname==='/__audit')return json(res,200,{rpcCalls:calls.slice(-300),readOnly:false,macRequests:api.requests});
      return json(res,404,{error:'此验证版本尚未开放该功能'});
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'不支持的请求'});
    let path,bytes,type;
    if(['/', '/legacy/', '/mobile/', '/mobile/index.html', '/remote/v4','/remote/v4/'].includes(url.pathname)){
      path=join(web,'remote/v4/3.16.3/index.html');
      const html=await readFile(path,'utf8');
      const expected='<script type="module" crossorigin src="/remote/v4/3.16.3/assets/index-BsmXQHMM.js"></script>';
      if(!html.includes(expected))throw Error('原版入口结构发生变化');
      // Before JavaScript starts, show a plain white surface without the legacy logo shell.
      const startupStyle='<style id="codex-startup-surface">.zcode-boot-loading{background:#fff!important}.zcode-boot-loading__logo-shell{display:none!important}</style>';
      bytes=Buffer.from(html.replace(expected,'<script type="module" crossorigin src="/codex-entry.mjs"></script>').replace('</head>',startupStyle+'</head>'));type=types['.html'];
    }else if(url.pathname==='/codex-entry.mjs'){path=join(root,'codex-entry.mjs');}
    else if(url.pathname==='/mobile-connection.mjs'){path=join(root,'mobile-connection.mjs');}
    else if(url.pathname==='/codex-browser-adapter.mjs'){path=join(root,'frontend-stage/browser-adapter.mjs');}
    else if(url.pathname==='/remote/v4/3.16.3/assets/IntlProvider-itolvRb2.js'){path=join(root,'frontend-stage/assets/IntlProvider-itolvRb2.js');}
    else if(url.pathname==='/remote/v4/3.16.3/assets/index-BsmXQHMM.js'){path=join(root,'frontend-stage/assets/index-BsmXQHMM.js');}
    else{path=resolve(web,'.'+decodeURIComponent(url.pathname));if(!path.startsWith(web+sep))return json(res,403,{error:'无效路径'});}
    if(!bytes){const info=await stat(path);if(!info.isFile())return json(res,404,{error:'资源不存在'});bytes=await readFile(path);}
    const asset=url.pathname.startsWith('/remote/v4/3.16.3/assets/'),mutableAsset=['/remote/v4/3.16.3/assets/index-BsmXQHMM.js','/remote/v4/3.16.3/assets/IntlProvider-itolvRb2.js'].includes(url.pathname),cachePolicy=asset&&!mutableAsset?'public, max-age=31536000, immutable':'public, no-cache',etag=asset?'"'+createHash('sha256').update(bytes).digest('base64url')+'"':null;
    if(etag&&req.headers['if-none-match']===etag){res.writeHead(304,{'etag':etag,'cache-control':cachePolicy});res.end();return;}
    res.writeHead(200,{'content-type':type||types[extname(path)]||'application/octet-stream','content-length':bytes.length,'cache-control':asset?cachePolicy:'no-store',...(etag?{etag}:{}),'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; form-action 'self'"});res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){if(!res.headersSent)json(res,error.code==='ENOENT'?404:500,{error:error.code==='ENOENT'?'资源尚未就绪':error.message});else res.destroy();}
});
const stopRpc=attachOriginalRpc(server,{pairing,origin,createConnection,onRequest:item=>{calls.push(item);if(calls.length>1000)calls.splice(0,500);}});
server.listen(port,'127.0.0.1',()=>console.log('Codex mobile adapter listening on '+origin));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopRpc();server.close(()=>process.exit(0));});
