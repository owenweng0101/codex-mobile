import {NativeRead} from './lib/native-read.mjs';
import {injectHtmlPreview} from './lib/html-preview.mjs';
import {embedHtmlAssets,resolveReferencedFile} from './lib/file-references.mjs';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,chmod,stat,unlink,realpath} from 'node:fs/promises';
import {homedir,networkInterfaces} from 'node:os';
import {join,resolve,extname,dirname,sep} from 'node:path';
import QRCode from 'qrcode';
import {hubHtml,chatHtml} from './lib/ui.mjs';
import {listSessions,readTranscript,sessionCwd,sessionFile,desktopCatalog,sessionReadMarker} from './lib/sessions.mjs';
import {liveSession,sendPeerMessage} from './lib/live.mjs';
import {readEntries} from './lib/entries.mjs';
import {resolveCli,readMagpieLaunch,PERMISSION_MODES} from './lib/claude-cli.mjs';
import {resolveChatCwd} from './lib/chat-cwd.mjs';
import {DesktopIntent} from './lib/desktop-intent.mjs';
import {DesktopDelivery} from './lib/desktop-delivery.mjs';
import {DesktopModels} from './lib/desktop-models.mjs';
import {CommandLedger} from './lib/command-ledger.mjs';
import {stagePeerAttachments} from './lib/desktop-attachments.mjs';

/**
 * Claude 手机入口：复用 dsh-mobile 的口令/cookie/二维码/状态结构。
 *
 *   /claude/  手机会话列表与聊天（Claude Desktop 持有的原生会话）
 *   /m/       三合一胶囊入口：Codex / DSH / Claude，同一张二维码
 *
 * 桌面 App 的登录态和会话不受影响；口令只保存在本机私有目录。
 */

const PORT=Number(process.env.CLM_PORT??18903);
const BIND=process.env.CLM_BIND??'0.0.0.0';
const STATE_DIR=process.env.CLM_STATE??join(homedir(),'Library','Application Support','ClaudeMobile');
const TOKEN_PATH=join(STATE_DIR,'access-token');
const CONFIG_PATH=join(STATE_DIR,'config.json');
const COOKIE_CLAUDE='clm-auth';
const COOKIE_DESK='desk-auth';
const COOKIE_MAX_AGE_DAYS=30;
const DEFAULT_CWD=process.env.CLM_DEFAULT_CWD??join(homedir(),'codex');
const STARTED_AT=Date.now();
const pdfAssets=new Map();
// Native peer file_attachments are gated inside the desktop CLI
// (tengu_send_file). When the gate is off the CLI ignores them, so the gateway
// also sends a Read fallback in the text and reports which path the desktop
// actually took. No second writer and no settings rewrite.
const DESKTOP_CAPABILITIES=Object.freeze({desktopOwned:true,interrupt:false,changeModel:false,changePermissionMode:false,attachments:true,attachmentDelivery:'native-or-read',steer:true,queue:true});
const PEER_SPOOL=join(process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude'),'file-transfers');

let accessToken='';
let config={defaultModel:null,permissionMode:'acceptEdits'};
let qrCache={value:null,data:null};
const nativeRead=new NativeRead({stateDir:STATE_DIR});
const commandLedger=new CommandLedger({dir:join(STATE_DIR,'commands')});
const desktopIntent=new DesktopIntent({stateDir:STATE_DIR,readiness:claudeReadiness});
const desktopModels=new DesktopModels();
const desktopDelivery=new DesktopDelivery({ledger:commandLedger,intent:desktopIntent,sendPeerMessage,liveSession,readTranscript,sessionFile});

function log(...args){console.log(new Date().toISOString(),...args);}
function json(res,status,value,headers={}){
  const body=JSON.stringify(value);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});
  res.end(body);
}
function page(res,html){
  res.writeHead(200,{
    'content-type':'text/html; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',
    'x-frame-options':'SAMEORIGIN',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(html);
}
function readCookie(header,name){
  if(typeof header!=='string')return undefined;
  for(const part of header.split(';')){
    const at=part.indexOf('=');
    if(at===-1||part.slice(0,at).trim()!==name)continue;
    return part.slice(at+1).trim();
  }
  return undefined;
}
function cookie(name,value,path,secure=false){
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_DAYS*86400}${secure?'; Secure':''}`;
}
function lanAddresses(){
  return Object.values(networkInterfaces()).flat()
    .filter(entry=>entry&&entry.family==='IPv4'&&!entry.internal)
    .map(entry=>entry.address)
    .filter(address=>!address.startsWith('169.254.'));
}
function isLocalRequest(req,port=PORT){
  const host=req.headers.host;
  if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`)return false;
  if(Object.keys(req.headers).some(key=>key.startsWith('x-forwarded-')||['forwarded','via','cf-ray','cf-connecting-ip'].includes(key)))return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  return true;
}
function publicOriginFrom(req){
  const host=req.headers.host;
  if(!host)return null;
  const hostname=host.split(':')[0].toLowerCase();
  if(['localhost','127.0.0.1','::1','[::1]'].includes(hostname))return null;
  if(/^10\./.test(hostname)||/^192\.168\./.test(hostname)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname))return null;
  return 'https://'+host;
}
function isPublicHttps(origin){
  if(typeof origin!=='string')return false;
  try{
    const url=new URL(origin);
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return false;
    const hostname=url.hostname;
    if(['127.0.0.1','localhost','::1'].includes(hostname))return false;
    if(/^10\./.test(hostname)||/^192\.168\./.test(hostname)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname))return false;
    return true;
  }catch{return false;}
}
async function qrFor(value){
  if(qrCache.value===value)return qrCache.data;
  const data=await QRCode.toDataURL(value,{width:320,margin:3,errorCorrectionLevel:'M'});
  qrCache={value,data};
  return data;
}
async function loadOrCreateToken(){
  await mkdir(STATE_DIR,{recursive:true,mode:0o700});
  try{await chmod(STATE_DIR,0o700);}catch{}
  try{
    const value=(await readFile(TOKEN_PATH,'utf8')).trim();
    if(/^[A-Za-z0-9_-]{32,}$/.test(value))return value;
  }catch{}
  const value=randomBytes(32).toString('base64url');
  await writeFile(TOKEN_PATH,value,{mode:0o600});
  await chmod(TOKEN_PATH,0o600);
  return value;
}
async function loadConfig(){
  try{
    const value=JSON.parse(await readFile(CONFIG_PATH,'utf8'));
    config={defaultModel:typeof value.defaultModel==='string'?value.defaultModel:null,permissionMode:PERMISSION_MODES.has(value.permissionMode)?value.permissionMode:'acceptEdits'};
  }catch{}
}

let readiness={at:0,cli:null,launch:null,error:null};
async function claudeReadiness(){
  if(Date.now()-readiness.at<5000)return readiness;
  let cli=null,launch=null,error=null;
  try{cli=await resolveCli();if(!cli)error='未找到 Claude Code 可执行文件';}catch(e){error=e.message;}
  try{launch=await readMagpieLaunch();}catch(e){error=error??e.message;}
  readiness={at:Date.now(),cli,launch,error};
  return readiness;
}
function defaultModelOf(launch){
  if(!launch?.models?.length)return null;
  if(config.defaultModel&&launch.models.some(item=>item.model===config.defaultModel))return config.defaultModel;
  const preferred=launch.models.find(item=>item.model==='jd2/DeepSeek-V4.1-Flash-a[1m]');
  return (preferred??launch.models[0]).model;
}

async function start(req,res){
  const url=new URL(req.url??'/','http://clm.invalid');
  const path=url.pathname;
  if(path.startsWith('/claude/api/'))res.on('finish',()=>log(`api ${req.method} ${path} -> ${res.statusCode} cookie=${Boolean(req.headers.cookie)}`));

  if(path==='/_claude/ping'){
    res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'});
    return res.end('claude-mobile');
  }
  if(path==='/_claude/status'){
    if(!isLocalRequest(req))return json(res,403,{error:'本机入口访问受限'});
    const hint=url.searchParams.get('publicOrigin');
    const publicOrigin=isPublicHttps(hint)?hint.replace(/\/+$/,'/'):null;
    const [address]=lanAddresses();
    const origin=publicOrigin??(address?`http://${address}:${PORT}`:null);
    const phoneUrl=origin?`${origin.replace(/\/+$/,'')}/m/?t=${accessToken}`:null;
    const ready=await claudeReadiness();
    return json(res,200,{
      service:'claude-mobile',
      status:publicOrigin?'online':'local',
      upstreamReady:Boolean(ready.cli&&ready.launch),
      upstreamError:ready.error,
      provider:publicOrigin?'tunnel':'lan',
      publicOrigin,
      basePath:'/m',
      lan:lanAddresses().map(address=>`http://${address}:${PORT}/m/`),
      path:`/m/?t=${accessToken}`,
      phoneUrl,
      qr:phoneUrl?await qrFor(phoneUrl):null,
      uptimeMs:Date.now()-STARTED_AT,
      pid:process.pid,
    });
  }

  if(path==='/m'||path==='/m/'){
    if(url.searchParams.get('t')!==null){
      if(url.searchParams.get('t')!==accessToken)return json(res,401,{error:'口令无效'});
      const secure=publicOriginFrom(req)!==null;
      res.setHeader('set-cookie',[cookie(COOKIE_DESK,accessToken,'/m',secure),cookie(COOKIE_CLAUDE,accessToken,'/claude',secure)]);
      res.writeHead(302,{location:'/m/','cache-control':'no-store'});
      return res.end();
    }
    if(readCookie(req.headers.cookie,COOKIE_DESK)!==accessToken)return json(res,401,{error:'需要手机连接口令：请重新扫描二维码'});
    return page(res,hubHtml());
  }

  if(path==='/m/api/entries'){
    if(readCookie(req.headers.cookie,COOKIE_DESK)!==accessToken)return json(res,401,{error:'口令无效'});
    const origin=publicOriginFrom(req);
    const ready=await claudeReadiness();
    const entries=await readEntries(origin);
    return json(res,200,{
      codex:entries.codex,
      dsh:entries.dsh,
      claude:ready.cli&&ready.launch?{ready:true,url:'/claude/'}:{ready:false,reason:ready.error??'Claude 手机入口未就绪'},
    });
  }

  // Fixed local PDF runtime; never expose arbitrary vendor/source paths.
  if(path.startsWith('/claude/assets/pdfjs/')){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    const name=path.slice('/claude/assets/pdfjs/'.length);
    if(!['loader.mjs','pdf.mjs','pdf.worker.mjs','binary-assets.mjs','compat.mjs'].includes(name)||req.method!=='GET')return json(res,404,{error:'资源不存在'});
    try{
      let asset=pdfAssets.get(name);
      if(!asset){const bytes=await readFile(new URL('./vendor/pdfjs/'+name,import.meta.url));asset={bytes,gzip:gzipSync(bytes)};pdfAssets.set(name,asset);}
      const compressed=/\bgzip\b/.test(req.headers['accept-encoding']??'');
      res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'private, max-age=3600','vary':'Accept-Encoding','x-content-type-options':'nosniff','cross-origin-resource-policy':'same-origin',...(compressed?{'content-encoding':'gzip'}:{})});
      return res.end(compressed?asset.gzip:asset.bytes);
    }catch{return json(res,404,{error:'资源不存在'});}
  }

  if(path==='/claude'||path==='/claude/'){
    if(url.searchParams.get('t')!==null){
      if(url.searchParams.get('t')!==accessToken)return json(res,401,{error:'口令无效'});
      res.setHeader('set-cookie',[cookie(COOKIE_CLAUDE,accessToken,'/claude',publicOriginFrom(req)!==null)]);
      res.writeHead(302,{location:'/claude/','cache-control':'no-store'});
      return res.end();
    }
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'需要手机连接口令：请重新扫描二维码'});
    return page(res,chatHtml());
  }

  if(path==='/claude/api/file'&&req.method==='GET'){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    const session=url.searchParams.get('session'), requested=url.searchParams.get('path');
    if(!requested||requested.includes('\0'))return json(res,400,{error:'文件路径无效'});
    const entry=await sessionFile(session);if(!entry)return json(res,404,{error:'会话不存在'});
    const raw=await readFile(entry.path,'utf8');
    const cwd=await sessionCwd(session)||DEFAULT_CWD;
    const desktop=(await desktopCatalog()).find(value=>value.cliSessionId===session);
    const roots=Array.isArray(desktop?.shellFolders)?desktop.shellFolders:[];
    const target=await resolveReferencedFile({raw,cwd,requested,base:url.searchParams.get('base'),folders:roots});
    if(!target)return json(res,404,{error:'文件不存在或不在当前会话的引用中'});
    const {file,info}=target;
    try{
      if(info.size>20*1024*1024)return json(res,413,{error:'文件过大，无法预览'});
      const ext=extname(file).toLowerCase();
      const type={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.md':'text/markdown; charset=utf-8','.markdown':'text/markdown; charset=utf-8'}[ext]||'text/plain; charset=utf-8';
      res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:; base-uri 'none'; form-action 'none'"});
      const bytes=await readFile(file);
      if(type.startsWith('text/html')){
        let html=await embedHtmlAssets(file,bytes.toString('utf8'));
        if(url.searchParams.get('preview')==='html')html=injectHtmlPreview(html,url.searchParams.get('previewToken'));
        return res.end(html);
      }
      return res.end(bytes);
    }catch{return json(res,404,{error:'文件不存在或已移动'});}
  }

  if(path==='/claude/api/sessions'){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    try{return json(res,200,{sessions:await listSessions()});}
    catch(error){return json(res,500,{error:'读取会话失败：'+error.message});}
  }

  if(path==='/claude/api/read'&&req.method==='POST'){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return json(res,403,{error:'来源不允许'});
    if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:'来源不允许'});}catch{return json(res,403,{error:'来源不允许'});}}
    let body;try{body=await readBody(req,4096);}catch{return json(res,400,{error:'已读请求无效'});}
    try{const result=await nativeRead.acknowledge(body);return json(res,result.verified?200:202,result);}
    catch(error){return json(res,error.statusCode||503,{error:error.statusCode?error.message:'暂时无法同步电脑端已读状态，请重试。',code:error.code||'NATIVE_READ_UNAVAILABLE',verified:false});}
  }

  if(path==='/claude/api/models'){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    const ready=await claudeReadiness();
    return json(res,200,{
      models:ready.launch?.models??[],
      defaultModel:defaultModelOf(ready.launch),
      permissionMode:config.permissionMode,
      ready:Boolean(ready.cli&&ready.launch),
      capabilities:DESKTOP_CAPABILITIES,
    });
  }

  if(path==='/claude/api/upload'&&req.method==='POST')return upload(req,res);
  if(path.startsWith('/claude/api/upload/')&&req.method==='GET')return serveUpload(req,res,path);

  if(path.startsWith('/claude/api/session/')){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    const id=decodeURIComponent(path.slice('/claude/api/session/'.length));
    const since=Number(url.searchParams.get('since')??0);
    const value=await readTranscript(id,Number.isFinite(since)&&since>0?since:0);
    if(!value)return json(res,404,{error:'会话不存在'});
    await hydratePhoneAttachments(value);
    const control=await sessionControl(id,value);
    return json(res,200,{...value,control,readMarker:await sessionReadMarker(id)});
  }

  if(path.startsWith('/claude/api/command/')&&req.method==='GET'){
    if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
    try{const value=await desktopDelivery.status(path.slice('/claude/api/command/'.length));if(!value)return json(res,404,{error:'尚未查到这条发送请求，请稍后查询'});const control=value.sessionId?await sessionControl(value.sessionId).catch(()=>null):null;return json(res,200,{...value,control});}catch(error){return json(res,error.statusCode||400,{error:error.message});}
  }

  if(path==='/claude/api/chat'&&req.method==='POST')return chat(req,res);

  return json(res,404,{error:'不存在'});
}

function readBody(req,limit=200*1024){
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    req.on('data',chunk=>{size+=chunk.length;if(size>limit){reject(Error('请求过大'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('请求格式无效'));}});
    req.on('error',reject);
  });
}

const UPLOADS=join(STATE_DIR,'uploads');
const UPLOAD_TYPES={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
const MAX_UPLOAD_BYTES=10*1024*1024;

async function upload(req,res){
  if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
  let body;
  try{body=await readBody(req,14*1024*1024);}catch{return json(res,413,{error:'图片过大（最大 10MB）'});}
  const data=typeof body.data==='string'?body.data:'';
  const match=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if(!match)return json(res,400,{error:'只支持 PNG/JPEG/WebP/GIF 图片'});
  const buffer=Buffer.from(match[2],'base64');
  if(buffer.length===0||buffer.length>MAX_UPLOAD_BYTES)return json(res,413,{error:'图片过大（最大 10MB）'});
  const ext=match[1]==='jpeg'?'jpg':match[1];
  const id=`${randomUUID()}.${ext}`;
  await writeFile(join(UPLOADS,id),buffer,{mode:0o600});
  return json(res,200,{id,path:join(UPLOADS,id),name:typeof body.name==='string'?body.name.slice(0,120):id,url:'/claude/api/upload/'+id});
}

async function serveUpload(req,res,path){
  if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return json(res,401,{error:'口令无效'});
  const id=path.slice('/claude/api/upload/'.length);
  const match=/^([0-9a-f-]{36})\.(png|jpg|jpeg|webp|gif)$/i.exec(id);
  if(!match)return json(res,404,{error:'图片不存在'});
  try{
    const bytes=await readFile(join(UPLOADS,id));
    res.writeHead(200,{'content-type':UPLOAD_TYPES[match[2].toLowerCase()],'content-length':bytes.length,'cache-control':'private, max-age=300','x-content-type-options':'nosniff'});
    return res.end(bytes);
  }catch{return json(res,404,{error:'图片不存在'});}
}

function resolveAttachments(body){
  const list=Array.isArray(body.attachments)?body.attachments:[];
  const ids=[];
  for(const item of list){
    const id=typeof item==='string'?item:item?.id;
    if(typeof id!=='string'||!/^[0-9a-f-]{36}\.(png|jpg|jpeg|webp|gif)$/i.test(id))return {error:'附件无效，请重新上传'};
    if(!ids.includes(id))ids.push(id);
    if(ids.length>16)return {error:'一次最多发送 16 张图片'};
  }
  return {ids,paths:ids.map(id=>join(UPLOADS,id))};
}

function phoneAttachmentNote(paths){
  return '\n\n（手机图片，请用 Read 查看：\n'+paths.map(file=>'- '+file).join('\n')+'\n）';
}

async function cleanupStaged(fileAttachments){
  for(const item of fileAttachments||[]){
    if(typeof item?.path==='string'&&item.path.startsWith(PEER_SPOOL+sep))await unlink(item.path).catch(()=>{});
  }
}

async function hydratePhoneAttachments(value){
  for(const message of value.messages||[]){
    if(message.role!=='user'||message.attachments?.length)continue;
    let record=null;try{record=await commandLedger.get(message.id);}catch{}
    const ids=(record?.attachmentIds||[]).filter(id=>typeof id==='string');
    if(!ids.length)continue;
    message.attachments=ids.map(id=>({id,url:'/claude/api/upload/'+encodeURIComponent(id),name:'图片'}));
    message.attachmentDelivery=record.attachmentDelivery??null;
    message.text=message.text.replace(/\n\n（手机(?:上传的图片，请用 Read 工具查看后回答：[\s\S]*|随此消息附上了 \d+ 张图片，请用 Read 查看随附路径中的图片后回答。|图片，请用 Read 查看：[\s\S]*)）$/,'');
    let text=message.text.trim();
    for(;;){
      const match=/^@"([^"\n]+)"\s+/.exec(text);
      if(!match||!match[1].includes('/uploads/'))break;
      text=text.slice(match[0].length);
    }
    message.text=text;
  }
}

async function sessionControl(id,history){
  const [control,transcript]=await Promise.all([desktopIntent.readState(id),history?Promise.resolve(history):readTranscript(id)]);
  const mapped=await desktopModels.resolve(control.actualModel||control.model).catch(()=>({mapped:false}));
  return {...control,selectedModel:mapped.mapped?mapped.catalogId:null,modelLabel:mapped.mapped?mapped.label:null,currentUserId:transcript?.currentUserId??null,canInterrupt:control.attached&&DESKTOP_CAPABILITIES.interrupt};
}

async function chat(req,res){
  const rejectBeforeDispatch=(status,error)=>json(res,status,{error,delivery:'rejected',notDispatched:true});
  if(readCookie(req.headers.cookie,COOKIE_CLAUDE)!==accessToken)return rejectBeforeDispatch(401,'口令无效');
  let body;try{body=await readBody(req);}catch(error){return rejectBeforeDispatch(400,error.message);}
  const text=typeof body.text==='string'?body.text.trim():'';
  if(!text)return rejectBeforeDispatch(400,'消息为空');
  if(text.length>20000)return rejectBeforeDispatch(413,'消息过长');
  if(typeof body.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))return rejectBeforeDispatch(400,'请刷新页面后重新发送，缺少稳定消息编号');
  if(body.sessionId!=null&&(typeof body.sessionId!=='string'||!/^[0-9a-f-]{36}$/i.test(body.sessionId)))return rejectBeforeDispatch(400,'会话编号无效');
  const sessionId=body.sessionId||null;
  let recordedCwd=null;if(sessionId)recordedCwd=await sessionCwd(sessionId);
  const resolved=await resolveChatCwd({sessionCwd:recordedCwd,requestedCwd:body.cwd,defaultCwd:DEFAULT_CWD,resume:Boolean(sessionId)});
  if(resolved.error)return rejectBeforeDispatch(400,resolved.error);
  const ready=await claudeReadiness();if(!ready.cli||!ready.launch)return rejectBeforeDispatch(503,ready.error||'Claude 运行环境未就绪');
  const requested=typeof body.model==='string'?body.model:null;
  const model=ready.launch.models.some(item=>item.model===requested)?requested:defaultModelOf(ready.launch);
  if(!model)return rejectBeforeDispatch(503,'没有可用模型');
  const permissionMode=PERMISSION_MODES.has(body.permissionMode)?body.permissionMode:config.permissionMode;
  const resolvedAttachments=resolveAttachments(body);
  if(resolvedAttachments.error)return rejectBeforeDispatch(400,resolvedAttachments.error);
  const {ids:attachmentIds,paths}=resolvedAttachments;
  let effectivePaths=paths,fileAttachments=[];
  if(paths.length){
    try{
      effectivePaths=await Promise.all(paths.map(file=>realpath(file)));
      fileAttachments=await stagePeerAttachments(effectivePaths,{requestId:body.requestId,spoolDir:PEER_SPOOL});
    }catch(error){return rejectBeforeDispatch(400,'图片未发送：'+error.message);}
  }
  const prompt=effectivePaths.length?text+phoneAttachmentNote(effectivePaths):text;
  try{
    const record=await desktopDelivery.submit({requestId:body.requestId,sessionId,cwd:resolved.cwd,text,model,permissionMode,permissionExplicit:body.permissionExplicit===true,attachments:attachmentIds,priority:body.priority==='next'?'next':'now',prompt,fileAttachments});
    if(record.state==='rejected'||record.state==='accepted'&&record.attachmentDelivery==='read-path')await cleanupStaged(fileAttachments);
    const control=record.sessionId?await sessionControl(record.sessionId).catch(()=>null):null;
    return json(res,record.state==='accepted'?200:record.state==='rejected'?409:202,{...record,control});
  }catch(error){return json(res,error.statusCode||error.status||500,{error:error.message,code:error.code||'DELIVERY_ERROR'});}
}

await loadConfig();
accessToken=/^[A-Za-z0-9_-]{32,}$/.test(process.env.CLM_ACCESS_TOKEN??'')?process.env.CLM_ACCESS_TOKEN:await loadOrCreateToken();
await mkdir(STATE_DIR,{recursive:true,mode:0o700});
await mkdir(UPLOADS,{recursive:true,mode:0o700});
await commandLedger.recover();
log(`Claude 手机入口启动：http://127.0.0.1:${PORT}/claude/  监听 ${BIND}:${PORT}`);
log(`三合一入口：http://127.0.0.1:${PORT}/m/`);

const server=http.createServer((req,res)=>{
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  start(req,res).catch(error=>{
    log('request failed:',error.message);
    if(!res.headersSent){
      res.writeHead(500,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify({error:'手机网关内部错误'}));
    }else res.destroy();
  });
});
server.on('upgrade',(req,socket)=>{
  socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
  socket.destroy();
});

await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(PORT,BIND,resolve);});

for(const signal of ['SIGTERM','SIGINT']){
  process.on(signal,()=>{
    log('shutting down');
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(0),3000).unref();
  });
}
