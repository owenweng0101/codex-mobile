import test from 'node:test';import assert from 'node:assert/strict';import {installPreviewZoom} from '../image-recovery.mjs';
test('HTML pinch preserves focal point, pans, and clamps zoom to DSH limits',t=>{
 const oldDoc=globalThis.document,oldWin=globalThis.window; t.after(()=>{globalThis.document=oldDoc;globalThis.window=oldWin;});
 const attrs=new Map(),events={};const root={style:{setProperty(k,v){this[k]=v;}},hasAttribute:k=>attrs.has(k),setAttribute:(k,v)=>attrs.set(k,v)};
 globalThis.document={documentElement:root,head:{append(){}},createElement:()=>({}),addEventListener:(name,fn)=>{events[name]=fn;}};
 const win=globalThis.window={innerWidth:393,scrollX:0,scrollY:0,scrollTo(x,y){this.scrollX=x;this.scrollY=y;}};
 installPreviewZoom();const event=points=>({touches:points.map(([clientX,clientY])=>({clientX,clientY})),target:{},preventDefault(){}});
 events.touchstart(event([[100,200],[200,200]]));events.touchmove(event([[50,200],[250,200]]));
 assert.equal(root.style.zoom,'2');assert.equal(win.scrollX,150);assert.equal(win.scrollY,200);assert.equal(root.style.width,'393px');
 events.touchend(event([[150,200]]));events.touchmove(event([[150,100]]));assert.equal(win.scrollY,300);
 events.touchstart(event([[100,100],[200,100]]));events.touchmove(event([[149,100],[151,100]]));assert.equal(root.style.zoom,'0.2');
 events.touchstart(event([[100,100],[101,100]]));events.touchmove(event([[0,100],[1000,100]]));assert.equal(root.style.zoom,'4');
});
