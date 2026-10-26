import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {brotliCompressSync,constants,gzipSync} from 'node:zlib';
import {applyMobileSplit,bundleSha as sha} from '../adapter/frontend-stage/mobile-split-rebuild.mjs';
const root=path.resolve(import.meta.dirname,'..'),frontend=path.join(root,'adapter/frontend-stage');
const assets=path.join(root,'vendor/zcode-web/remote/v4/3.16.3/assets'),mainPath=path.join(frontend,'assets/index-BsmXQHMM.js');
const manifestPath=path.join(frontend,'bundle-patch-manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
const basePatchCount=86,expectedInput='5aca127d28bb065919c6833a415c21b8f948f4cce1cceb39b4a6a7b75af959e3';
assert.equal(manifest.patches.length,basePatchCount,'Build original compatibility patches before splitting');
let source=fs.readFileSync(path.join(frontend,'baseline/index-BsmXQHMM.js'),'utf8');
assert.equal(sha(source),manifest.baselineSHA256);
for(const patch of manifest.patches){assert.equal(source.split(patch.needle).length-1,patch.count,patch.name);source=source.split(patch.needle).join(patch.replacement);}
assert.equal(sha(source),expectedInput,'Reviewed mobile base changed; re-audit before changing this identity');
const initial=source,require=createRequire(import.meta.url),babelRoot=process.env.CODEX_MOBILE_BABEL_ROOT;
assert.equal(typeof globalThis.gc,'function','Run this offline build with node --expose-gc to bound AST memory');
const dependency=name=>require(babelRoot?path.join(babelRoot,name):name);
const {parse}=dependency('@babel/parser'),traverse=dependency('@babel/traverse').default,generate=dependency('@babel/generator').default;
const stages=[],outputs=new Map(),proofs=[];
const cleanup=()=>{traverse.cache.clear();globalThis.gc?.();};
const mark=name=>console.error(name,Math.round(process.memoryUsage().heapUsed/1048576)+' MiB');
function graph(text){
 const ast=parse(text,{sourceType:'module'});let scope;traverse(ast,{Program(p){scope=p.scope;p.stop();}});
 const units=[],nodeUnit=new Map(),bindingUnit=new Map(),edges=[],slice=n=>text.slice(n.start,n.end);
 const add=(p,parent)=>{const unit={id:units.length,path:p,parent,names:[],deps:[],effect:!p.isPure()};units.push(unit);nodeUnit.set(p.node,unit);};
 for(const p of scope.path.get('body')){if(p.isVariableDeclaration()){for(const declaration of p.get('declarations'))add(declaration,p);}else add(p,p);}
 const owner=p=>{for(;p&&!p.isProgram();p=p.parentPath){const unit=nodeUnit.get(p.node);if(unit)return unit;}return null;};
 for(const [name,binding]of Object.entries(scope.bindings)){const unit=owner(binding.path);assert(unit,name);bindingUnit.set(name,unit);unit.names.push(name);}
 for(const [name,binding]of Object.entries(scope.bindings)){
  const to=bindingUnit.get(name);
  for(const reference of [...binding.referencePaths,...binding.constantViolations]){const from=owner(reference);if(from&&from!==to){from.deps.push(to.id);edges.push({from:from.id,to:to.id,binding:name,reference});}}
 }
 for(const unit of units){unit.deps=[...new Set(unit.deps)];if(unit.path.isFunctionDeclaration())unit.effect=false;if(unit.path.isVariableDeclarator()){const init=unit.path.get('init');unit.effect=!!init.node&&!init.isPure();}}
 return{text,ast,scope,units,bindingUnit,edges,slice,owner};
}
function reach(g,seeds,stop=new Set()){const seen=new Set(),todo=[...seeds];while(todo.length){const id=todo.pop();if(seen.has(id))continue;seen.add(id);if(!stop.has(id))todo.push(...g.units[id].deps);}return seen;}
function addAsset(label,code){const name='mobile-'+label+'-'+sha(code).slice(0,20)+'.js';outputs.set(name,code);return name;}
function applyStage(name,edits){
 const before=source;edits=edits.sort((a,b)=>a.start-b.start);
 for(let i=1;i<edits.length;i++)assert(edits[i-1].end<=edits[i].start,'Overlapping '+name+' edits');
 for(const edit of edits.toReversed())source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
 stages.push({name,inputSha256:sha(before),outputSha256:sha(source),edits:edits.map(e=>({...e,beforeSha256:sha(before.slice(e.start,e.end))}))});
}
// Remove declarators without copying unrelated parts of their (often huge) var.
function removeDeclarations(g,moved){
 const parents=new Set([...moved].filter(u=>u.path.isVariableDeclarator()).map(u=>u.parent.node)),edits=[];
 for(const parent of parents){
  const declarations=parent.declarations,kept=declarations.filter(d=>![...moved].some(u=>u.path.node===d));
  if(!kept.length){edits.push({start:parent.start,end:parent.end,text:''});continue;}
  if(kept[0]!==declarations[0])edits.push({start:declarations[0].start,end:kept[0].start,text:''});
  for(let i=1;i<kept.length;i++)if(declarations.indexOf(kept[i])-declarations.indexOf(kept[i-1])>1)edits.push({start:kept[i-1].end,end:kept[i].start,text:','});
  if(kept.at(-1)!==declarations.at(-1))edits.push({start:kept.at(-1).end,end:declarations.at(-1).end,text:''});
 }
 return edits;
}
const runtime=`function __mobileDeferredModule(load,{timeoutMs=30000,label='功能'}={}){let pending,attempt=0;return function get(){if(pending)return pending;const sequence=++attempt;let timer,active=true;const work=Promise.resolve().then(()=>load(sequence===1?'':'?retry='+sequence,()=>active));const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error(label+'加载超时，请重试'))},timeoutMs)});const current=Promise.race([work,expired]).finally(()=>{clearTimeout(timer);active=false});pending=current;current.catch(()=>{if(pending===current)pending=void 0});return current}}\nfunction __mobileDeferredComponent(React,jsx,load){return function DeferredOriginal(props){const[attempt,retry]=React.useState(0);const[state,setState]=React.useState({view:null,error:null});React.useEffect(()=>{let alive=true;setState({view:null,error:null});Promise.resolve().then(load).then(view=>{if(alive)setState({view,error:null})},error=>{if(alive)setState({view:null,error})});return()=>{alive=false}},[attempt]);if(state.view)return jsx.jsx(state.view,props);if(state.error)return jsx.jsxs('div',{role:'alert',className:'p-3 text-ui-base text-foreground-subtle',children:[jsx.jsx('span',{children:'暂时无法加载此功能。'}),jsx.jsx('button',{type:'button',className:'ml-2 underline',onClick:()=>retry(n=>n+1),children:'重试'})]});return jsx.jsx('div',{role:'status','aria-live':'polite',className:'p-3 text-ui-base text-foreground-subtle',children:'加载中…'})}}`;
mark('pages start');
{
 const g=graph(source),targets=['U3','q6','u9'],targetIds=new Set(targets.map(name=>g.bindingUnit.get(name).id));
 const pinyin=g.units.slice(g.bindingUnit.get('Ftt').id,g.bindingUnit.get('Ynt').id+1),reviewed=new Set(pinyin.map(unit=>unit.id));
 const candidate=reach(g,[...targetIds,...reviewed]),roots=g.units.filter(unit=>!targetIds.has(unit.id)&&(!candidate.has(unit.id)||(unit.effect&&!reviewed.has(unit.id)))).map(unit=>unit.id);
 let moved,captures;const pinned=[];
 for(;;){
  const retained=reach(g,roots,targetIds);moved=new Set(g.units.filter(unit=>candidate.has(unit.id)&&(targetIds.has(unit.id)||!retained.has(unit.id))));
  const movedIds=new Set([...moved].map(unit=>unit.id));captures=[...new Set(g.edges.filter(edge=>movedIds.has(edge.from)&&!movedIds.has(edge.to)).map(edge=>edge.binding))].sort();
  const mutable=new Set(captures.filter(name=>g.scope.bindings[name].constantViolations.length));const pin=[...new Set(g.edges.filter(edge=>movedIds.has(edge.from)&&mutable.has(edge.binding)).map(edge=>edge.from))];
  if(!pin.length)break;assert(!pin.some(id=>targetIds.has(id)),'A page captures mutable state');roots.push(...pin);pinned.push(...pin);
 }
 const movedIds=new Set([...moved].map(unit=>unit.id));assert.equal(g.edges.filter(edge=>!movedIds.has(edge.from)&&movedIds.has(edge.to)&&!targetIds.has(edge.to)).length,0,'Escaped page closure');
 for(const edge of g.edges.filter(edge=>!movedIds.has(edge.from)&&targetIds.has(edge.to))){const reference=edge.reference;assert(reference.parentPath.isCallExpression()&&reference.parentPath.node.arguments[0]===reference.node&&/\$\.jsxs?/.test(g.slice(reference.parentPath.node.callee)),'Page has a non-JSX caller');}
 const declaration=unit=>(unit.path.isVariableDeclarator()?unit.parent.node.kind+' ':'')+g.slice(unit.path.node)+';';
 const body=[...moved].map(declaration).join('\n'),name=addAsset('pages',`export function createOriginalPages({${captures.join(',')}}){\n${body}\nreturn{${targets.join(',')}};}`);
 const loader=`var __mobilePagesLoader=__mobileDeferredModule((suffix,current)=>import('./${name}'+suffix).then(m=>{if(!current())throw Error('页面加载已过期');return m.createOriginalPages({${captures.join(',')}})}),{label:'页面'});`;
 const edits=removeDeclarations(g,moved);
 for(const unit of moved)if(!unit.path.isVariableDeclarator())edits.push({start:unit.path.node.start,end:unit.path.node.end,text:targets.includes(unit.names[0])?`var __mobilePage${unit.names[0]}=__mobileDeferredComponent(Q,$,()=>__mobilePagesLoader().then(m=>m.${unit.names[0]}));function ${unit.names[0]}(props){return(0,$.jsx)(__mobilePage${unit.names[0]},props)}`:''});
 edits.push({start:source.length,end:source.length,text:'\n'+runtime+'\n'+loader});
 proofs.push({name:'pages',chunk:name,targets,captures,moved:[...moved].map(unit=>({names:unit.names,sha256:sha(g.slice(unit.path.node))})),mutablePinned:pinned.map(id=>g.units[id].names)});
 applyStage('optional-pages',edits);
}
cleanup();mark('pages complete');
{
 const g=graph(source),names=['XLn','QLn','LRn'],moved=new Set(names.map(name=>g.bindingUnit.get(name))),inside=p=>[...moved].some(unit=>p.node.start>=unit.path.node.start&&p.node.end<=unit.path.node.end),captures=[];
 assert.equal(g.slice(g.scope.bindings.QLn.path.node),'QLn=XLn()');assert(g.slice(g.scope.bindings.XLn.path.node).includes('e.Terminal='));
 for(const [name,binding]of Object.entries(g.scope.bindings)){
  if(names.includes(name)){const outside=binding.referencePaths.filter(p=>!inside(p));if(name!=='LRn')assert.equal(outside.length,0,name+' escaped');else for(const reference of outside)assert(reference.parentPath.isCallExpression()&&reference.parentPath.node.arguments[0]===reference.node&&g.slice(reference.parentPath.node.callee).includes('$.jsx'),'Terminal has a non-JSX caller');}
  else if([...binding.referencePaths,...binding.constantViolations].some(inside)){assert.equal(binding.constantViolations.length,0,'Mutable terminal capture '+name);captures.push(name);}
 }
 const body=names.map(name=>{const p=g.scope.bindings[name].path;return(p.isVariableDeclarator()?'var ':'')+g.slice(p.node)+';';}).join('\n');
 const name=addAsset('terminal',`export function createOriginalTerminalComponent({${captures.join(',')}}){\n${body}\nreturn LRn;}`);
 const wrapper=`var __mobileTerminal=__mobileDeferredComponent(Q,$,__mobileDeferredModule((suffix,current)=>import('./${name}'+suffix).then(m=>{if(!current())throw Error('终端加载已过期');return m.createOriginalTerminalComponent({${captures.join(',')}})}),{label:'终端'}));function LRn(props){return(0,$.jsx)(__mobileTerminal,props)}`;
 const edits=removeDeclarations(g,moved);const node=g.scope.bindings.LRn.path.node;edits.push({start:node.start,end:node.end,text:wrapper});
 proofs.push({name:'terminal',chunk:name,captures,moved:names.map(name=>({names:[name],sha256:sha(g.slice(g.scope.bindings[name].path.node))}))});applyStage('optional-terminal',edits);
}
cleanup();mark('terminal complete');
{
 const g=graph(source),binding=name=>{assert(g.scope.bindings[name],name);return g.scope.bindings[name];},node=name=>binding(name).path.node;
 const start=binding('uIe').path.parentPath.node.start,end=node('rb').end,inside=p=>p.node.start>=start&&p.node.end<=end,inject=[],imports=[],edits=[];
 const sideEffects=new Set(['chunk-BSJP7CBP-DCUIGKn_.js','chunk-ZZ45TVLE-DfgoOw8u.js','chunk-X2U36JSP-Cu8DC9v-.js','chunk-5FUZZQ4R-DuvRsxuz.js','chunk-ENJZ2VHE-lTSFakVv.js']);
 for(const [key,b]of Object.entries(g.scope.bindings)){
  if(inside(b.path)){const outside=[...b.referencePaths,...b.constantViolations].filter(p=>!inside(p));assert(!outside.length||key==='rb','Escaped Mermaid '+key);}
  else if([...b.referencePaths,...b.constantViolations].some(inside)){assert(!b.constantViolations.some(inside),'Mermaid writes capture '+key);if(!b.path.isImportSpecifier()){assert.equal(b.constantViolations.length,0,'Mutable Mermaid '+key);inject.push(key);}}
 }
 for(const p of g.scope.path.get('body').filter(p=>p.isImportDeclaration())){
  if(!p.node.specifiers.length&&sideEffects.has(path.basename(p.node.source.value))){imports.push(g.slice(p.node));edits.push({start:p.node.start,end:p.node.end,text:''});continue;}
  const used=p.node.specifiers.filter(s=>binding(s.local.name).referencePaths.some(inside));if(!used.length)continue;
  imports.push(generate({...p.node,specifiers:used},{compact:true}).code);
  const retained=p.node.specifiers.filter(s=>!used.includes(s)||binding(s.local.name).referencePaths.some(p=>!inside(p)));
  if(retained.length!==p.node.specifiers.length)edits.push({start:p.node.start,end:p.node.end,text:retained.length?generate({...p.node,specifiers:retained},{compact:true}).code:''});
 }
 const name=addAsset('mermaid',imports.join('')+`\nexport function create({${inject.join(',')}}){${source.slice(start,end)};\nreturn{rb};}`);
 edits.push({start,end,text:`var __mobileMermaidLoader=__mobileDeferredModule((suffix,current)=>import('./${name}'+suffix).then(m=>{if(!current())throw Error('图表加载已过期');return m.create({${inject.join(',')}})}),{label:'图表'});var __mobileMermaidComma=0`});
 const renderer=node('WRe');edits.push({start:renderer.start,end:renderer.end,text:`function WRe(e={}){let t=!1,n={...URe,...e.config};const r={initialize(c){n={...URe,...e.config,...c};t=!1},async render(e,r){const{rb}=await __mobileMermaidLoader();if(!t){rb.initialize(n);t=!0}return await rb.render(e,r)}};return{name:'mermaid',type:'diagram',language:'mermaid',getMermaid(e){if(e)r.initialize(e);return r}}}`});
 // Skip chart work which was queued by a component that has since unmounted.
 const before='eze(async()=>XRe.getMermaid(f).render(t,l)).then(({svg:t})=>{e||(h({status:`ready`,svg:t}),i?.(t))})';
 const after='eze(async()=>e?null:XRe.getMermaid(f).render(t,l)).then(result=>{if(e||!result)return;const{svg:t}=result;h({status:`ready`,svg:t});i?.(t)})';
 assert.equal(source.split(before).length-1,1,'Mermaid queue recovery changed');const queue=source.indexOf(before);edits.push({start:queue,end:queue+before.length,text:after});
 proofs.push({name:'mermaid',chunk:name,captures:inject,staticImports:imports,originalRegionSha256:sha(source.slice(start,end))});applyStage('optional-mermaid',edits);
}
cleanup();mark('mermaid complete');
{
 const original='function qpt(e){return e.canLoadOlder&&!e.loadingOlder&&e.hasLoadHandler&&e.containerWidthPx>=864}';
 assert.equal(source.split(original).length-1,1,'Question directory trigger changed');
 const at=source.indexOf(original),replacement='function qpt(e){return globalThis.__CODEX_ORIGINAL_BRIDGE__?.codexBridge===true?!1:e.canLoadOlder&&!e.loadingOlder&&e.hasLoadHandler&&e.containerWidthPx>=864}';
 applyStage('manual-history-question-directory',[{start:at,end:at+original.length,text:replacement}]);
}
const protectedNames=['U4','W3t','Wxn','W5n','yqn','F3n','pKn','U5n','nNe','PNe','__zPlainFile'];
const exportList=g=>g.ast.program.body.filter(n=>n.type==='ExportNamedDeclaration').flatMap(n=>n.specifiers.map(s=>[s.local.name,s.exported.name]));
let allowed,originalExports,protectedHashes;
{
 const originalGraph=graph(initial);allowed=new Set(Object.keys(originalGraph.scope.globals));originalExports=exportList(originalGraph);
 protectedHashes=Object.fromEntries(protectedNames.filter(name=>originalGraph.scope.bindings[name]).map(name=>[name,sha(originalGraph.slice(originalGraph.scope.bindings[name].path.node))]));
}
cleanup();mark('original checks complete');
{
 const finalGraph=graph(source);for(const name of Object.keys(finalGraph.scope.globals))assert(allowed.has(name),'New main global '+name);
 assert.deepEqual(exportList(finalGraph),originalExports);
 for(const[name,hash]of Object.entries(protectedHashes))assert.equal(sha(finalGraph.slice(finalGraph.scope.bindings[name].path.node)),hash,'Protected core changed '+name);
}
cleanup();mark('final checks complete');
for(const[name,code]of outputs){
 {const g=graph(code);for(const name of Object.keys(g.scope.globals))assert(allowed.has(name),'New chunk global '+name);}
 cleanup();
}
const split={schema:1,basePatchCount,inputSha256:sha(initial),outputSha256:sha(source),offsets:'UTF-16 [start,end)',stages,assets:[...outputs].map(([name,code])=>({name,sha256:sha(code),bytes:Buffer.byteLength(code)})),proofs};
assert.equal(applyMobileSplit(initial,split),source,'Pure rebuild mismatch');
manifest.mobileSplit=split;manifest.compatSHA256=sha(source);
const atomic=(file,content)=>{const temporary=file+'.mobile-build-tmp';fs.writeFileSync(temporary,content);fs.renameSync(temporary,file);};
// Publish referenced files before the entry. Running applications still use the
// separately installed copy; this builder never writes Library or restarts it.
for(const [name,code]of outputs)atomic(path.join(assets,name),code);atomic(mainPath,source);atomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
const sizes=new Map(),size=s=>{const key=sha(s);if(!sizes.has(key))sizes.set(key,{raw:Buffer.byteLength(s),gzip9:gzipSync(s,{level:9}).length,br9:brotliCompressSync(s,{params:{[constants.BROTLI_PARAM_QUALITY]:9}}).length});return sizes.get(key);};
function asset(name){if(outputs.has(name))return outputs.get(name);if(name==='IntlProvider-itolvRb2.js')return fs.readFileSync(path.join(frontend,'assets',name),'utf8');return fs.readFileSync(path.join(assets,name),'utf8');}
function closure(entry,include=[]){const seen=new Map([['index-BsmXQHMM.js',entry],...include.map(name=>[name,asset(name)])]),todo=[...seen];while(todo.length){const[name,text]=todo.pop();for(const node of parse(text,{sourceType:'module'}).program.body){if(!['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)||!node.source?.value.startsWith('.'))continue;const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),node.source.value));if(seen.has(target))continue;const next=asset(target);seen.set(target,next);todo.push([target,next]);}}return seen;}
function total(graph){const entries=[...graph].map(([name,code])=>({name,sha256:sha(code),...size(code)}));return{modules:entries.length,...Object.fromEntries(['raw','gzip9','br9'].map(key=>[key,entries.reduce((n,e)=>n+e[key],0)])),entries};}
const before=total(closure(initial)),after=total(closure(source)),all=total(closure(source,[...outputs.keys()]));
const report={inputSha256:sha(initial),outputSha256:sha(source),basePatches:basePatchCount,initialMainBefore:size(initial),initialMainAfter:size(source),staticJsBefore:before,staticJsAfter:after,allDeferredLoaded:all,savings:Object.fromEntries(['raw','gzip9','br9'].map(key=>[key,before[key]-after[key]])),initialExtraModulesNotCounted:['HTML','CSS','fonts','entry/adapter','WebSocket','WASM/runtime highlighter'],scope:'Sum of separately compressed static ESM imports; optional pages/terminal/Mermaid are also reported as an all-triggered graph. Browser verification is still required.',protectedNames,assets:split.assets};
fs.mkdirSync(path.join(root,'build'),{recursive:true});fs.writeFileSync(path.join(root,'build/mobile-bundle-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,staticJsBefore:{...before,entries:undefined},staticJsAfter:{...after,entries:undefined},allDeferredLoaded:{...all,entries:undefined}},null,2));
