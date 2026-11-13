import {readFile,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {readMagpieLaunch} from './claude-cli.mjs';

const CONFIG_LIBRARY=join(homedir(),'Library/Application Support/Claude-3p/configLibrary');
const LAUNCH_SETTINGS=join(homedir(),'.config/magpie/claude-launch/settings.json');
const has1m=value=>value.endsWith('[1m]');
const text=value=>typeof value==='string'&&value.length>0;
const unmapped=nativeModel=>({nativeModel,catalogId:null,label:null,mapped:false});

function counts(rows,key){
  const result=new Map();
  for(const row of rows)if(text(row[key]))result.set(row[key],(result.get(row[key])??0)+1);
  return result;
}

// A full label must occur exactly once on BOTH sides. Never infer identities
// from array positions, numeric alias suffixes, or abbreviated display labels.
function buildMaps(nativeRows,catalogRows){
  const nativeLabels=counts(nativeRows,'label'),catalogLabels=counts(catalogRows,'label');
  const nativeIds=counts(nativeRows,'id'),catalogIds=counts(catalogRows,'model');
  const catalogByLabel=new Map(catalogRows.map(row=>[row.label,row]));
  const candidates=[];
  for(const row of nativeRows){
    if(!text(row.id)||!text(row.label)||nativeLabels.get(row.label)!==1||nativeIds.get(row.id)!==1)continue;
    const option=catalogByLabel.get(row.label);
    if(!option||!text(option.model)||catalogLabels.get(row.label)!==1||catalogIds.get(option.model)!==1)continue;
    let alias=row.id;
    // Static inferenceModels names may omit the optional 1M suffix. Only the
    // explicit supports1m capability permits this native variant.
    if(row.supports1m===true&&!has1m(alias)&&has1m(option.model))alias+='[1m]';
    if(has1m(alias)!==has1m(option.model))continue;
    candidates.push({nativeModel:alias,catalogId:option.model,label:row.label,mapped:true});
  }
  const aliasCounts=counts(candidates,'nativeModel');
  const byNative=new Map(),byCatalog=new Map();
  for(const result of candidates){
    if(aliasCounts.get(result.nativeModel)!==1)continue;
    byNative.set(result.nativeModel,result);byCatalog.set(result.catalogId,result);
  }
  return {byNative,byCatalog};
}

/** Read-only alias resolver. All methods are async; no gateway credentials or
 * transport errors are returned. Cache identities, never a session's selection.
 */
export class DesktopModels {
  #cache=null;
  #loading=null;
  constructor({readLaunch=readMagpieLaunch,configLibraryDir=CONFIG_LIBRARY,launchSettingsPath=LAUNCH_SETTINGS,
    readFile:read=readFile,stat:inspect=stat,fetch:fetchImpl=globalThis.fetch,now=Date.now,
    cacheMs=60_000,timeoutMs=5_000}={}){
    Object.assign(this,{readLaunch,configLibraryDir,launchSettingsPath,read,inspect,fetchImpl,now,cacheMs,timeoutMs});
  }
  async #stamp(path){
    try{const value=await this.inspect(path);return [value.mtimeMs,value.ctimeMs,value.size].join(':');}
    catch{return 'missing';}
  }
  async #source(){
    const metaPath=join(this.configLibraryDir,'_meta.json');
    const meta=JSON.parse(await this.read(metaPath,'utf8'));
    if(typeof meta.appliedId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.appliedId))throw Error('Invalid desktop provider');
    const path=join(this.configLibraryDir,meta.appliedId+'.json');
    const stamps=await Promise.all([this.#stamp(metaPath),this.#stamp(path),this.#stamp(this.launchSettingsPath)]);
    return {path,fingerprint:JSON.stringify([meta.appliedId,...stamps])};
  }
  async #nativeRows(config){
    if(Array.isArray(config.inferenceModels))return config.inferenceModels.map(row=>({
      id:row?.name,label:row?.labelOverride,supports1m:row?.supports1m===true,
    }));
    if(config.inferenceProvider!=='gateway'||!text(config.inferenceGatewayBaseUrl))return [];
    const scheme=config.inferenceGatewayAuthScheme;
    if(scheme&&scheme!=='bearer'&&scheme!=='none')return [];
    const headers={'User-Agent':'claude-desktop',Accept:'application/json'};
    if(scheme!=='none'&&text(config.inferenceGatewayApiKey))headers.Authorization='Bearer '+config.inferenceGatewayApiKey;
    const url=new URL(config.inferenceGatewayBaseUrl);
    url.pathname=url.pathname.replace(/\/+$/,'').replace(/\/v1$/,'')+'/v1/models';
    const controller=new AbortController();
    let timer;
    try{
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
        controller.abort();reject(Error('Desktop model discovery timed out'));
      },this.timeoutMs);});
      const data=await Promise.race([deadline,(async()=>{
        const response=await this.fetchImpl(url.href,{headers,signal:controller.signal,redirect:'error'});
        if(!response.ok)throw Error('Desktop model discovery unavailable');
        return response.json();
      })()]);
      return Array.isArray(data?.data)?data.data.map(row=>({id:row?.id,label:row?.display_name})):[];
    }finally{clearTimeout(timer);}
  }
  async #ensure(source,force=false){
    if(this.#loading){
      const loading=this.#loading;
      await loading.promise;
      if(loading.fingerprint===source.fingerprint)return this.#cache;
    }
    const previous=this.#cache;
    if(!force&&previous?.fingerprint===source.fingerprint&&this.now()-previous.loadedAt<this.cacheMs)return previous;
    const promise=(async()=>{
      let maps={byNative:new Map(),byCatalog:new Map()};
      try{
        const [config,launch]=await Promise.all([
          this.read(source.path,'utf8').then(JSON.parse),this.readLaunch(),
        ]);
        const options=Array.isArray(launch?.models)?launch.models:Array.isArray(launch?.options)?launch.options:launch?.modelPicker?.options;
        maps=buildMaps(await this.#nativeRows(config),Array.isArray(options)?options.filter(row=>row&&typeof row==='object'):[]);
      }catch{/* Fail closed. Raw fetch/config errors can contain credentials. */}
      this.#cache={...maps,fingerprint:source.fingerprint,loadedAt:this.now(),
        misses:force&&previous?.fingerprint===source.fingerprint?previous.misses:new Set()};
      return this.#cache;
    })();
    this.#loading={fingerprint:source.fingerprint,promise};
    try{return await promise;}finally{if(this.#loading?.promise===promise)this.#loading=null;}
  }
  async #lookup(key,direction){
    if(!text(key))return null;
    try{
      const source=await this.#source();
      const previous=this.#cache;
      let cache=await this.#ensure(source);
      let result=cache[direction].get(key);
      // A newly discovered catalog is already a refresh. Repeated unknown
      // aliases get at most one extra refresh per cache generation.
      const missKey=direction+':'+key;
      if(!result&&cache===previous&&!cache.misses.has(missKey)){
        cache.misses.add(missKey);
        cache=await this.#ensure(source,true);result=cache[direction].get(key);
      }
      if(!result)cache.misses.add(missKey);
      return result?{...result}:null;
    }catch{this.#cache=null;return null;}
  }
  async resolve(nativeAlias){return await this.#lookup(nativeAlias,'byNative')??unmapped(nativeAlias);}
  async nativeFor(catalogId){return (await this.#lookup(catalogId,'byCatalog'))?.nativeModel??null;}
}
