import test from 'node:test';
import assert from 'node:assert/strict';
import {attachImageGestures} from './image-gestures.mjs';
function fixture() {
 const handlers = new Map();
 const surface = {style:{touchAction:'pan-y'},clientWidth:390,clientHeight:600,
 getBoundingClientRect:()=>({left:0,top:0,width:390,height:600}),
 addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n)};
 const image={parentElement:surface,style:{transform:'',transformOrigin:''},offsetWidth:300,offsetHeight:400,
 addEventListener:(n,f)=>handlers.set(n,f),removeEventListener:n=>handlers.delete(n)};
 const dispose=attachImageGestures(image);
 const fire=(name,points=[],target={})=>{let prevented=false;handlers.get(name)?.({target,touches:points.map(([clientX,clientY])=>({clientX,clientY})),preventDefault(){prevented=true},stopPropagation(){}});return prevented;};
 return {image,surface,fire,dispose,handlers};
}
test('pinch, transition to one finger, bounds and double tap reset',()=>{
 const {image,fire}=fixture();
 fire('touchstart',[[145,300],[245,300]]);fire('touchmove',[[45,300],[345,300]]);
 assert.match(image.style.transform,/scale\(3\)/);
 fire('touchend',[[345,300]]);fire('touchmove',[[385,340]]);
 assert.equal(image.style.transform,'translate(40px, 40px) scale(3)');
 fire('touchend');
 for(let i=0;i<2;i++){fire('touchstart',[[195,300]]);fire('touchend');}
 assert.equal(image.style.transform,'translate(0px, 0px) scale(1)');
 fire('touchstart',[[190,300],[200,300]]);fire('touchmove',[[0,300],[390,300]]);
 assert.match(image.style.transform,/scale\(8\)/);
});
test('toolbar is untouched; source reload and disposal reset the surface',()=>{
 const {image,surface,fire,dispose,handlers}=fixture();
 assert.equal(fire('touchstart',[[1,1]],{closest:()=>({})}),false);
 fire('touchstart',[[145,300],[245,300]]);fire('touchmove',[[45,300],[345,300]]);
 fire('load');assert.match(image.style.transform,/scale\(1\)/);
 dispose();assert.equal(surface.style.touchAction,'pan-y');assert.equal(image.style.transform,'');assert.equal(handlers.size,0);
});
