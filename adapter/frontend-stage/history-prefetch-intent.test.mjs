import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const bundle=await readFile(new URL('./assets/index-BsmXQHMM.js',import.meta.url),'utf8');
const manifest=JSON.parse(await readFile(new URL('./bundle-patch-manifest.json',import.meta.url),'utf8'));
const patches=manifest.patches.filter(p=>p.name.startsWith('codex-history-'));
let before=bundle;
for(const patch of [...patches].reverse()){assert.equal(before.split(patch.replacement).length-1,1);before=before.replace(patch.replacement,patch.needle);}

function callback(source,name,dependencies){
 source=source.slice(source.indexOf('function Wxn('),source.indexOf('var Gxn=',source.indexOf('function Wxn(')));
 const prefix=name+'=(0,Q.useCallback)(',start=source.indexOf(prefix),end=source.indexOf(','+dependencies+')',start);
 assert(start>=0&&end>start,name);return source.slice(start+prefix.length,end);
}
function pure(source,name,next){
 const start=source.indexOf('function '+name+'('),end=source.indexOf('function '+next+'(',start);
 assert(start>=0&&end>start,name);return source.slice(start,end);
}
function harness(source=bundle,{scrollTop=0,lastTop=scrollTop,height=752,contentHeight=2138,canLoadOlder=true,loadingOlder=false,layout=false,programmatic=false}={}){
 let calls=0,scroll;
 const element={scrollTop,clientHeight:height,scrollHeight:contentHeight,dispatchEvent(event){assert.equal(event.type,'scroll');scroll();}};
 const state={B:{current:element},Me:{current:programmatic?1:null},Ve:{current:lastTop},Ie:{current:layout?20000:0},Ne:{current:{intent:'none',observedAt:0}},Re:{current:false},Be:{current:null},Le:{current:false},je:{current:true},Ue:{current:null},
  Ae:{current:{canLoadOlder,loadingOlder,onLoadOlder(){calls++;}}},
  dt:{getVirtualItemForOffset:()=>({index:0,key:'row:500',start:900})},be:{current:[{key:'row:500'}]},
  _t(){},At(){},Lt(){},Bbn:()=>false,Date:{now:()=>10000},J:{debug(){}},Event:class{constructor(type){this.type=type;}}};
 state.yt=()=>state.Ne.current.intent;
 const context=vm.createContext(state);
 vm.runInContext(pure(source,'Ubn','Wbn')+pure(source,'Wbn','Gbn')+pure(source,'Gbn','Y2')+pure(source,'Ybn','Xbn')+source.slice(source.indexOf('function Xbn('),source.indexOf('var Z2=',source.indexOf('function Xbn('))),context);
 scroll=vm.runInContext('('+callback(source,'zt','[_t,yt,Lt,At,dt]')+')',context);
 const intent=vm.runInContext('('+callback(source,'xt','[_t]')+')',context);
 return{state,element,scroll,intent,wheel:dy=>intent(context.Ubn(dy)),touch:(previous,next)=>intent(context.Wbn(previous,next)),key:(key,shiftKey=false,editableTarget=false)=>intent(context.Gbn({key,shiftKey,editableTarget})),get calls(){return calls;}};
}

test('negative control: the actual previous scroll handler fetches history at an untouched short-window bottom',()=>{
 const original=harness(before,{scrollTop:1385.5});original.scroll();assert.equal(original.calls,1);
 const fixed=harness(bundle,{scrollTop:1385.5});fixed.scroll();assert.equal(fixed.calls,0);
});
test('initial layout and programmatic restoration do not fetch history',()=>{
 for(const options of [{scrollTop:0},{scrollTop:40,lastTop:100,layout:true},{scrollTop:600,programmatic:true}]){
  const h=harness(bundle,options);h.scroll();assert.equal(h.calls,0);
 }
});
test('negative control: prepend compensation and its synthetic scroll cannot cascade another page',()=>{
 for(const [source,expected]of[[before,3],[bundle,1]]){
  const h=harness(source,{scrollTop:950,lastTop:1000});h.wheel(-50);h.scroll();assert.equal(h.calls,1);
  h.element.scrollTop+=300;h.state.Ve.current=h.element.scrollTop;h.scroll();h.scroll();assert.equal(h.calls,expected);
 }
});
test('wheel upward can request history at the top even if the initial window cannot scroll',()=>{
 const h=harness(bundle,{contentHeight:600});h.wheel(-100);assert.equal(h.calls,1);h.scroll();h.scroll();assert.equal(h.calls,1);
});
test('touch movement toward older messages can request at the top',()=>{
 const h=harness();h.touch(100,140);assert.equal(h.calls,1);h.scroll();assert.equal(h.calls,1);
});
test('keyboard upward navigation is preserved, while editable-target keys cannot load history',()=>{
 for(const [key,shift]of[['ArrowUp',false],['PageUp',false],['Home',false],[' ',true]]){
  const h=harness();h.key(key,shift);assert.equal(h.calls,1,key);h.scroll();assert.equal(h.calls,1,key);
 }
 const editable=harness();editable.key('ArrowUp',false,true);editable.scroll();assert.equal(editable.calls,0);
});
test('downward wheel, touch and keys cannot prefetch older rows',()=>{
 for(const input of [h=>h.wheel(50),h=>h.touch(140,100),h=>h.key('ArrowDown'),h=>h.key('PageDown'),h=>h.key('End'),h=>h.key(' ')]){
  const h=harness();input(h);h.scroll();assert.equal(h.calls,0);
 }
});
test('real continuing upward movement can fetch another page after the prior page completed',()=>{
 const h=harness(bundle,{scrollTop:900,lastTop:1000});h.wheel(-100);h.scroll();assert.equal(h.calls,1);
 h.element.scrollTop=850;h.scroll();assert.equal(h.calls,2);
});
test('a fresh deliberate upward gesture can fetch a further page from an unchanged top',()=>{
 const h=harness();h.wheel(-100);assert.equal(h.calls,1);h.scroll();assert.equal(h.calls,1);h.wheel(-100);assert.equal(h.calls,2);
});
test('scrollbar dragging upward remains supported through an actual negative offset',()=>{
 const h=harness(bundle,{scrollTop:600,lastTop:800});h.intent('unknown');h.scroll();assert.equal(h.calls,1);
});
test('existing loading and end-of-history guards continue to suppress requests',()=>{
 for(const options of [{canLoadOlder:false},{loadingOlder:true}]){
  const h=harness(bundle,options);h.wheel(-100);h.element.scrollTop=-10;h.scroll();assert.equal(h.calls,0);
 }
});
test('prefetch still captures the virtual row anchor and keeps the original threshold',()=>{
 const h=harness(bundle,{scrollTop:900,lastTop:1000});h.wheel(-100);h.scroll();assert.equal(h.calls,1);
 assert.deepEqual(JSON.parse(JSON.stringify(h.state.Ue.current)),{key:'row:500',offsetTop:0,start:900});
 const far=harness(bundle,{scrollTop:1600,lastTop:1700});far.wheel(-100);far.scroll();assert.equal(far.calls,0);
});
