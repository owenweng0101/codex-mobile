import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createGzip,createBrotliCompress,gzip,brotliCompress,constants as zlibConstants} from 'node:zlib';
import {promisify} from 'node:util';
import {Transform} from 'node:stream';
import {WebSocket,WebSocketServer} from 'ws';

export const probeHtml=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 国内连接测试</title><style>body{font:17px system-ui;margin:40px auto;padding:0 24px;max-width:560px;color:#202124;background:#f7f8fa}h1{font-size:25px}li{margin:18px 0}button{font:inherit;padding:12px 20px;border:0;border-radius:12px;background:#202124;color:white}p{line-height:1.6;color:#60646b}</style><h1>Codex 国内连接测试</h1><p>此页面只测试网络，不包含你的项目、会话或控制权限。</p><ul><li id="https">页面已打开</li><li id="ws">双向连接：等待</li><li id="echo">消息往返：等待</li></ul><button id="retry">重新连接</button><script src="/probe.js"></script></html>`;
export const probeScript=`let current;function connect(){current?.close();const w=new WebSocket(location.origin.replace(/^http/,'ws')+'/probe/ws');current=w;w.binaryType='arraybuffer';w.onopen=()=>{document.getElementById('ws').textContent='双向连接：已建立';w.send(new TextEncoder().encode('codex-network-probe'));};w.onmessage=e=>{window.__PROBE_OK__=new TextDecoder().decode(e.data)==='codex-network-probe';document.getElementById('echo').textContent=window.__PROBE_OK__?'消息往返：成功':'消息往返：异常';};w.onclose=()=>{document.getElementById('ws').textContent='双向连接：已断开，可重新连接';};w.onerror=()=>{document.getElementById('echo').textContent='消息往返：未成功';};}document.getElementById('https').textContent=location.protocol==='https:'?'HTTPS：已建立安全连接':'当前为本机测试';document.getElementById('retry').onclick=connect;connect();`;
const blocked=new Set(['/local','/local/info','/__audit','/pair','/pair.js']);
const mobileAssets=new Set(['/mobile/app.css','/mobile/app.mjs','/mobile/attachments.mjs','/mobile/skills.mjs','/mobile/cache.mjs','/mobile/queue.mjs']);
const staticPath=p=>mobileAssets.has(p)||['/mobile/','/mobile/index.html','/','/legacy/','/codex-entry.mjs','/codex-browser-adapter.mjs'].includes(p)||p.startsWith('/remote/v4/3.16.3/');
const uploadBodyLimit=800*1024;
const validPath=p=>!/%|\\|\0/.test(p)&&!p.split('/').some(v=>v==='.'||v==='..');
function json(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
function secureHeaders(res){res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');}
const safeHeaders=['cookie','content-type','content-length','accept','accept-encoding','if-none-match','range','sec-fetch-site','sec-fetch-mode','sec-fetch-dest'];
const gzipBuffer=promisify(gzip),brotliBuffer=promisify(brotliCompress),brotliOptions={params:{[zlibConstants.BROTLI_PARAM_QUALITY]:9}};
const versionedAsset=path=>mobileAssets.has(path)||path.startsWith('/remote/v4/3.16.3/assets/');
export function preferredEncoding(header=''){
 const quality=new Map();for(const value of header.toLowerCase().split(',')){const[name,...parts]=value.trim().split(';');const q=parts.find(v=>v.trim().startsWith('q='));const n=q?Number(q.trim().slice(2)):1;quality.set(name,Number.isFinite(n)&&n>=0&&n<=1?n:0);}
 const q=name=>quality.get(name)??quality.get('*')??0,br=q('br'),gz=q('gzip');return br>0&&br>=gz?'br':gz>0?'gzip':null;
}
export function createCompressionCache({maxBytes=32*1024*1024,maxEntries=128}={}){
 const entries=new Map();let bytes=0;
 const remove=key=>{const item=entries.get(key);if(item){bytes-=item.size;entries.delete(key);}};
 return{
  encode(key,size,produce){
   const cached=entries.get(key);if(cached){entries.delete(key);entries.set(key,cached);return cached.value;}
   if(!Number.isFinite(size)||size<0||size>maxBytes)return null;
   for(const[old,item]of entries){if(bytes+size<=maxBytes&&entries.size<maxEntries)break;if(!item.pending)remove(old);}
   if(bytes+size>maxBytes||entries.size>=maxEntries)return null;
   const item={size,pending:true};bytes+=size;entries.set(key,item);
   item.value=(async()=>{try{const encoded=await produce();if(entries.get(key)===item){bytes+=encoded.length-item.size;item.size=encoded.length;item.pending=false;if(bytes>maxBytes)remove(key);}return encoded;}catch(error){if(entries.get(key)===item)remove(key);throw error;}})();
   return item.value;
  },
  clear(){entries.clear();bytes=0;},
  get size(){return entries.size;},get bytes(){return bytes;},
 };
}
function varyEncoding(headers){const values=String(headers.vary||'').split(',').map(v=>v.trim()).filter(Boolean);if(!values.some(v=>v.toLowerCase()==='accept-encoding'))values.push('Accept-Encoding');headers.vary=values.join(', ');}
function weakEtag(headers){if(headers.etag&&!headers.etag.startsWith('W/'))headers.etag='W/'+headers.etag;}

/** A dedicated tunnel port with no local control routes. The upstream remains
 * loopback-only. Its pairing and original RPC binary protocol stay intact. */
export function createIngress({backend='http://127.0.0.1:8796',instance=randomUUID(),compressionCache=createCompressionCache()}={}){
 const upstream=new URL(backend);if(upstream.hostname!=='127.0.0.1'||upstream.protocol!=='http:')throw Error('Upstream must be loopback HTTP');
 let publicOrigin=null,mode='probe';const sockets=new Set(),upstreamSockets=new Set();
 // QR scanners and links from another app can mark the initial document load
 // cross-site. Only that safe entry navigation is exempt; APIs and sockets are not.
 function externalEntry(req){return req.method==='GET'&&!req.headers.origin&&req.headers['sec-fetch-site']==='cross-site'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document'&&['/','/legacy/','/mobile/','/mobile/index.html'].includes(pathOf(req));}
 function allowed(req){return !!publicOrigin&&req.headers.host===new URL(publicOrigin).host&&(!req.headers.origin||req.headers.origin===publicOrigin)&&(req.headers['sec-fetch-site']!=='cross-site'||externalEntry(req));}
 function pathOf(req){try{const u=new URL(req.url,'http://ingress.invalid');if(u.origin!=='http://ingress.invalid'||!validPath(req.url.split('?')[0]))return null;return u.pathname;}catch{return null;}}
 function headers(req){const out={host:upstream.host};for(const k of safeHeaders)if(req.headers[k]!==undefined)out[k]=req.headers[k];if(externalEntry(req))out['sec-fetch-site']='none';if(req.headers.origin)out.origin=upstream.origin;if(versionedAsset(pathOf(req)||'')){out['accept-encoding']='identity';if(out['if-none-match'])out['if-none-match']=out['if-none-match'].replace(/W\/(?=")/g,'');}return out;}
 const wss=new WebSocketServer({noServer:true,maxPayload:64*1024});
 wss.on('connection',ws=>{let count=0;ws.on('error',()=>{});ws.on('message',(data,binary)=>{if(++count>100){ws.close(1008,'Probe limit');return;}ws.send(data,{binary});});});
 const server=http.createServer((req,res)=>{
  secureHeaders(res);const path=pathOf(req);
  if(!allowed(req))return json(res,403,{error:'Origin not allowed'});
  if(!path||blocked.has(path)||path.startsWith('/local/'))return json(res,404,{error:'Not available'});
  if(req.method==='GET'&&path==='/healthz')return json(res,200,{service:'codex-cpolar-ingress',instance,mode});
  if(req.method==='GET'&&path==='/probe.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});res.end(probeScript);return;}
  if(req.method==='GET'&&(path==='/probe'||mode==='probe'&&path==='/')){res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'"});res.end(probeHtml);return;}
  if(mode!=='codex-read')return json(res,404,{error:'Network probe only'});
  const mobileRead=['/mobile/api/bootstrap','/mobile/api/threads','/mobile/api/history','/mobile/api/image','/mobile/api/changes','/mobile/api/skills','/mobile/api/queue'].includes(path);
  const mobileWrite=['/mobile/api/create','/mobile/api/message','/mobile/api/queue','/mobile/api/upload','/mobile/api/archive'].includes(path);
  const permitted=(req.method==='GET'&&mobileRead)||(req.method==='POST'&&mobileWrite)||(['GET','HEAD'].includes(req.method)&&staticPath(path))||(req.method==='GET'&&path==='/api/server-info')||(req.method==='POST'&&['/api/pair','/api/navigation'].includes(path));
  if(!permitted)return json(res,404,{error:'Operation not enabled'});
  if(path==='/mobile/api/upload'&&Number(req.headers['content-length'])>uploadBodyLimit){req.resume();return json(res,413,{error:'Upload chunk too large'});}
  // No local management route or caller-controlled upstream/forwarding header
  // can reach the adapter. Check public origin before translating it locally.
  const proxy=http.request({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:headers(req),timeout:path==='/mobile/api/changes'?30000:20000},response=>{
   response.on('error',()=>{if(!res.headersSent&&!res.writableEnded)json(res,502,{error:'Local adapter unavailable'});else res.destroy();});
   const copied={...response.headers};delete copied['transfer-encoding'];
   if(path.startsWith('/mobile/api/')||path.startsWith('/api/'))copied['cache-control']='no-store';
   if(copied['set-cookie'])copied['set-cookie']=copied['set-cookie'].map(v=>/;\s*Secure\b/i.test(v)?v:v+'; Secure');
   const asset=versionedAsset(path),encoding=preferredEncoding(req.headers['accept-encoding']),bodyLength=Number(copied['content-length']);
   const compress=encoding&&![204,206,304].includes(response.statusCode)&&!req.headers.range&&!copied['content-range']&&!copied['content-encoding']&&/text\/|javascript|json|svg/.test(copied['content-type']||'');
   if(asset||compress){varyEncoding(copied);weakEtag(copied);}
   if(compress){delete copied['content-length'];copied['content-encoding']=encoding;}
   const stream=()=>{res.writeHead(response.statusCode,copied);if(compress&&req.method!=='HEAD'){const compressor=encoding==='br'?createBrotliCompress(brotliOptions):createGzip();compressor.on('error',()=>res.destroy());response.pipe(compressor).pipe(res);}else response.pipe(res);};
   // Only public versioned code is cached, and its current upstream ETag is
   // checked on every request. Mutable compatibility/locale URLs revalidate;
   // pairing, API responses and session data never enter this cache.
   const cacheable=compress&&req.method==='GET'&&response.statusCode===200&&asset&&copied.etag&&!copied['set-cookie']&&/\bpublic\b/.test(copied['cache-control']||'')&&!/\b(?:private|no-store)\b/.test(copied['cache-control']||'')&&Number.isFinite(bodyLength)&&bodyLength<=8*1024*1024;
   let consuming=false;
   const encoded=cacheable?compressionCache.encode(req.url+'\0'+copied.etag+'\0'+encoding,bodyLength,async()=>{
    consuming=true;const chunks=[];let size=0;
    for await(const chunk of response){size+=chunk.length;if(size>8*1024*1024)throw Error('Static asset exceeds compression budget');chunks.push(chunk);}
    const raw=Buffer.concat(chunks);return encoding==='br'?brotliBuffer(raw,brotliOptions):gzipBuffer(raw);
   }):null;
   if(!encoded){stream();return;}
   if(!consuming)response.resume();
   encoded.then(bytes=>{if(res.destroyed||res.writableEnded)return;copied['content-length']=bytes.length;res.writeHead(response.statusCode,copied);res.end(bytes);},()=>{if(!res.headersSent&&!res.writableEnded)json(res,502,{error:'Static asset unavailable'});else res.destroy();});
  });
  proxy.on('timeout',()=>proxy.destroy());proxy.on('error',()=>{if(res.writableEnded)return;if(!res.headersSent)json(res,502,{error:'Local adapter unavailable'});else res.destroy();});
  req.on('aborted',()=>proxy.destroy());res.on('close',()=>{if(!res.writableFinished)proxy.destroy();});
  if(path==='/mobile/api/upload'){
   let size=0;const limit=new Transform({transform(chunk,encoding,done){size+=chunk.length;done(size>uploadBodyLimit?Error('Upload chunk too large'):null,chunk);}});
   limit.on('error',()=>{req.unpipe(limit);req.resume();proxy.destroy();if(!res.headersSent)json(res,413,{error:'Upload chunk too large'});else res.destroy();});
   req.pipe(limit).pipe(proxy);
  }else req.pipe(proxy);
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 server.on('upgrade',(req,socket,head)=>{
  const path=pathOf(req);if(!allowed(req)||req.headers.origin!==publicOrigin||!['/probe/ws','/ws'].includes(path)||path==='/ws'&&mode!=='codex-read'){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  if(path==='/probe/ws'){wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));return;}
  const pending=[];let bytes=0,client;
  const remote=new WebSocket(upstream.origin.replace(/^http/,'ws')+'/ws',{headers:{origin:upstream.origin,...(req.headers.cookie?{cookie:req.headers.cookie}:{})},maxPayload:8*1024*1024,handshakeTimeout:5000});
  const rejectUpgrade=status=>{if(!socket.destroyed&&!socket.writableEnded&&!client)socket.end('HTTP/1.1 '+status+'\r\nConnection: close\r\n\r\n');};
  upstreamSockets.add(remote);remote.on('close',()=>{upstreamSockets.delete(remote);client?.close(1012,'Reconnect');rejectUpgrade('502 Bad Gateway');});
  // Wait for the native adapter to authenticate before acknowledging the public
  // websocket. Attach message buffering immediately to retain its first frame.
  remote.on('message',(data,binary)=>{if(client?.readyState===1)client.send(data,{binary});else{bytes+=data.length;if(bytes>8*1024*1024){remote.close(1009);return;}pending.push([data,binary]);}});
  remote.on('error',()=>{remote.terminate();rejectUpgrade('403 Forbidden');});
  socket.on('error',()=>remote.terminate());
  socket.on('close',()=>remote.terminate());
  remote.on('open',()=>{
   if(socket.destroyed){remote.terminate();return;}
   const bridgeWss=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
   bridgeWss.handleUpgrade(req,socket,head,ws=>{
    client=ws;ws.on('error',()=>remote.terminate());ws.on('close',()=>{remote.close();bridgeWss.close();});
    ws.on('message',(data,binary)=>{if(!binary){ws.close(1003,'Binary RPC required');return;}if(remote.readyState===1)remote.send(data,{binary});});
    for(const [data,binary]of pending)ws.send(data,{binary});pending.length=0;
   });
  });
 });
 return{server,instance,get mode(){return mode;},get publicOrigin(){return publicOrigin;},setPublicOrigin(value){if(value===null){publicOrigin=null;return;}const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS origin required');publicOrigin=u.origin;},setMode(value){if(!['probe','codex-read'].includes(value))throw Error('Invalid mode');mode=value;},async close(){for(const ws of upstreamSockets)ws.terminate();for(const ws of wss.clients)ws.terminate();wss.close();for(const s of sockets)s.destroy();compressionCache.clear();await new Promise(r=>server.close(r));}};
}
