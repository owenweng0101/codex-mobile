import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopModels} from '../backend/lib/desktop-models.mjs';

const A='00000000-0000-4000-8000-6d6167706965',B='00000000-0000-4000-8000-000000000002';
const DIR='/fixture/configLibrary',LAUNCH='/fixture/launch.json';
const JD='mythos-magpie-4878527091[1m]',JD2='mythos-magpie-3269100859[1m]';
const MODEL='jd/DeepSeek-V4.1-Flash-A-joybuilder[1m]',MODEL2='jd2/DeepSeek-V4.1-Flash-a[1m]';
const LABEL='DeepSeek-V4.1-Flash-A-joybuilder · JD',LABEL2='DeepSeek-V4.1-Flash-a · JD2';
const result=(nativeModel,catalogId,label)=>({nativeModel,catalogId,label,mapped:true});
const missing=nativeModel=>({nativeModel,catalogId:null,label:null,mapped:false});

function fixture(deps={}){
  const f={time:0,requests:[],files:new Map(),versions:new Map(),
    rows:[{id:JD,display_name:LABEL},{id:JD2,display_name:LABEL2}],
    options:[{model:MODEL,label:LABEL},{model:MODEL2,label:LABEL2}],
    config:{inferenceProvider:'gateway',inferenceGatewayAuthScheme:'bearer',
      inferenceGatewayBaseUrl:'https://gateway.invalid/root/',inferenceGatewayApiKey:'fixture-private-key'}};
  f.write=(path,value)=>{f.files.set(path,JSON.stringify(value));f.versions.set(path,(f.versions.get(path)??0)+1);};
  f.write(DIR+'/_meta.json',{appliedId:A});f.write(DIR+'/'+A+'.json',f.config);f.write(LAUNCH,{});
  f.models=new DesktopModels({configLibraryDir:DIR,launchSettingsPath:LAUNCH,now:()=>f.time,
    readFile:async path=>{if(!f.files.has(path))throw Error('missing fixture');return f.files.get(path);},
    stat:async path=>{if(!f.files.has(path))throw Error('missing fixture');return {mtimeMs:f.versions.get(path),ctimeMs:0,size:f.files.get(path).length};},
    readLaunch:async()=>({models:structuredClone(f.options)}),
    fetch:async(url,options)=>{f.requests.push({url,options});return f.respond?f.respond(url,options):{ok:true,json:async()=>({data:structuredClone(f.rows)})};},
    ...deps});
  return f;
}

test('exact JD/JD2 mapping uses full labels, independent of ordering and selection',async()=>{
  const f=fixture();f.options.reverse();
  assert.deepEqual(await f.models.resolve(JD),result(JD,MODEL,LABEL));
  assert.deepEqual(await f.models.resolve(JD2),result(JD2,MODEL2,LABEL2));
  assert.equal(await f.models.nativeFor(MODEL2),JD2);
  assert.equal(await f.models.nativeFor(MODEL),JD);
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'https://gateway.invalid/root/v1/models');
  assert.equal(f.requests[0].options.headers['User-Agent'],'claude-desktop');
  assert.equal(f.requests[0].options.headers.Authorization,'Bearer fixture-private-key');
  assert.equal(f.requests[0].options.redirect,'error');
  const copy=await f.models.resolve(JD);copy.catalogId='changed';
  assert.equal((await f.models.resolve(JD)).catalogId,MODEL);
});

test('60-second cache expires at the boundary',async()=>{
  const f=fixture();assert.equal(f.models.cacheMs,60_000);assert.equal(f.models.timeoutMs,5_000);
  await f.models.resolve(JD);f.time=59_999;await f.models.resolve(JD);
  assert.equal(f.requests.length,1);
  f.time=60_000;await f.models.resolve(JD);assert.equal(f.requests.length,2);
});

test('unknown alias refreshes a cached directory once; repeated misses do not refetch',async()=>{
  const f=fixture();await f.models.resolve(JD);
  const next='mythos-magpie-9999999999[1m]';f.rows[0].id=next;
  assert.deepEqual(await f.models.resolve(next),result(next,MODEL,LABEL));
  assert.equal(f.requests.length,2);
  assert.deepEqual(await f.models.resolve('not-in-catalog'),missing('not-in-catalog'));
  assert.equal(f.requests.length,3);
  await f.models.resolve('not-in-catalog');await f.models.resolve('not-in-catalog');
  assert.equal(f.requests.length,3);
  assert.equal(await f.models.nativeFor(MODEL),next);
});

test('a cold unknown query needs only its initial discovery',async()=>{
  const f=fixture();assert.deepEqual(await f.models.resolve('missing'),missing('missing'));
  await f.models.resolve('missing');assert.equal(f.requests.length,1);
});

test('simultaneous lookups share discovery',async()=>{
  const f=fixture();
  const values=await Promise.all(Array.from({length:8},(_,i)=>f.models.resolve(i%2?JD:JD2)));
  assert.equal(f.requests.length,1);assert.ok(values.every(value=>value.mapped));
});

test('appliedId changes invalidate immediately without waiting for TTL',async()=>{
  const f=fixture();await f.models.resolve(JD);
  f.write(DIR+'/'+B+'.json',{inferenceModels:[{name:'static-alias[1m]',labelOverride:LABEL}]});
  f.write(DIR+'/_meta.json',{appliedId:B});
  assert.equal(await f.models.nativeFor(MODEL),'static-alias[1m]');
  assert.deepEqual(await f.models.resolve(JD),missing(JD));
  assert.equal(f.requests.length,1);
});

test('provider mtime and launch mtime each invalidate the directory',async()=>{
  const f=fixture();await f.models.resolve(JD);
  f.rows[0].id='replacement[1m]';f.write(DIR+'/'+A+'.json',f.config);
  assert.equal(await f.models.nativeFor(MODEL),'replacement[1m]');assert.equal(f.requests.length,2);
  f.options[0].model='jd/new-catalog-id[1m]';f.write(LAUNCH,{changed:true});
  assert.equal((await f.models.resolve('replacement[1m]')).catalogId,'jd/new-catalog-id[1m]');
  assert.equal(f.requests.length,3);
});

test('duplicate full labels on either side reject both directions',async()=>{
  for(const side of ['native','catalog']){
    const f=fixture();
    if(side==='native')f.rows.push({id:'duplicate[1m]',display_name:LABEL});
    else f.options.push({model:'another-catalog[1m]',label:LABEL});
    assert.deepEqual(await f.models.resolve(JD),missing(JD));
    assert.equal(await f.models.nativeFor(MODEL),null);
    assert.equal((await f.models.resolve(JD2)).catalogId,MODEL2);
  }
});

test('duplicate IDs with different labels cannot produce a misleading reverse mapping',async()=>{
  for(const side of ['native','catalog']){
    const f=fixture();if(side==='native')f.rows[1].id=JD;else f.options[1].model=MODEL;
    assert.deepEqual(await f.models.resolve(JD),missing(JD));
    assert.equal(await f.models.nativeFor(MODEL),null);
  }
});

test('labels are exact: no case folding, abbreviation, trimming, or positional fallback',async()=>{
  for(const label of [LABEL.toLowerCase(),LABEL+' ',LABEL.split(' · ')[0]]){
    const f=fixture();f.options[0].label=label;
    assert.deepEqual(await f.models.resolve(JD),missing(JD));
    assert.equal(await f.models.nativeFor(MODEL),null);
  }
});

test('dynamic 1m suffix must match exactly; aliases and catalog IDs remain intact',async()=>{
  for(const side of ['native','catalog']){
    const f=fixture();if(side==='native')f.rows[0].id=JD.replace('[1m]','');else f.options[0].model=MODEL.replace('[1m]','');
    const alias=f.rows[0].id;
    assert.deepEqual(await f.models.resolve(alias),missing(alias));
    assert.equal(await f.models.nativeFor(f.options[0].model),null);
  }
  const f=fixture();f.rows=[{id:'plain-alias',display_name:'GPT · OpenAI'}];f.options=[{model:'openai/gpt',label:'GPT · OpenAI'}];
  assert.deepEqual(await f.models.resolve('plain-alias'),result('plain-alias','openai/gpt','GPT · OpenAI'));
});

test('static inferenceModels use name/labelOverride with explicit supports1m',async()=>{
  const f=fixture();f.write(DIR+'/'+A+'.json',{inferenceModels:[
    {name:'static',labelOverride:LABEL,supports1m:true,prefer1m:true},
    {name:'static2[1m]',labelOverride:LABEL2},
  ]});
  assert.deepEqual(await f.models.resolve('static[1m]'),result('static[1m]',MODEL,LABEL));
  assert.equal(await f.models.nativeFor(MODEL2),'static2[1m]');
  assert.deepEqual(await f.models.resolve('static'),missing('static'));
  assert.equal(f.requests.length,0);
  f.write(DIR+'/'+A+'.json',{inferenceModels:[{name:'static',labelOverride:LABEL,prefer1m:true}]});
  assert.equal(await f.models.nativeFor(MODEL),null);
});

test('launch.options is accepted alongside readMagpieLaunch.models',async()=>{
  const f=fixture({readLaunch:async()=>({options:[{model:MODEL,label:LABEL}]})});
  assert.equal((await f.models.resolve(JD)).catalogId,MODEL);
});

test('invalid/missing applied provider fails closed and never reuses a stale mapping',async()=>{
  const f=fixture();await f.models.resolve(JD);
  f.write(DIR+'/_meta.json',{appliedId:'../unsafe-provider'});
  assert.deepEqual(await f.models.resolve(JD),missing(JD));
  assert.equal(await f.models.nativeFor(MODEL),null);assert.equal(f.requests.length,1);
});

test('fetch errors, invalid JSON/data and HTTP errors expose no gateway secrets',async()=>{
  for(const respond of [
    async()=>{throw Error('https://secret.invalid/?token=fixture-private-key');},
    async()=>({ok:false,status:401}),
    async()=>({ok:true,json:async()=>{throw Error('secret JSON failure');}}),
    async()=>({ok:true,json:async()=>({data:null})}),
  ]){
    const f=fixture();f.respond=respond;
    const value=await f.models.resolve(JD);
    assert.deepEqual(value,missing(JD));assert.doesNotMatch(JSON.stringify(value),/secret|private-key|https:/);
  }
});

test('timeout aborts fetch and also bounds a stalled response body',async()=>{
  for(const bodyStall of [false,true]){
    const f=fixture({timeoutMs:15});let signal;
    f.respond=async(_url,options)=>{signal=options.signal;
      if(bodyStall)return {ok:true,json:()=>new Promise(()=>{})};
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('private transport error')),{once:true}));
    };
    assert.deepEqual(await f.models.resolve(JD),missing(JD));assert.equal(signal.aborted,true);
  }
});

test('gateway /v1 suffix is not doubled, and empty input does not perform discovery',async()=>{
  const f=fixture();f.config.inferenceGatewayBaseUrl='https://gateway.invalid/v1/';f.write(DIR+'/'+A+'.json',f.config);
  assert.deepEqual(await f.models.resolve(''),missing(''));assert.equal(await f.models.nativeFor(''),null);
  assert.equal(f.requests.length,0);await f.models.resolve(JD);
  assert.equal(f.requests[0].url,'https://gateway.invalid/v1/models');
});
