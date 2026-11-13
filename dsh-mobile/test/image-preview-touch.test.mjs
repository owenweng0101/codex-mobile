import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {bindImagePreviewTouch,patchImagePreviewTouch} from '../backend/image-preview-touch.mjs';

test('image viewer accepts one-finger pan, two-finger zoom/pan and commits its native controls',()=>{
 const handlers={},commits=[];let scale=0.12;
 const node={scrollLeft:400,scrollTop:500,querySelector:()=>true,addEventListener:(name,fn)=>handlers[name]=fn,removeEventListener:name=>delete handlers[name]};
 const bind=runInNewContext('('+bindImagePreviewTouch.toString()+')',{window:{matchMedia:()=>({matches:true})}});
 const release=bind(node,()=>scale,next=>{scale=next;},v=>commits.push(v),()=>{});
 const fire=(type,points)=>{const e={touches:points.map(([clientX,clientY])=>({clientX,clientY})),preventDefault(){this.prevented=true;}};handlers[type](e);return e;};
 fire('touchstart',[[200,300]]);assert.ok(fire('touchmove',[[150,220]]).prevented);assert.equal(node.scrollLeft,450);assert.equal(node.scrollTop,580);fire('touchend',[]);
 fire('touchstart',[[150,300],[250,300]]);fire('touchmove',[[100,280],[300,280]]);assert.equal(scale,0.24);assert.equal(node.scrollTop,600);
 fire('touchmove',[[80,240],[280,240]]);assert.equal(scale,0.24);assert.equal(node.scrollLeft,470);assert.equal(node.scrollTop,640);
 fire('touchend',[]);assert.deepEqual(commits,[0.24]);release();assert.equal(Object.keys(handlers).length,0);
});
test('unknown pinned viewer versions fail closed instead of silently losing touch support',()=>{
 assert.throws(()=>patchImagePreviewTouch('unknown viewer'),/review touch integration/);
});
test('PDF pinch commits native zoom but one-finger reading stays with browser scrolling',()=>{
 const handlers={},commits=[];let scale=0.66;
 const node={scrollLeft:0,scrollTop:20,querySelector:s=>s==='[data-pdf-preview]',addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]};
 const bind=runInNewContext('('+bindImagePreviewTouch.toString()+')',{window:{matchMedia:()=>({matches:true})}});
 const release=bind(node,()=>scale,v=>scale=v,v=>commits.push(v),()=>{});
 const fire=(type,points)=>{const e={touches:points.map(([clientX,clientY])=>({clientX,clientY})),preventDefault(){this.prevented=true;}};handlers[type](e);return e;};
 assert.ok(!fire('touchstart',[[120,300]]).prevented);
 assert.ok(!fire('touchmove',[[120,150]]).prevented);assert.equal(node.scrollTop,20);
 fire('touchstart',[[100,250],[200,250]]);assert.ok(fire('touchmove',[[50,250],[250,250]]).prevented);
 assert.equal(scale,1.32);fire('touchend',[[50,250]]);assert.deepEqual(commits,[1.32]);
 assert.ok(!fire('touchmove',[[50,100]]).prevented);release();
});
test('Safari gesture events zoom independently without double applying touch pinch',()=>{
 const handlers={},commits=[];let scale=0.5;
 const node={scrollLeft:0,scrollTop:0,querySelector:()=>true,addEventListener:(n,f)=>handlers[n]=f,removeEventListener:n=>delete handlers[n]};
 const bind=runInNewContext('('+bindImagePreviewTouch.toString()+')',{window:{matchMedia:()=>({matches:true})}});
 const release=bind(node,()=>scale,v=>scale=v,v=>commits.push(v),()=>{});
 const fire=(name,extra={})=>handlers[name]({preventDefault(){},...extra});
 fire('gesturestart');fire('gesturechange',{scale:2});fire('gestureend');assert.equal(scale,1);
 const points=xs=>xs.map(clientX=>({clientX,clientY:300}));
 fire('touchstart',{touches:points([100,200])});fire('gesturestart');fire('gesturechange',{scale:2});assert.equal(scale,1);
 fire('touchmove',{touches:points([50,250])});fire('gestureend');fire('touchend',{touches:[]});assert.equal(scale,2);
 fire('touchstart',{touches:points([100,200])});fire('touchcancel',{touches:[]});
 fire('gesturestart');fire('gesturechange',{scale:0.5});fire('gestureend');assert.equal(scale,1);
 assert.deepEqual(commits,[1,2,1]);release();assert.equal(Object.keys(handlers).length,0);
});
