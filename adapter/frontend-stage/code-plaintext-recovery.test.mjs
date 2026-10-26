import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
const manifest=JSON.parse(await readFile(new URL('./bundle-patch-manifest.json',import.meta.url),'utf8'));
const rendererPatch=manifest.patches.find(p=>p.name==='codex-code-main-renderer-plaintext-and-error');
assert(rendererPatch);
let currentRenderer=rendererPatch.replacement;
for(const patch of manifest.patches.slice(manifest.patches.indexOf(rendererPatch)+1))if(currentRenderer.includes(patch.needle))currentRenderer=currentRenderer.replace(patch.needle,patch.replacement);
assert(source.includes(currentRenderer));
function declaration(name){
 const start=source.indexOf('function '+name+'(');assert(start>=0,name);
 let index=source.indexOf('){',start)+1,depth=0;
 for(;index<source.length;index++){
  if(source[index]==='{')depth++;else if(source[index]==='}'&&--depth===0)return source.slice(start,index+1);
 }
 assert.fail('Unterminated function '+name);
}
const helper=manifest.patches.find(p=>p.name==='codex-code-plain-ast-helper').replacement.split('function __codexOriginalMount(')[0];
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness({original=false,workerManager,initialize=()=>new Promise(()=>{})}={}){
 const errors=[],context=vm.createContext({console:{error:error=>errors.push(error)},Ch:/\r\n|\n|\r/g,Dh:'qa',NNe:0,Oh:{startingLine:0,totalLines:Infinity,bufferBefore:0,bufferAfter:0},Vv:()=>false,Bv:()=>false,ev:()=> 'javascript',eMe:()=>undefined,MNe:()=>false,Hv:(a,b)=>a.theme===b.theme,zv:()=>true,aMe:()=>false,Y_:value=>[value],J_:initialize,ENe:()=>({type:'element',tagName:'div',properties:{},children:[]}),CNe:()=>({type:'element',tagName:'div',properties:{},children:[]}),kh:value=>value});
 for(const name of ['mv','tv','nv','rv','iv','cMe','hv','ov','sMe','sv','kNe','ANe','wNe','jNe'])vm.runInContext(declaration(name),context);
 vm.runInContext(helper,context);
 const Renderer=vm.runInContext('('+(original?rendererPatch.needle:currentRenderer).slice('PNe='.length)+')',context);
 let updates=0;const renderer=new Renderer({theme:'qa',disableFileHeader:true},()=>updates++,workerManager);
 const plain=(file)=>context.__zPlainFile(file);
 return{context,renderer,errors,plain,get updates(){return updates;}};
}
const file=(contents,cacheKey=contents)=>({name:'sample.js',lang:'javascript',contents,cacheKey});
const text=nodes=>nodes.map(node=>node.type==='text'?node.value:text(node.children??[])).join('');

test('negative control: an unavailable worker leaves the original renderer blank, while current renderer returns readable AST synchronously',()=>{
 const workerManager={isWorkingPool:()=>true,getFileResultCache:()=>undefined,getPlainFileAST:()=>undefined,highlightFileAST(){},getFileRenderOptions:()=>({theme:'qa'})};
 const baseline=harness({original:true,workerManager}),fixed=harness({workerManager}),input=file('const x = 1');
 assert.equal(baseline.renderer.renderFile(input),undefined);
 const result=fixed.renderer.renderFile(input);assert.equal(text(result.contentAST),'const x = 1');assert.equal(result.rowCount,1);
});
test('engine initialization stays pending without hiding code or its line numbers',()=>{
 const h=harness(),result=h.renderer.renderFile(file('const x = 1\nconst y = 2'));
 assert.equal(text(result.contentAST),'const x = 1const y = 2');assert.equal(result.rowCount,2);assert.equal(result.totalLines,2);assert.equal(text(result.gutterAST),'12');
});
test('engine rejection is handled and readable code remains available',async()=>{
 const failure=Error('grammar unavailable'),h=harness({initialize:()=>Promise.reject(failure)}),input=file('const x = 1');
 assert.equal(text(h.renderer.renderFile(input).contentAST),'const x = 1');await tick();assert.equal(h.errors[0],failure);
 assert.equal(text(h.renderer.renderFile(input).contentAST),'const x = 1');await tick();
});
test('hydration initialization rejection is handled instead of escaping its non-async caller',async()=>{
 const failure=Error('wasm unavailable'),h=harness({initialize:()=>Promise.reject(failure)}),input=file('const x = 1');
 h.renderer.hydrate(input);await tick();assert.equal(h.errors.length,1);assert.equal(h.errors[0],failure);
 assert.equal(text(h.renderer.renderFile(input).contentAST),'const x = 1');await tick();
});
test('plain code keeps HTML-looking input as text AST and never introduces raw markup nodes',()=>{
 const h=harness(),code='<img src=x onerror=alert(1)>\n<script>alert(2)</script> & "quote"',result=h.renderer.renderFile(file(code));
 assert.equal(text(result.contentAST),code.replace('\n',''));
 const walk=node=>{assert.notEqual(node.type,'raw');if(node.type==='element')assert.equal(node.tagName,'div');for(const child of node.children??[])walk(child);};result.contentAST.forEach(walk);
});
test('Unicode and CRLF keep the original line-window contract',()=>{
 const h=harness(),input=file('第一行🌙\r\n第二行\r\n第三行\r\n');
 const result=h.renderer.renderFile(input,{startingLine:1,totalLines:1,bufferBefore:1,bufferAfter:1});
 assert.equal(result.rowCount,1);assert.equal(result.totalLines,4);assert.equal(text(result.contentAST),'第二行');assert.equal(text(result.gutterAST),'2');
});
test('a successful highlight progressively replaces plain AST and requests a redraw',async()=>{
 const h=harness(),gate=deferred(),input=file('const x = 1');h.renderer.asyncHighlight=()=>gate.promise;
 assert.equal(text(h.renderer.renderFile(input).contentAST),'const x = 1');
 gate.resolve({result:{...h.plain(input),themeStyles:'color:red'},options:{theme:'qa'}});await tick();
 assert.equal(h.renderer.renderCache.highlighted,true);assert.equal(h.renderer.renderCache.result.themeStyles,'color:red');assert.equal(h.updates,1);
});
test('an old stream highlight cannot replace newer text or clear its completed-highlight flag',async()=>{
 const h=harness(),a=file('const x = 1','old'),b=file('const x = 2','new'),first=deferred(),second=deferred();
 h.renderer.asyncHighlight=input=>input===a?first.promise:second.promise;
 h.renderer.renderFile(a);assert.equal(text(h.renderer.renderFile(b).contentAST),'const x = 2');
 second.resolve({result:h.plain(b),options:{theme:'qa'}});await tick();assert.equal(h.renderer.renderCache.highlighted,true);
 first.resolve({result:h.plain(a),options:{theme:'qa'}});await tick();
 assert.equal(h.renderer.renderCache.file,b);assert.equal(h.renderer.renderCache.highlighted,true);assert.equal(text(h.renderer.renderCache.result.code.filter(Boolean)),'const x = 2');assert.equal(h.updates,1);
});
test('cleanup prevents a late highlight from reviving an unmounted renderer',async()=>{
 const h=harness(),input=file('const x = 1'),gate=deferred();h.renderer.asyncHighlight=()=>gate.promise;
 h.renderer.renderFile(input);h.renderer.cleanUp();gate.resolve({result:h.plain(input),options:{theme:'qa'}});await tick();assert.equal(h.renderer.renderCache,undefined);assert.equal(h.updates,0);
});
