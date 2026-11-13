import test from 'node:test';
import assert from 'node:assert/strict';
import {bindSidebarTouchGuard} from '../backend/sidebar-touch.mjs';

function fixture() {
  const handlers={},row={},sidebar={contains:n=>n===row}; let time=100;
  const release=bindSidebarTouchGuard({addEventListener:(n,h)=>handlers[n]=h,removeEventListener:n=>delete handlers[n]},()=>true,()=>sidebar,()=>time);
  const fire=(type,extra={})=>{const e={target:row,pointerId:1,clientX:100,clientY:300,detail:1,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers[type](e);return e;};
  return {fire,release,handlers,tick:n=>time+=n};
}
test('scroll/drag/canceled touches cannot activate a conversation; next tap still works',()=>{
  for(const kind of ['pointermove','scroll','pointercancel']) {
    const f=fixture();f.fire('pointerdown');f.fire(kind,{clientY:240});f.fire('pointerup');f.tick(260);
    const click=f.fire('click');assert.equal(click.prevented,true);assert.equal(click.stopped,true);
    f.fire('pointerdown');f.fire('pointerup');assert.equal(f.fire('click').prevented,undefined);
    f.release();assert.equal(Object.keys(f.handlers).length,0);
  }
});
test('stationary taps, keyboard clicks and tiny finger movement preserve native activation',()=>{
  const f=fixture();f.fire('pointerdown');f.fire('pointermove',{clientY:304});f.fire('pointerup');assert.equal(f.fire('click').prevented,undefined);
  f.fire('pointerdown');f.fire('pointercancel');assert.equal(f.fire('click',{detail:0}).prevented,undefined);
});
