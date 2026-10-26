import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';

export function extractCpolarOrigins(text){
 const values=text.match(/https:\/\/[a-z0-9.-]+\.cpolar\.(?:cn|top|io|vip|net|online)(?::\d+)?/gi)||[];
 return [...new Set(values.map(v=>new URL(v).origin))];
}
export async function verifyPublic(origin,instance,{fetchImpl=fetch,wsConnect=(url,options)=>new WebSocket(url,options),timeout=10000}={}){
 const health=await fetchImpl(origin+'/healthz',{signal:AbortSignal.timeout(timeout),redirect:'error',cache:'no-store'});
 if(!health.ok)throw Error('HTTPS health check failed: '+health.status);
 const result=await health.json();if(result.service!=='codex-cpolar-ingress'||result.instance!==instance)throw Error('Wrong local service behind tunnel');
 await new Promise((resolve,reject)=>{
  const ws=wsConnect(origin.replace(/^http/,'ws')+'/probe/ws',{origin,handshakeTimeout:timeout,maxPayload:1024});
  const nonce='cpolar-probe:'+instance,timer=setTimeout(()=>done(Error('WebSocket verification timed out')),timeout);
  let complete=false;
  function done(error){if(complete)return;complete=true;clearTimeout(timer);ws.terminate();error?reject(error):resolve();}
  ws.on('open',()=>ws.send(Buffer.from(nonce)));ws.on('message',data=>done(data.toString()===nonce?null:Error('WebSocket echo mismatch')));ws.on('error',done);ws.on('close',()=>done(Error('WebSocket closed before echo')));
 });
 return true;
}

export class CpolarTunnel extends EventEmitter{
 constructor({binary,configPath,port,instance,onCandidate=()=>{},spawnProcess=spawn,verify=verifyPublic,checkInterval=30000,retryDelay=2000,startupTimeout=45000}){
  super();Object.assign(this,{binary,configPath,port,instance,onCandidate,spawnProcess,verify,checkInterval,retryDelay,startupTimeout});
  this.state={status:'waiting-account',origin:null,verifiedAt:null};this.generation=0;this.attempt=0;this.failures=0;this.seen=new Set();
 }
 update(patch){this.state={...this.state,...patch};this.emit('state',this.state);}
 start(){this.stopped=false;this.launch();this.interval=setInterval(()=>this.check(),this.checkInterval);return this;}
 launch(){
  if(this.stopped)return;const generation=++this.generation;this.output='';this.candidate=null;this.failures=0;this.seen.clear();this.onCandidate(null);this.update({status:'connecting',origin:null,verifiedAt:null});
  // Isolated config, no default dashboard or traffic capture, HTTPS-only,
  // explicit China region. Never pass an authentication token in argv.
  const args=['http','-config',this.configPath,'-region','cn','-proto','https','-inspect-addr','false','-dashboard','off','-log','stdout','-log-level','INFO',String(this.port)];
  const child=this.spawnProcess(this.binary,args,{stdio:['ignore','pipe','pipe']});this.child=child;
  const consume=data=>{
   if(generation!==this.generation||this.stopped)return;this.output=(this.output+data.toString()).slice(-24000);
   if(/(?:ERR_CPOLAR|authentication failed|invalid authtoken|authtoken.*(?:invalid|required)|account.*(?:required|invalid))/i.test(this.output))this.update({status:'account-required',origin:null,verifiedAt:null});
   for(const origin of extractCpolarOrigins(this.output))if(!this.seen.has(origin)){
    this.seen.add(origin);this.candidate=origin;this.onCandidate(origin);this.update({status:'checking',origin:null,verifiedAt:null});this.check();
   }
  };
  child.stdout.on('data',consume);child.stderr.on('data',consume);
  child.on('error',()=>{if(generation===this.generation)this.reconnect('client-start-failed');});
  child.on('exit',()=>{if(generation===this.generation&&!this.stopped)this.reconnect('client-exited');});
  this.startupTimer=setTimeout(()=>{if(generation===this.generation&&!this.state.origin)this.reconnect('no-verified-endpoint');},this.startupTimeout);
 }
 async check(){
  if(this.stopped||!this.candidate||this.checking)return;const generation=this.generation,origin=this.candidate;this.checking=true;
  try{await this.verify(origin,this.instance);if(generation!==this.generation||origin!==this.candidate||this.stopped)return;this.failures=0;this.attempt=0;clearTimeout(this.startupTimer);this.update({status:'online',origin,verifiedAt:Date.now()});}
  catch{if(generation!==this.generation||this.stopped)return;this.update({status:'checking',origin:null,verifiedAt:null});if(++this.failures>=2)this.reconnect('verification-failed');}
  finally{this.checking=false;}
 }
 reconnect(reason){if(this.stopped)return;++this.generation;clearTimeout(this.startupTimer);clearTimeout(this.retryTimer);this.candidate=null;this.onCandidate(null);this.child?.kill('SIGTERM');this.update({status:'reconnecting',origin:null,verifiedAt:null,reason});this.retryTimer=setTimeout(()=>this.launch(),Math.min(this.retryDelay*2**this.attempt++,30000));}
 stop(){this.stopped=true;++this.generation;clearTimeout(this.startupTimer);clearTimeout(this.retryTimer);clearInterval(this.interval);this.child?.kill('SIGTERM');this.onCandidate(null);this.update({status:'stopped',origin:null,verifiedAt:null});}
}
