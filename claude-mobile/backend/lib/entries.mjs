import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * 三合一入口需要的三个真实手机地址。
 *
 * Codex 的配对密文在 URL 的 `#` 后面，只从本机回环适配器读取；
 * DSH 的口令走它自己的 status 接口；两边都不经过公网。
 */

const HOME=homedir();
const CODEX_STATE=join(HOME,'Library/Application Support/CodexMobileCpolar/state.json');
const CODEX_LOCAL='http://127.0.0.1:8796/local/info';
const DSH_STATUS='http://127.0.0.1:18902/_dsh/status';
const cache={at:0,codex:null,dsh:null};

async function codexEntry(origin){
  try{
    const state=JSON.parse(await readFile(CODEX_STATE,'utf8'));
    if(state.status!=='online'||state.mode!=='codex-read')return {ready:false,reason:'Codex 外网入口未就绪'};
    const tunnel=new URL(state.origin);
    if(tunnel.protocol!=='https:')return {ready:false,reason:'Codex 隧道地址异常'};
    const response=await fetch(CODEX_LOCAL,{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)return {ready:false,reason:'Codex 本机适配器未就绪'};
    const info=await response.json();
    const secret=new URL(info.url).hash;
    if(!/^#[A-Za-z0-9_-]{43}$/.test(secret))return {ready:false,reason:'Codex 配对信息异常'};
    return {ready:true,url:tunnel.origin+'/'+secret};
  }catch{
    return {ready:false,reason:'Codex 本机适配器未就绪'};
  }
}

async function dshEntry(origin){
  try{
    const target=new URL(DSH_STATUS);
    if(origin)target.searchParams.set('publicOrigin',origin);
    const response=await fetch(target.href,{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)return {ready:false,reason:'DSH 手机网关未启动'};
    const value=await response.json();
    if(value?.service!=='dsh-mobile'||!['online','local'].includes(value.status))return {ready:false,reason:'DSH 手机网关未就绪'};
    if(typeof value.phoneUrl!=='string')return {ready:false,reason:'DSH 手机地址无效'};
    return {ready:true,url:value.phoneUrl,upstreamReady:value.upstreamReady===true};
  }catch{
    return {ready:false,reason:'DSH 手机网关未启动'};
  }
}

/** @param {string|null} origin 当前隧道 HTTPS origin */
export async function readEntries(origin){
  const now=Date.now();
  if(now-cache.at<5000&&cache.codex&&cache.dsh&&cache.origin===origin){
    return {codex:cache.codex,dsh:cache.dsh};
  }
  const [codex,dsh]=await Promise.all([codexEntry(origin),dshEntry(origin)]);
  Object.assign(cache,{at:now,codex,dsh,origin});
  return {codex,dsh};
}
