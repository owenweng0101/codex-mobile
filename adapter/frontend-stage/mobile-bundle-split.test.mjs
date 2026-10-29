import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {applyMobileSplit,bundleSha} from './mobile-split-rebuild.mjs';
const manifest=JSON.parse(await readFile(new URL('./bundle-patch-manifest.json',import.meta.url),'utf8'));
const source=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
const split=manifest.mobileSplit;
const start=source.indexOf('function __mobileDeferredModule('),end=source.indexOf('function __mobileDeferredComponent(',start),componentEnd=source.indexOf('var __mobilePagesLoader=',end);
assert(start>=0&&end>start&&componentEnd>end);
const deferred=vm.runInNewContext('('+source.slice(start,end)+')',{Promise,Error,setTimeout,clearTimeout});
const component=vm.runInNewContext('('+source.slice(end,componentEnd).trim()+')',{Promise});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('the split rebuild preserves every original compatibility patch and all content-hash assets',async()=>{
 let original=await readFile(new URL('./baseline/index-BsmXQHMM.js',import.meta.url),'utf8');
 assert.equal(manifest.patches.length,85);assert.equal(manifest.exactReplacementCount,85);
 for(const patch of manifest.patches){assert.equal(original.split(patch.needle).length-1,patch.count,patch.name);original=original.split(patch.needle).join(patch.replacement);}
 assert.equal(bundleSha(original),split.inputSha256);assert.equal(applyMobileSplit(original,split),source);assert.equal(bundleSha(source),split.outputSha256);
 assert(source.includes('"data-testid":`sidebar-view-timeline`'));
 assert(!source.includes('!1&&(0,$.jsxs)(vb,{children:[(0,$.jsx)(uy,{title:i.formatMessage({id:`project.view`})'));
 for(const asset of split.assets){const bytes=await readFile(new URL('../../vendor/zcode-web/remote/v4/3.16.3/assets/'+asset.name,import.meta.url));assert.equal(bundleSha(bytes),asset.sha256);assert.equal(bytes.length,asset.bytes);assert(asset.name.includes(asset.sha256.slice(0,20)));}
 assert.throws(()=>applyMobileSplit(original+' ',split),/input changed/);
 const changed=structuredClone(split);changed.stages[0].edits[0].beforeSha256='0'.repeat(64);assert.throws(()=>applyMobileSplit(original,changed),/source slice changed/);
});
test('simultaneous lazy callers share a module factory and retain its identities',async()=>{
 let calls=0,release;const value={view:()=>null},get=deferred(()=>{calls++;return new Promise(resolve=>release=resolve);});
 const first=get(),second=get();assert.equal(first,second);await tick();assert.equal(calls,1);release(value);assert.equal(await first,value);assert.equal(await get(),value);assert.equal(calls,1);
});
test('a failed lazy import releases its attempt and retries under a new URL',async()=>{
 const suffixes=[];const get=deferred(suffix=>{suffixes.push(suffix);if(suffixes.length===1)throw Error('offline');return 'healthy';});
 await assert.rejects(get(),/offline/);assert.equal(await get(),'healthy');assert.deepEqual(suffixes,['','?retry=2']);assert.equal(await get(),'healthy');
});
test('a late import after timeout cannot initialize its expired factory or replace the retry',async()=>{
 let calls=0,finish,initializations=0;
 const get=deferred((_suffix,current)=>{
  const module=++calls===1?new Promise(resolve=>finish=resolve):Promise.resolve('new');
  return module.then(value=>{if(!current())throw Error('expired factory');initializations++;return value;});
 },{timeoutMs:12,label:'测试'});
 await assert.rejects(get(),/加载超时/);assert.equal(await get(),'new');finish('old');await tick();assert.equal(initializations,1);assert.equal(await get(),'new');
});
test('late failed imports cannot clear a newer successful module',async()=>{
 let calls=0,rejectOld;const get=deferred(()=>++calls===1?new Promise((_resolve,reject)=>rejectOld=reject):'new',{timeoutMs:12});
 await assert.rejects(get(),/超时/);assert.equal(await get(),'new');rejectOld(Error('late'));await tick();assert.equal(await get(),'new');assert.equal(calls,2);
});
function hooks(){
 const states=[],effects=[],slots=[];let cursor=0,alive=true,writes=0;
 const React={useState(initial){const id=cursor++;if(!(id in states))states[id]=initial;return[states[id],next=>{writes++;states[id]=typeof next==='function'?next(states[id]):next;}];},useEffect(work,deps){const id=cursor++;const old=slots[id];if(!old||deps.some((value,index)=>value!==old.deps[index]))effects.push(()=>{old?.cleanup?.();slots[id]={deps,cleanup:work()};});}};
 const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
 return{React,jsx,render(view,props){assert(alive);cursor=0;const value=view(props);for(const effect of effects.splice(0))effect();return value;},unmount(){alive=false;for(const effect of slots)effect?.cleanup?.();},get writes(){return writes;}};
}
test('the deferred component keeps the original props and offers a working retry after import failure',async()=>{
 const harness=hooks();let calls=0;const Original=()=>null,View=component(harness.React,harness.jsx,async()=>{if(++calls===1)throw Error('offline');return Original;});
 const props={native:'identity'};assert.equal(harness.render(View,props).props.role,'status');await tick();const failed=harness.render(View,props);assert.equal(failed.props.role,'alert');failed.props.children[1].props.onClick();harness.render(View,props);await tick();const ready=harness.render(View,props);assert.equal(ready.type,Original);assert.equal(ready.props,props);harness.unmount();
});
test('an unmounted deferred component ignores a later resolved module',async()=>{
 const harness=hooks();let release;const View=component(harness.React,harness.jsx,()=>new Promise(resolve=>release=resolve));harness.render(View,{});await tick();harness.unmount();const before=harness.writes;release(()=>null);await tick();assert.equal(harness.writes,before);
});
test('Codex question navigation never auto-hydrates the whole desktop history while other hosts retain their behavior',()=>{
 const start=source.indexOf('function qpt('),end=source.indexOf('}',start)+1;assert(start>=0&&end>start);const fn=source.slice(start,end);
 const state={canLoadOlder:true,loadingOlder:false,hasLoadHandler:true,containerWidthPx:1200};
 const codex=vm.runInNewContext('('+fn+')',{__CODEX_ORIGINAL_BRIDGE__:{codexBridge:true}}),other=vm.runInNewContext('('+fn+')');
 assert.equal(codex(state),false);assert.equal(other(state),true);assert.equal(other({...state,containerWidthPx:390}),false);assert.equal(other({...state,loadingOlder:true}),false);
});
test('a retired queued Mermaid render is skipped while the current graph still renders',async()=>{
 const start=source.indexOf('function sze('),end=source.indexOf('function ',start+9),body=source.slice(start,end);
 const queueStart=source.indexOf('function eze('),queueEnd=source.indexOf('function ',queueStart+9),queue=source.slice(queueStart,queueEnd);
 async function run(cancelQueued){
  const calls=[],effects=[],delivered=[];let release,identity=0;
  const context={Promise,ZRe:Promise.resolve(),q:()=>({intl:{formatMessage:({id})=>id}}),aze:()=>false,ize:()=>false,rze:()=>({}),tze:value=>value,Z:value=>value,Po:()=>null,oze:String,J:{debug(){}},$:{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},Q:{useId:()=>String(++identity),useMemo:work=>work(),useState:()=>[{},()=>{}],useEffect:work=>effects.push(work())},XRe:{getMermaid:()=>({render(_id,code){calls.push(code);return code==='A'?new Promise(resolve=>release=resolve):Promise.resolve({svg:code});}})}};
  vm.createContext(context);vm.runInContext(queue+body+';globalThis.Block=sze',context);
  context.Block({code:'A',onPreviewSvgChange:value=>value&&delivered.push(value)});await tick();
  context.Block({code:'B',onPreviewSvgChange:value=>value&&delivered.push(value)});
  context.Block({code:'C',onPreviewSvgChange:value=>value&&delivered.push(value)});
  if(cancelQueued)effects[1]();release({svg:'A'});await tick();await tick();return{calls,delivered};
 }
 const active=await run(false);assert.deepEqual(active.calls,['A','B','C']);
 const cancelled=await run(true);assert.deepEqual(cancelled.calls,['A','C']);assert.deepEqual(cancelled.delivered,['A','C']);
});
test('Mermaid configuration stays synchronous and the original engine is initialized only for render',async()=>{
 const start=source.indexOf('function WRe('),body=source.indexOf('){',start)+1;let depth=0,end=body;
 for(;end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}'&&--depth===0){end++;break;}}
 assert(start>=0&&end>start);
 const initialized=[],rendered=[];let reads=0;
 const create=vm.runInNewContext('('+source.slice(start,end).replace(/;?$/,'')+')',{URe:{theme:'default'},__mobileMermaidLoader:async()=>{reads++;return{rb:{initialize:value=>initialized.push(value),render:async(id,code)=>{rendered.push([id,code]);return{svg:'actual-original-result'};}}};}});
 const engine=create({config:{securityLevel:'strict'}});engine.getMermaid({theme:'dark'});assert.equal(reads,0);assert.equal(initialized.length,0);
 assert.equal((await engine.getMermaid().render('first','A-->B')).svg,'actual-original-result');assert.equal(initialized.length,1);assert.equal(initialized[0].theme,'dark');assert.equal(initialized[0].securityLevel,'strict');
 await engine.getMermaid().render('second','C-->D');assert.equal(initialized.length,1);assert.deepEqual(rendered,[['first','A-->B'],['second','C-->D']]);
});
test('optional factories do not initialize when their content-hash modules are merely imported',async()=>{
 const pages=split.assets.find(asset=>asset.name.startsWith('mobile-pages-')),terminal=split.assets.find(asset=>asset.name.startsWith('mobile-terminal-'));
 for(const asset of [pages,terminal]){const module=await import(new URL('../../vendor/zcode-web/remote/v4/3.16.3/assets/'+asset.name,import.meta.url));assert.equal(typeof Object.values(module)[0],'function');}
});
