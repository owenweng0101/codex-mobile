import test from 'node:test';
import assert from 'node:assert/strict';
import {hubReloadSafe} from '../backend/lib/hub-reload-safety.mjs';
const visible={getClientRects:()=>[{}]};
function frame({inputs=[],dialogs=[],activity=[],safe}={}){
  const doc={body:{},querySelectorAll(selector){if(selector.startsWith('[role='))return dialogs;if(selector.startsWith('textarea'))return inputs;return activity;}};
  return {getAttribute:()=>'/app',contentDocument:doc,contentWindow:{...(safe?{__claudeMobileReloadSafe:safe}:{})}};
}
test('empty known child pages allow shell refresh',()=>{assert.equal(hubReloadSafe([frame(),frame()]),true);});
test('Claude draft guard still blocks background or parent-focus refresh',()=>{assert.equal(hubReloadSafe([frame({safe:()=>false})]),false);});
test('text, rich text and file selections block parent refresh',()=>{
 for(const input of [{type:'text',value:'unsent'},{value:'goal draft'},{isContentEditable:true,textContent:'draft'},{type:'file',files:[{}]}])assert.equal(hubReloadSafe([frame({inputs:[input]})]),false);
});
test('open dialogs, pending upload previews and active work block refresh',()=>{
 assert.equal(hubReloadSafe([frame({dialogs:[visible]})]),false);
 assert.equal(hubReloadSafe([frame({activity:[visible]})]),false);
});
test('Codex and DSH in-memory state guards block automatic refresh even in hidden frames',()=>{
  for(const name of ['__codexMobileReloadSafe','__dshMobileReloadSafe']){
    const f=frame();f.getClientRects=()=>[];f.contentWindow[name]=()=>false;
    assert.equal(hubReloadSafe([f]),false);
    f.contentWindow[name]=()=>true;assert.equal(hubReloadSafe([f]),true);
    f.contentWindow[name]=()=>{throw Error('unavailable');};assert.equal(hubReloadSafe([f]),false);
  }
});
test('unreadable loaded children are not assumed safe',()=>{
 assert.equal(hubReloadSafe([{getAttribute:()=>'/app',contentDocument:null,contentWindow:{}}]),false);
 assert.equal(hubReloadSafe([{getAttribute:()=>null}]),true);
});
