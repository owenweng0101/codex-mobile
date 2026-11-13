import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PREVIEW_ZOOM_SCRIPT } from '../backend/preview-zoom.mjs';

function fixture(){
 const handlers={},attrs=new Map(),root={style:{setProperty(k,v){this[k]=v;}},hasAttribute:k=>attrs.has(k),setAttribute:(k,v)=>attrs.set(k,v)};
 const win={innerWidth:390,innerHeight:600,scrollX:0,scrollY:0,scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
 const doc={documentElement:root,head:{append(){}},createElement:()=>({}),addEventListener:(name,fn,options)=>{handlers[name]={fn,options};}};
 runInNewContext(PREVIEW_ZOOM_SCRIPT,{document:doc,window:win,innerWidth:390,innerHeight:600});
 const event=(type,touches=[],extra={})=>{const e={touches,prevented:false,preventDefault(){this.prevented=true;},...extra};handlers[type].fn(e);return e;};
 return {event,root,win,handlers};
}
const fingers=(left,right)=>[{clientX:left,clientY:200},{clientX:right,clientY:200}];
test('preview pinch scales around its center, clamps extremes and leaves one-finger scroll native',()=>{
 const f=fixture();assert.equal(f.event('touchstart',fingers(100,300)).prevented,true);
 f.event('touchmove',fingers(150,250));assert.equal(f.root.style.zoom,'0.5');
 f.event('touchmove',fingers(0,400));assert.equal(f.root.style.zoom,'2');assert.equal(f.win.scrollX,200);assert.equal(f.win.scrollY,200);
 f.event('touchmove',fingers(-1000,1000));assert.equal(f.root.style.zoom,'4');
 f.event('touchmove',fingers(199,201));assert.equal(f.root.style.zoom,'0.2');
 f.event('touchend',[]);assert.equal(f.event('touchmove',[{clientX:20,clientY:20}]).prevented,false);
 assert.equal(f.handlers.touchmove.options.passive,false);
});
test('Safari gesture fallback zooms but does not double-apply a simultaneous touch pinch',()=>{
 const f=fixture();f.event('gesturestart',[],{clientX:200,clientY:200});f.event('gesturechange',[],{scale:1.5,clientX:200,clientY:200});assert.equal(f.root.style.zoom,'1.5');
 f.event('touchstart',fingers(100,300));f.event('touchmove',fingers(150,250));assert.equal(f.root.style.zoom,'0.75');
 f.event('gesturechange',[],{scale:2});assert.equal(f.root.style.zoom,'0.75');
 f.event('touchcancel',[]);f.event('gestureend',[]);
});

test('HTML supports one-finger dragging and two-finger translation without changing scale',()=>{
 const f=fixture();f.win.scrollX=300;f.win.scrollY=400;
 f.event('touchstart',[{clientX:200,clientY:300}],{target:{closest:()=>null}});
 assert.ok(f.event('touchmove',[{clientX:150,clientY:250}]).prevented);assert.equal(f.win.scrollX,350);assert.equal(f.win.scrollY,450);
 f.event('touchend',[]);f.event('touchstart',fingers(100,300));f.event('touchmove',[{clientX:80,clientY:150},{clientX:280,clientY:150}]);
 assert.equal(f.root.style.zoom,'1');assert.equal(f.win.scrollX,370);assert.equal(f.win.scrollY,500);
});
