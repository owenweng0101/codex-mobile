import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {bindPreviewNavigation} from '../backend/preview-navigation.mjs';

function fixture(){
 let click,state='closed',now=0,id=0;const timers=new Map();
 class Element { constructor(kind){this.kind=kind;} closest(selector){return selector.includes('sidebar-right-toggle')?this.kind==='close':this.kind==='file';} }
 const document={querySelector:()=>({querySelectorAll:()=>[{}]}),addEventListener:(type,fn)=>click=fn,removeEventListener:()=>click=null};
 const bind=runInNewContext('('+bindPreviewNavigation.toString()+')',{Element,setTimeout:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)});
 const release=bind(document,{setAttribute:(_,v)=>state=v},{matches:true});
 const advance=ms=>{const end=now+ms;for(;;){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;timers.delete(next[0]);next[1].fn();}now=end;};
 return {click:kind=>click({target:new Element(kind)}),advance,get state(){return state;},release,timers};
}
test('closing a newly opened preview cancels its later reopen, leaving the chat touchable',()=>{
 const f=fixture();f.click('file');f.advance(160);assert.equal(f.state,'open');
 f.click('close');f.advance(120);assert.equal(f.state,'closed');f.advance(600);assert.equal(f.state,'closed');
 f.release();assert.equal(f.timers.size,0);
});
test('opening another file supersedes a pending close; repeated cycles leave no stale transition',()=>{
 const f=fixture();
 for(let i=0;i<4;i++){
  f.click('file');f.advance(160);assert.equal(f.state,'open');
  f.click('close');f.advance(20);f.click('file');f.advance(150);assert.equal(f.state,'open');
  f.click('close');f.advance(700);assert.equal(f.state,'closed');
 }
 f.release();
});
