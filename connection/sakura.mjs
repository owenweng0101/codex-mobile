import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {dirname} from 'node:path';
import {verifyPublic} from './cpolar.mjs';

export class SakuraTunnel extends EventEmitter{
 constructor({binary,configPath,origin,instance,onCandidate=()=>{},spawnProcess=spawn,verify=verifyPublic,checkInterval=15000,retryDelay=2000}){
  super();const url=new URL(origin);
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.nyat.app')||Number(url.port)<1024||Number(url.port)>65535)throw Error('Invalid Sakura HTTPS origin');
  Object.assign(this,{binary,configPath,origin:url.origin,instance,onCandidate,spawnProcess,verify,checkInterval,retryDelay});
  this.state={provider:'sakura',status:'connecting',origin:null,verifiedAt:null};this.generation=0;this.attempt=0;
 }
 update(patch){this.state={...this.state,...patch};this.emit('state',this.state);}
 start(){this.stopped=false;this.launch();this.interval=setInterval(()=>this.check(),this.checkInterval);return this;}
 launch(){
  if(this.stopped)return;const generation=++this.generation;this.onCandidate(this.origin);this.update({status:'connecting',origin:null,verifiedAt:null});
  // Credentials stay in the private config file, never in process arguments or logs.
  const child=this.spawnProcess(this.binary,['-c',this.configPath],{cwd:dirname(this.configPath),stdio:['ignore','pipe','pipe']});this.child=child;
  child.stdout.on('data',()=>this.check());child.stderr.on('data',()=>{});
  const exited=()=>{if(generation!==this.generation||this.stopped)return;++this.generation;this.onCandidate(null);this.update({status:'reconnecting',origin:null,verifiedAt:null});this.retryTimer=setTimeout(()=>this.launch(),Math.min(this.retryDelay*2**this.attempt++,30000));};
  child.on('error',exited);child.on('exit',exited);this.check();
 }
 async check(){
  if(this.stopped||!this.child||this.checking||this.state.status==='reconnecting')return;const generation=this.generation;this.checking=true;
  try{await this.verify(this.origin,this.instance);if(this.stopped||generation!==this.generation)return;this.attempt=0;this.update({status:'online',origin:this.origin,verifiedAt:Date.now()});}
  catch{if(!this.stopped&&generation===this.generation)this.update({status:'checking',origin:null,verifiedAt:null});}
  finally{this.checking=false;}
 }
 stop(){this.stopped=true;++this.generation;clearInterval(this.interval);clearTimeout(this.retryTimer);this.child?.kill('SIGTERM');this.onCandidate(null);this.update({status:'stopped',origin:null,verifiedAt:null});}
}
