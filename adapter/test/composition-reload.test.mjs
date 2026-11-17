import test from 'node:test';
import assert from 'node:assert/strict';
import {trackCodexComposition,isCodexMobileReloadSafe} from '../codex-entry.mjs';

function fixture(){
 const listeners=new Map();
 const editor={isConnected:true,closest:()=>editor,contains:element=>element===editor};
 const document={activeElement:editor,addEventListener(type,listener,capture){assert.equal(capture,true);listeners.set(type,listener);},removeEventListener(type,listener){if(listeners.get(type)===listener)listeners.delete(type);}};
 const composition=trackCodexComposition(document);
 return{editor,document,listeners,composition,event:(type,extra={})=>listeners.get(type)?.({target:editor,...extra}),safe:(check=()=>true)=>isCodexMobileReloadSafe({document,composition,check})};
}

test('a composing Codex draft blocks reload without blocking ordinary persisted text',()=>{
 const f=fixture();assert.equal(f.safe(),true);
 f.event('compositionstart');assert.equal(f.safe(),false);
 f.document.hidden=true;assert.equal(f.safe(),false,'iframe hiding must not cancel IME ownership');
 f.event('compositionend');assert.equal(f.safe(),true);
 assert.equal(f.safe(()=>false),false,'composition completion must not override an attachment or send guard');
 f.composition.dispose();assert.equal(f.listeners.size,0);
});

test('missed compositionstart recovers from native input events and final input releases it',()=>{
 const f=fixture();f.event('beforeinput',{isComposing:true});assert.equal(f.safe(),false);
 f.event('input',{isComposing:true});assert.equal(f.safe(),false);
 f.event('input',{isComposing:false});assert.equal(f.safe(),true);
});

test('blur, detached editor and verified focus movement cannot leave a permanent composition lock',()=>{
 for(const finish of [f=>f.event('blur'),f=>{f.editor.isConnected=false;},f=>{f.document.activeElement={};}]){
  const f=fixture();f.event('compositionstart');assert.equal(f.safe(),false);finish(f);assert.equal(f.safe(),true);
 }
});

test('composition outside the composer cannot block the Codex refresh hook',()=>{
 const f=fixture();f.event('compositionstart',{target:{closest:()=>null}});assert.equal(f.safe(),true);
 f.event('compositionstart');f.event('compositionend',{target:{closest:()=>null}});assert.equal(f.safe(),false,'unrelated end cannot release the active composer');
});
