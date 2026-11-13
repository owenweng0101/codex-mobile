import test from 'node:test';
import {pinnedTest} from './pinned-fixture.mjs';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {singlePreviewPane, patchSinglePreviewPane} from '../backend/preview-single-pane.mjs';

test('saved split merges every file into one pane and retains the focused file without mutating input', () => {
  const source = {minted:8, history:{past:['split']}, layout:{
    rootId:'split5', activePaneId:'pane2', floats:['float8'], expanded:true, mode:'push',
    tabs:{tab3:{id:'tab3'},tab4:{id:'tab4'},tab7:{id:'tab7'}},
    nodes:{split5:{kind:'split',children:['pane1','pane2'],sizes:[.5,.5]},
      pane1:{kind:'pane',id:'pane1',host:'dock',tabs:['tab3'],activeTabId:'tab3'},
      pane2:{kind:'pane',id:'pane2',host:'dock',tabs:['tab4'],activeTabId:'tab4'},
      float8:{kind:'pane',id:'float8',host:'float',tabs:['tab7'],activeTabId:'tab7',rect:{x:0,y:0,width:100,height:100}}}}};
  const before=JSON.stringify(source), empty={past:[],future:[]};
  const result=singlePreviewPane(source,empty);
  assert.equal(JSON.stringify(source),before);
  assert.deepEqual(Object.keys(result.layout.nodes),['pane2']);
  assert.deepEqual(result.layout.nodes.pane2.tabs,['tab3','tab4','tab7']);
  assert.equal(result.layout.nodes.pane2.activeTabId,'tab4');
  assert.equal(result.layout.tabs,source.layout.tabs);
  assert.equal(result.history,empty);
  assert.equal(singlePreviewPane(result,empty),result);
});

pinnedTest('pinned sidebar patch covers restore, all layout actions and split controls; unknown builds fail closed', async () => {
  const source=await readFile(new URL('../frontend/bundles/b0095146b28d6203ef4d31d75ba87a331f5c1e853976d49015bfff8762a4cf30.js',import.meta.url),'utf8');
  const patched=patchSinglePreviewPane(source);
  new Function(patched);
  assert.match(patched,/layout: dshmSinglePreview\(parsed\).layout/);
  assert.match(patched,/const updated = dshmSinglePreview\(next/);
  assert.throws(()=>patchSinglePreviewPane('changed build'),/review single-pane/);
});
